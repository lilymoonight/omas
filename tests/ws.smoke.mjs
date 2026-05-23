// Standalone WS smoke (not part of vitest). Run after the server is up.
//   node tests/ws.smoke.mjs http://127.0.0.1:7865 [password]
// Default password matches the dev config: test-password-123.
import WebSocket from '../node_modules/ws/wrapper.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:7865';
const password = process.argv[3] || 'test-password-123';
const apiBase = baseUrl.replace(/\/$/, '');
const wsBase = apiBase.replace(/^http/, 'ws');

const loginRes = await fetch(`${apiBase}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});
const setCookie = loginRes.headers.get('set-cookie') ?? '';
const sid = setCookie.match(/omas_sid=([^;]+)/)?.[1];
if (!sid) { console.error('FAIL: login did not return a session cookie', loginRes.status); process.exit(1); }
const cookieHeader = `omas_sid=${sid}`;

const created = await fetch(`${apiBase}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader },
  body: JSON.stringify({ cols: 80, rows: 24, title: 'ws-smoke' }),
}).then((r) => r.json());
console.log('[CREATE]', created.id);

const ws = new WebSocket(`${wsBase}/api/sessions/${created.id}/attach?since=0`, {
  headers: { cookie: cookieHeader },
});
ws.binaryType = 'arraybuffer';
const allBytes = [];
let helloSeen = false;

ws.on('open', () => console.log('[OPEN]'));
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    allBytes.push(Buffer.from(data));
    return;
  }
  const msg = JSON.parse(data.toString());
  console.log('[CTRL]', msg);
  if (msg.type === 'hello') {
    helloSeen = true;
    ws.send(JSON.stringify({ type: 'input', data: 'PS1= ; export PS1\n' }));
    ws.send(JSON.stringify({ type: 'input', data: 'echo websocket-marker-7f3b\n' }));
  } else if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
  }
});
ws.on('close', () => console.log('[CLOSE]'));
ws.on('error', (err) => console.log('[ERR]', err.message));

await new Promise((resolve) => setTimeout(resolve, 1500));
const allText = Buffer.concat(allBytes).toString();
console.log('[GOT-BYTES]', allBytes.reduce((a, b) => a + b.length, 0));
console.log('[CONTAINS-MARKER]', allText.includes('websocket-marker-7f3b'));

ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
await new Promise((r) => setTimeout(r, 200));
const meta = await fetch(`${apiBase}/api/sessions/${created.id}`, { headers: { cookie: cookieHeader } }).then((r) => r.json());
console.log('[AFTER-RESIZE]', { cols: meta.cols, rows: meta.rows });

ws.close();
await fetch(`${apiBase}/api/sessions/${created.id}`, { method: 'DELETE', headers: { cookie: cookieHeader } });
console.log('[CLEAN]');

if (!helloSeen) { console.error('FAIL: never received hello'); process.exit(1); }
if (!allText.includes('websocket-marker-7f3b')) { console.error('FAIL: marker missing'); process.exit(1); }
if (meta.cols !== 120 || meta.rows !== 40) { console.error('FAIL: resize did not stick'); process.exit(1); }
console.log('OK');
