// Spin up a tiny HTTP+WS reverse proxy at /foo/* → 127.0.0.1:7866/*,
// then exercise the SPA, REST and WS through the prefix to prove
// base-path independence.
//
// Run after the server is up:
//   node tests/proxy-prefix.smoke.mjs
import http from 'node:http';
import net from 'node:net';

const BACKEND = { host: '127.0.0.1', port: 7866 };
const PROXY_PORT = 7900;
const PREFIX = '/foo';

const proxy = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (!url.startsWith(PREFIX + '/') && url !== PREFIX) {
    res.statusCode = 404;
    res.end('not under prefix');
    return;
  }
  const stripped = url.slice(PREFIX.length) || '/';
  const opts = {
    host: BACKEND.host,
    port: BACKEND.port,
    method: req.method,
    path: stripped,
    headers: req.headers,
  };
  const up = http.request(opts, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on('error', (e) => { res.statusCode = 502; res.end(String(e)); });
  req.pipe(up);
});

proxy.on('upgrade', (req, sock, head) => {
  const url = req.url ?? '/';
  if (!url.startsWith(PREFIX + '/')) {
    sock.write('HTTP/1.1 404\r\n\r\n');
    sock.destroy();
    return;
  }
  const stripped = url.slice(PREFIX.length);
  const upstream = net.connect(BACKEND.port, BACKEND.host, () => {
    let rawHeaders = `${req.method} ${stripped} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(req.headers)) {
      rawHeaders += `${k}: ${v}\r\n`;
    }
    rawHeaders += '\r\n';
    upstream.write(rawHeaders);
    if (head && head.length) upstream.write(head);
    upstream.pipe(sock);
    sock.pipe(upstream);
  });
  upstream.on('error', () => { try { sock.destroy(); } catch { /* */ } });
  sock.on('error', () => { try { upstream.destroy(); } catch { /* */ } });
});

proxy.listen(PROXY_PORT, '127.0.0.1', async () => {
  console.log(`[proxy up] http://127.0.0.1:${PROXY_PORT}${PREFIX}/`);
  try {
    // 1. SPA serves
    const idxRes = await fetch(`http://127.0.0.1:${PROXY_PORT}${PREFIX}/`);
    const idx = await idxRes.text();
    console.log('[SPA]', idxRes.status, 'has-app-div:', idx.includes('<div id="app">'), 'asset-rel:', idx.includes('./assets/'));

    // 2. Asset reachable via proxy
    const assetUrl = `${PREFIX}/` + (idx.match(/src="\.\/(assets\/[^"]+\.js)"/)?.[1] ?? '');
    const assetRes = await fetch(`http://127.0.0.1:${PROXY_PORT}${assetUrl}`);
    console.log('[ASSET]', assetRes.status, assetUrl);

    // 3. /api/auth/me (should 200, loggedIn:false)
    const meRes = await fetch(`http://127.0.0.1:${PROXY_PORT}${PREFIX}/api/auth/me`);
    console.log('[ME]', meRes.status, await meRes.text());

    // 4. Login + cookie + session + WS through the proxy
    const loginRes = await fetch(`http://127.0.0.1:${PROXY_PORT}${PREFIX}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: process.env.OMAS_TEST_PASSWORD || 'test-password-123' }),
    });
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const sid = setCookie.match(/omas_sid=([^;]+)/)?.[1];
    console.log('[LOGIN]', loginRes.status, 'sid?', !!sid);

    const createRes = await fetch(`http://127.0.0.1:${PROXY_PORT}${PREFIX}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `omas_sid=${sid}` },
      body: JSON.stringify({ cols: 80, rows: 24, title: 'proxy-test' }),
    });
    const created = await createRes.json();
    console.log('[CREATE]', createRes.status, created.id);

    const WS = (await import('../node_modules/ws/wrapper.mjs')).default;
    await new Promise((resolve, reject) => {
      const ws = new WS(`ws://127.0.0.1:${PROXY_PORT}${PREFIX}/api/sessions/${created.id}/attach?since=0`, {
        headers: { cookie: `omas_sid=${sid}` },
      });
      const to = setTimeout(() => reject(new Error('ws timeout')), 4000);
      ws.on('open', () => console.log('[WS] open through proxy'));
      ws.on('message', (data, isBin) => {
        if (!isBin) {
          const m = JSON.parse(data.toString());
          console.log('[WS-HELLO]', m);
          if (m.type === 'hello') {
            clearTimeout(to);
            ws.close();
            resolve();
          }
        }
      });
      ws.on('error', (e) => { clearTimeout(to); reject(e); });
    });

    await fetch(`http://127.0.0.1:${PROXY_PORT}${PREFIX}/api/sessions/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: `omas_sid=${sid}` },
    });

    console.log('OK');
    process.exit(0);
  } catch (e) {
    console.error('FAIL', e);
    process.exit(1);
  }
});
