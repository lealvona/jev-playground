'use strict';
// Tests for the helper in server.cjs. Run them with:  node --test
//
// Every test starts the real helper as a child process and points it at a
// stand-in decision service on a loopback port. The stand-ins answer with the
// shapes the real services use. Nothing here needs a model or a network.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, 'server.cjs');

const PAGE_REQUEST = {
  model: 'openjev',
  state: 'Customer message: My card was charged twice for order 2841.',
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this customer request?',
      criteria: {
        billing: 'Payments, duplicate charges, invoices and refunds',
        shipping: 'Parcel delivery, tracking and missing shipments',
      },
    },
  },
};

// ---------------------------------------------------------------- stand-ins

// Starts an HTTP server on a free loopback port and records every request.
async function standIn(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body });
    handler(req, res, body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// A service that speaks the contract in the README: /health and /v1/systemone.
const JEV_HEALTH = { ready: true, contract: 'stand-in adapter', model: 'stand-in-model' };
const JEV_DECISION = { answers: { team: { probabilities: { billing: 0.97, shipping: 0.03 } } } };
function jevService({ healthStatus = 200 } = {}) {
  return standIn((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, healthStatus, healthStatus === 200 ? JEV_HEALTH : { ready: false });
    }
    if (req.method === 'POST' && req.url === '/v1/systemone') return sendJson(res, 200, JEV_DECISION);
    sendJson(res, 404, { error: { message: 'not found' } });
  });
}

// A service that answers the way Ollaya does: no /health route, errors as
// {"error": "<text>", "code": "<CODE>"}, and a 404 for a model it does not have.
const OLLAYA_SHOW = {
  license: 'Stand-in licence text',
  modelfile: 'FROM winnow:e4b',
  parameters: '',
  questions: null,
  router: null,
  details: { parent_model: '', format: 'gguf', family: 'winnow', families: ['winnow'], parameter_size: '7.5B', quantization_level: 'Q8_0' },
  model_info: { 'general.architecture': 'winnow' },
  capabilities: ['choice', 'score', 'noul'],
  modified_at: '2026-09-29T17:02:06.844054571Z',
};
const OLLAYA_DECISION = {
  model: 'winnow:e4b',
  answers: { team: { type: 'choice', choice: 'billing', confidence: 0.9953, probabilities: { billing: 0.9953, shipping: 0.0047 } } },
  usage: { input_tokens: 43, output_tokens: 0 },
};
const canonical = (name) => {
  const lower = String(name).toLowerCase();
  return lower.includes(':') ? lower : lower + ':latest';
};
function ollayaService({ installed = ['winnow:e4b'], requireKey = false } = {}) {
  return standIn((req, res, body) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Ollaya is running');
    }
    if (requireKey) return sendJson(res, 401, { error: 'stand-in: a key is required', code: 'UNAUTHORIZED' });
    if (req.method === 'GET' && req.url === '/api/version') return sendJson(res, 200, { version: '0.7.5' });
    if (req.method === 'POST' && (req.url === '/api/show' || req.url === '/v1/systemone')) {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { error: 'invalid JSON', code: 'INVALID_JSON' });
      }
      if (!installed.includes(canonical(payload.model))) {
        return sendJson(res, 404, { error: `model "${canonical(payload.model)}" not found, try pulling it first`, code: 'MODEL_NOT_FOUND' });
      }
      return sendJson(res, 200, req.url === '/api/show' ? OLLAYA_SHOW : OLLAYA_DECISION);
    }
    sendJson(res, 404, { error: `${req.url} not found`, code: 'NOT_FOUND' });
  });
}

// A service that accepts connections and never answers.
async function silentService() {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ------------------------------------------------------------------- helper

// Spawns server.cjs with only the JEV_* variables given here, then waits until
// it either answers its own /healthz route or exits.
async function spawnHelper(settings) {
  const port = await freePort();
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('JEV_')) env[key] = value;
  }
  Object.assign(env, { JEV_PORT: String(port) }, settings);
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let closed = false;
  let exitCode = null;
  const whenClosed = new Promise((resolve) => child.on('close', (code) => { closed = true; exitCode = code; resolve(); }));
  const base = `http://127.0.0.1:${port}`;
  let started = false;
  for (let attempt = 0; attempt < 100 && !closed && !started; attempt++) {
    try {
      started = (await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) })).ok;
    } catch (e) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return {
    base,
    started,
    exitCode: () => exitCode,
    stderr: () => stderr,
    stop: async () => { if (!closed) child.kill(); await whenClosed; },
  };
}

async function startHelper(t, settings) {
  const helper = await spawnHelper(settings);
  t.after(helper.stop);
  assert.equal(helper.started, true, `the helper did not start: ${helper.stderr()}`);
  return helper;
}

const getHealth = (helper) => fetch(helper.base + '/api/health', { signal: AbortSignal.timeout(20000) });
const decide = (helper, body) => fetch(helper.base + '/api/decide', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
  signal: AbortSignal.timeout(20000),
});
const decisionsReceived = (service) => service.requests.filter((r) => r.method === 'POST' && r.url === '/v1/systemone');

// ------------------------------------------------- default backend (README contract)

test('default backend: health is the answer of the service /health route', async (t) => {
  const service = await jevService();
  t.after(service.close);
  const helper = await startHelper(t, { JEV_UPSTREAM: service.base });

  const response = await getHealth(helper);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true, contract: 'stand-in adapter', model: 'stand-in-model' });
});

test('default backend: a decision reaches the service byte for byte', async (t) => {
  const service = await jevService();
  t.after(service.close);
  const helper = await startHelper(t, { JEV_UPSTREAM: service.base });
  const body = JSON.stringify(PAGE_REQUEST, null, 2);

  const response = await decide(helper, body);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answers: { team: { probabilities: { billing: 0.97, shipping: 0.03 } } } });
  assert.deepEqual(decisionsReceived(service).map((r) => r.body), [body]);
});

test('default backend: a decision is refused as offline when /health fails', async (t) => {
  const service = await jevService({ healthStatus: 503 });
  t.after(service.close);
  const helper = await startHelper(t, { JEV_UPSTREAM: service.base });

  const response = await decide(helper, JSON.stringify(PAGE_REQUEST));

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'jev_offline');
  assert.equal(decisionsReceived(service).length, 0);
});

// ------------------------------------------------------------ startup checks

test('refuses to start with an unknown JEV_BACKEND', async (t) => {
  const helper = await spawnHelper({ JEV_UPSTREAM: 'http://127.0.0.1:9', JEV_BACKEND: 'no-such-backend' });
  t.after(helper.stop);

  assert.equal(helper.started, false, 'the helper started with a backend it does not know');
  assert.equal(helper.exitCode(), 1);
  assert.match(helper.stderr(), /JEV_BACKEND/);
});

test('refuses to start with JEV_BACKEND=ollaya and no JEV_MODEL', async (t) => {
  const helper = await spawnHelper({ JEV_UPSTREAM: 'http://127.0.0.1:9', JEV_BACKEND: 'ollaya' });
  t.after(helper.stop);

  assert.equal(helper.started, false, 'the helper started without a model to ask for');
  assert.equal(helper.exitCode(), 1);
  assert.match(helper.stderr(), /JEV_MODEL/);
});

// ------------------------------------------------------------ ollaya backend

const OLLAYA = { JEV_BACKEND: 'ollaya', JEV_MODEL: 'winnow:e4b' };

test('ollaya backend: health reports ready with the service version and the configured model', async (t) => {
  const service = await ollayaService();
  t.after(service.close);
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: service.base });

  const response = await getHealth(helper);
  const health = await response.json();

  assert.equal(response.status, 200);
  assert.equal(health.ready, true);
  assert.equal(health.model, 'winnow:e4b');
  assert.ok(health.contract.includes('0.7.5'), `contract should carry the service version, got ${health.contract}`);
});

test('ollaya backend: health says so when the service does not have the model', async (t) => {
  const service = await ollayaService();
  t.after(service.close);
  const helper = await startHelper(t, { ...OLLAYA, JEV_MODEL: 'absent-model', JEV_UPSTREAM: service.base });

  const response = await getHealth(helper);
  const health = await response.json();

  assert.equal(response.status, 503);
  assert.equal(health.ready, false);
  assert.match(health.error.message, /absent-model/);
});

test('ollaya backend: health is not ready when the service refuses the helper', async (t) => {
  const service = await ollayaService({ requireKey: true });
  t.after(service.close);
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: service.base });

  const response = await getHealth(helper);
  const health = await response.json();

  assert.equal(response.status, 503);
  assert.equal(health.ready, false);
  assert.match(health.error.message, /401/);
});

test('ollaya backend: health reports offline when nothing listens at the address', async (t) => {
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: `http://127.0.0.1:${await freePort()}` });

  const response = await getHealth(helper);
  const health = await response.json();

  assert.equal(response.status, 503);
  assert.equal(health.ready, false);
  assert.equal(health.error.code, 'jev_offline');
});

test('ollaya backend: a decision is asked of the configured model, with everything else unchanged', async (t) => {
  const service = await ollayaService();
  t.after(service.close);
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: service.base });

  const response = await decide(helper, JSON.stringify({ ...PAGE_REQUEST, note: 'kept as sent' }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    model: 'winnow:e4b',
    answers: { team: { type: 'choice', choice: 'billing', confidence: 0.9953, probabilities: { billing: 0.9953, shipping: 0.0047 } } },
    usage: { input_tokens: 43, output_tokens: 0 },
  });
  assert.deepEqual(decisionsReceived(service).map((r) => JSON.parse(r.body)), [{
    model: 'winnow:e4b',
    state: 'Customer message: My card was charged twice for order 2841.',
    questions: PAGE_REQUEST.questions,
    note: 'kept as sent',
  }]);
});

test('ollaya backend: an error from the service reaches the caller with its status and body', async (t) => {
  // The service accepts the helper but no longer has the model.
  const service = await ollayaService({ installed: [] });
  t.after(service.close);
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: service.base });

  const response = await decide(helper, JSON.stringify(PAGE_REQUEST));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'model "winnow:e4b" not found, try pulling it first', code: 'MODEL_NOT_FOUND' });
});

test('ollaya backend: a body that is not a JSON object is refused and never forwarded', async (t) => {
  const service = await ollayaService();
  t.after(service.close);
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: service.base });

  for (const body of ['{not json', '[]', '"text"', 'null', '']) {
    const response = await decide(helper, body);
    const answer = await response.json();
    assert.equal(response.status, 400, `body ${JSON.stringify(body)}`);
    assert.equal(typeof answer.error.message, 'string', `body ${JSON.stringify(body)}`);
  }
  assert.equal(decisionsReceived(service).length, 0);
});

test('ollaya backend: a decision is refused as offline when nothing listens at the address', async (t) => {
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: `http://127.0.0.1:${await freePort()}` });

  const response = await decide(helper, JSON.stringify(PAGE_REQUEST));

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'jev_offline');
});

test('ollaya backend: a decision fails within seconds when the service accepts connections but never answers', async (t) => {
  const service = await silentService();
  t.after(service.close);
  const helper = await startHelper(t, { ...OLLAYA, JEV_UPSTREAM: service.base });
  const began = Date.now();

  // The decide() call itself gives up after 20 s, well before the 120 s the
  // helper allows a decision, so a missing liveness check fails this test.
  const response = await decide(helper, JSON.stringify(PAGE_REQUEST));

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'jev_offline');
  assert.ok(Date.now() - began < 10000, `took ${Date.now() - began} ms`);
});
