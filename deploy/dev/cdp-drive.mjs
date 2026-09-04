#!/usr/bin/env node
/**
 * cdp-drive.mjs — Minimal CDP driver over native WebSocket (Node >=22).
 * Usage: node cdp-drive.mjs <port> <script-file.mjs>
 * The script file exports async function run(cdp) where cdp has:
 *   send(method, params) -> Promise<result>
 *   evaluate(js) -> Promise<any>  (Runtime.evaluate in main frame, awaitPromise, returnByValue)
 *   screenshot(path) -> Promise<void>
 *   sleep(ms)
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [port, scriptPath] = process.argv.slice(2);
if (!port || !scriptPath) { console.error('usage: cdp-drive.mjs <port> <script.mjs>'); process.exit(2); }

// --- discover page target ---
const list = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
const page = list.find(t => t.type === 'page');
if (!page) { console.error('no page target found'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, (m) => m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result));
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const cdp = {
  send,
  async evaluate(js) {
    const r = await send('Runtime.evaluate', {
      expression: js, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  },
  async screenshot(path) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    console.log('  [shot]', path);
  },
  sleep: (ms) => new Promise(r => setTimeout(r, ms)),
};

await send('Page.enable');
await send('Runtime.enable');

// run user script
const mod = await import(pathToFileURL(scriptPath).href);
await mod.run(cdp);
ws.close();
console.log('cdp-drive done');
