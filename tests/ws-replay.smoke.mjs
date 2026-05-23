// Verify scrollback replay: produce output, disconnect, reconnect with since=0, get a full dump.
// Usage: node tests/ws-replay.smoke.mjs http://127.0.0.1:7865 [password]
import WebSocket from '../node_modules/ws/wrapper.mjs';

const baseUrl = process.argv[2] || 'http://127.0.0.1:7865';
const password = process.argv[3] || 'test-password-123';
const apiBase = baseUrl;
const wsBase = apiBase.replace(/^http/, 'ws');

const loginRes = await fetch(`${apiBase}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});
const sid = (loginRes.headers.get('set-cookie') ?? '').match(/omas_sid=([^;]+)/)?.[1];
if (!sid) { console.error('FAIL: login'); process.exit(1); }
const cookieHeader = `omas_sid=${sid}`;

const created = await fetch(`${apiBase}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader },
  body: JSON.stringify({ cols: 80, rows: 24 }),
}).then((r) => r.json());

async function attach(since) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/api/sessions/${created.id}/attach?since=${since}`, {
      headers: { cookie: cookieHeader },
    });
    ws.binaryType = 'arraybuffer';
    let helloSeq = null;
    let truncated = null;
    const parts = [];
    let t;
    ws.on('open', () => {
      t = setTimeout(() => {
        ws.close();
        resolve({ helloSeq, truncated, bytes: Buffer.concat(parts).toString() });
      }, 700);
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        parts.push(Buffer.from(data));
      } else {
        const m = JSON.parse(data.toString());
        if (m.type === 'hello') { helloSeq = m.seq; truncated = m.truncated; }
      }
    });
    ws.on('error', reject);
  });
}

const ws1 = new WebSocket(`${wsBase}/api/sessions/${created.id}/attach?since=0`, { headers: { cookie: cookieHeader } });
ws1.binaryType = 'arraybuffer';
await new Promise((r) => ws1.once('open', r));
ws1.send(JSON.stringify({ type: 'input', data: 'PS1= ; export PS1\n' }));
ws1.send(JSON.stringify({ type: 'input', data: 'echo BLOCK-A\n' }));
ws1.send(JSON.stringify({ type: 'input', data: 'echo BLOCK-B\n' }));
await new Promise((r) => setTimeout(r, 600));
ws1.close();
await new Promise((r) => setTimeout(r, 100));

const replay = await attach(0);
console.log('[REPLAY since=0]', { helloSeq: replay.helloSeq, truncated: replay.truncated, hasA: replay.bytes.includes('BLOCK-A'), hasB: replay.bytes.includes('BLOCK-B') });

const tail = await attach(replay.helloSeq);
console.log('[REPLAY since=current]', { helloSeq: tail.helloSeq, truncated: tail.truncated, byteCount: tail.bytes.length });

await fetch(`${apiBase}/api/sessions/${created.id}`, { method: 'DELETE', headers: { cookie: cookieHeader } });

if (!replay.bytes.includes('BLOCK-A')) { console.error('FAIL: BLOCK-A not in replay'); process.exit(1); }
if (!replay.bytes.includes('BLOCK-B')) { console.error('FAIL: BLOCK-B not in replay'); process.exit(1); }
if (replay.truncated) { console.error('FAIL: should not be truncated (well under 512KB)'); process.exit(1); }
console.log('OK');
