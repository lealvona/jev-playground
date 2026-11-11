'use strict';
// Checks that the inline script in index.html parses and defines ten examples.
// With --run <playground-url> it also sends every example to a running
// playground and prints the answers, which needs a ready decision service.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
const demos = vm.runInNewContext(html.slice(html.indexOf('const choice='), html.indexOf('const sessions=')) + ';demos');
if (demos.length !== 10) throw Error('Expected ten examples');
console.log('Syntax valid; ten editable examples');

const runAt = process.argv.indexOf('--run');
if (runAt !== -1) {
  const base = process.argv[runAt + 1];
  if (!base) {
    console.error('Usage: node check-examples.cjs --run <playground-url>   e.g. --run http://127.0.0.1:9999');
    process.exit(1);
  }
  (async () => {
    for (const d of demos) {
      const r = await fetch(base.replace(/\/+$/, '') + '/api/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openjev', state: d.state, questions: d.questions }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await r.json();
      if (!r.ok || !data.answers) throw Error(d.title + ': ' + JSON.stringify(data));
      console.log(d.title, JSON.stringify(data.answers));
    }
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
