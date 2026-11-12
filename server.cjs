'use strict';
// JEV playground helper.
// Serves index.html and forwards health and decision requests to a decision
// service that you run separately. No dependencies beyond Node.js.
//
// Configuration (environment variables):
//   JEV_UPSTREAM       required  Base URL of the decision service.
//   JEV_BIND           optional  Address to listen on. Default 127.0.0.1.
//   JEV_PORT           optional  Port to listen on. Default 9999.
//   JEV_ALLOWED_HOSTS  optional  Extra Host header values to accept,
//                                comma-separated, each as host:port.
//   JEV_BACKEND        optional  Kind of decision service: "jev" (default,
//                                the /health and /v1/systemone contract in
//                                the README) or "ollaya".
//   JEV_MODEL          required with JEV_BACKEND=ollaya, unused otherwise.
//                                A model installed on the Ollaya service. It
//                                answers every decision.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error(`jev-playground: ${message}`);
  process.exit(1);
}

const bind = process.env.JEV_BIND || '127.0.0.1';
const port = Number(process.env.JEV_PORT || 9999);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail('JEV_PORT must be a TCP port number between 1 and 65535.');
}

if (!process.env.JEV_UPSTREAM) {
  fail('JEV_UPSTREAM is not set. Set it to the base URL of your decision service, for example JEV_UPSTREAM=http://127.0.0.1:8081');
}
let upstream;
try {
  const parsed = new URL(process.env.JEV_UPSTREAM);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
  if (parsed.search || parsed.hash) throw new Error('query strings and fragments are not supported');
  upstream = parsed.href.replace(/\/+$/, '');
} catch (e) {
  fail(`JEV_UPSTREAM must be an http(s) base URL (${e.message}).`);
}

const backend = process.env.JEV_BACKEND || 'jev';
if (backend !== 'jev' && backend !== 'ollaya') {
  fail(`JEV_BACKEND must be "jev" or "ollaya", not "${backend}".`);
}
const model = process.env.JEV_MODEL || '';
if (backend === 'ollaya' && !model) {
  fail('JEV_MODEL is not set. With JEV_BACKEND=ollaya, set it to a model installed on the Ollaya service, for example JEV_MODEL=winnow:e4b');
}

// Requests are accepted only when the Host header names this server. That
// stops another website from reaching the helper through DNS rebinding.
const hostLabel = bind.includes(':') ? `[${bind}]` : bind;
const wildcard = bind === '0.0.0.0' || bind === '::';
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
if (!wildcard) allowedHosts.add(`${hostLabel}:${port}`);
for (const extra of (process.env.JEV_ALLOWED_HOSTS || '').split(',')) {
  if (extra.trim()) allowedHosts.add(extra.trim());
}

const HEALTH_PATHS = new Set(['/api/health', '/health', '/v1/version']);
const DECISION_PATHS = new Set(['/api/decide', '/v1/systemone']);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const offline = {
  ready: false,
  error: {
    code: 'jev_offline',
    message: 'The decision service is offline or unreachable. The playground and your edits remain available. Start the decision service, then check the connection or retry.',
  },
};
const JSON_HEADERS = { 'Content-Type': 'application/json' };
// The route that shows the service is up. Ollaya has no /health route.
const LIVENESS_PATH = backend === 'ollaya' ? '/' : '/health';

// Health for an Ollaya service: it is ready when it answers and has the
// configured model. Returns the status and body to send to the page.
async function ollayaHealth() {
  const ask = async (route, init) => {
    const response = await fetch(upstream + route, { ...init, signal: AbortSignal.timeout(3000) });
    return { ok: response.ok, status: response.status, data: (await response.json().catch(() => null)) || {} };
  };
  const [version, shown] = await Promise.all([
    ask('/api/version'),
    ask('/api/show', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model }) }),
  ]);
  const notReady = (code, message) => [503, { ready: false, error: { code, message } }];
  if (shown.data.code === 'MODEL_NOT_FOUND') {
    return notReady('model_not_found', `The Ollaya service does not have the model "${model}". Pull it there, or set JEV_MODEL to a model it has.`);
  }
  const refused = [version, shown].find((answer) => !answer.ok);
  if (refused) {
    return notReady('ollaya_refused', `The Ollaya service answered HTTP ${refused.status} to the helper's check.`);
  }
  return [200, { ready: true, contract: `ollaya ${version.data.version}`, model }];
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  if (!allowedHosts.has(req.headers.host)) return send(403, { error: { message: 'Invalid host' } });
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
    return send(403, { error: { message: 'Cross-origin requests are not enabled' } });
  }
  if (req.method === 'GET' && req.url === '/') {
    return send(200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8');
  }
  if (req.method === 'GET' && req.url === '/healthz') return send(200, { ready: true, service: 'jev-playground' });

  const health = req.method === 'GET' && HEALTH_PATHS.has(req.url);
  const decision = req.method === 'POST' && DECISION_PATHS.has(req.url);
  if (!health && !decision) return send(404, { error: { message: 'Use GET /health or POST /v1/systemone' } });

  try {
    if (decision) {
      const check = await fetch(upstream + LIVENESS_PATH, { signal: AbortSignal.timeout(3000) });
      if (!check.ok) return send(503, offline);
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return send(413, { error: { message: 'Payload exceeds 2 MiB' } });
    }
    if (backend === 'ollaya') {
      if (health) return send(...(await ollayaHealth()));
      // Ollaya answers only for a model it has, so the configured model
      // replaces whatever name the request carries.
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch (e) {
        // Refused below.
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        return send(400, { error: { message: 'The request body must be a JSON object.' } });
      }
      payload.model = model;
      body = JSON.stringify(payload);
    }
    const response = await fetch(upstream + (health ? '/health' : '/v1/systemone'), {
      method: req.method,
      headers: JSON_HEADERS,
      body: decision ? body : undefined,
      signal: AbortSignal.timeout(health ? 3000 : 120000),
    });
    send(response.status, await response.text());
  } catch (e) {
    send(503, offline);
  }
});

server.on('error', (e) => fail(`cannot listen on ${hostLabel}:${port}: ${e.message}`));
server.listen(port, bind, () => {
  const service = backend === 'ollaya' ? `Ollaya at ${upstream}, model ${model}` : upstream;
  console.log(`JEV playground: http://${wildcard ? 'localhost' : hostLabel}:${port}/  (decision service: ${service})`);
  console.log(`Accepted Host headers: ${[...allowedHosts].join(', ')}`);
  if (bind !== '127.0.0.1' && bind !== '::1' && bind !== 'localhost') {
    console.log('Warning: there is no authentication. Anyone who can reach this address can submit model requests.');
  }
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
