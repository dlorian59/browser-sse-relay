import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createDemoDpopAuth } from './dpop-auth.mjs';
import { MemoryEventStore, createNodeRelay } from '../dist/server/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const scope = Object.freeze({ accountId: 'demo-account', streamId: 'counter' });

// Two real HTTP listeners share one in-process retained store; a third listener serves demo controls.
// Два HTTP relay используют общий журнал в одном процессе; третий listener обслуживает управление демо.
export async function startDemo({ port = 0, tokenTtlMs = 300000 } = {}) {
  const auth = createDemoDpopAuth({ tokenTtlMs });
  const identities = new WeakMap();
  const store = new MemoryEventStore({ maxEventsPerStream: 8, retentionMs: 300000 });
  let counter = 0;
  let uiOrigin = '';
  const attempts = [];
  const relayServers = ['a', 'b'].map(label => {
    const relay = createNodeRelay({ store, authenticate: request => identities.get(request)?.accountId,
      stream: () => scope.streamId, heartbeatMs: 1000 });
    const listener = createServer(async (request, response) => {
      const origin = request.headers.origin;
      if (origin && origin !== uiOrigin) { response.writeHead(403); response.end(); return; }
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', uiOrigin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Expose-Headers', 'X-Relay-Protocol, DPoP-Nonce, WWW-Authenticate');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Authorization, DPoP, Last-Event-ID, Accept' });
        response.end(); return;
      }
      const originUrl = `http://127.0.0.1:${listener.address().port}`;
      let url;
      try { url = new URL(request.url, originUrl); }
      catch { response.writeHead(400); response.end(); return; }
      if (url.origin !== originUrl || url.pathname !== '/events') {
        response.writeHead(404); response.end(); return;
      }
      let identity;
      try {
        identity = await auth.verify({ authorization: request.headers.authorization,
          proof: request.headers.dpop, method: request.method, url: url.href });
      } catch (error) { auth.writeError(response, error); return; }
      identities.set(request, identity);
      // End active SSE when its token expires; this is not instant revocation.
      // Закрываем SSE по истечении токена; мгновенный отзыв здесь не реализован.
      const expiry = setTimeout(() => response.destroy(), Math.max(0, identity.expiresAt - Date.now()));
      expiry.unref();
      response.once('close', () => clearTimeout(expiry));
      attempts.push({ relay: label, cursor: request.headers['last-event-id'] ?? null });
      if (attempts.length > 100) attempts.shift();
      await relay(request, response);
    });
    return listener;
  });
  for (const server of relayServers) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  const relayUrls = relayServers.map(server => `http://127.0.0.1:${server.address().port}/events`);
  const json = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, uiOrigin);
      if (url.origin !== uiOrigin) { json(response, { error: 'invalid origin' }, 400); return; }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        json(response, { scope, relayUrls }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (request.headers.origin && request.headers.origin !== uiOrigin) {
          json(response, { error: 'forbidden origin' }, 403); return;
        }
        if (request.method === 'POST' && url.pathname === '/api/login') {
          // Freely selecting this fixed demo account is a fixture, not identity verification.
          // Свободный выбор фиксированного демо-аккаунта — fixture, а не проверка личности.
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 2048) { json(response, { error: 'body too large' }, 413); return; }
          }
          let login;
          try { login = JSON.parse(body); } catch { json(response, { error: 'invalid JSON' }, 400); return; }
          if (!login || login.accountId !== scope.accountId) { json(response, { error: 'unknown demo account' }, 400); return; }
          try { json(response, auth.issueSession(login)); }
          catch (error) {
            if (error instanceof TypeError) json(response, { error: 'invalid login' }, 400);
            else auth.writeError(response, error);
          }
          return;
        }
        try {
          const identity = await auth.verify({ authorization: request.headers.authorization,
            proof: request.headers.dpop, method: request.method, url: url.href });
          if (identity.accountId !== scope.accountId) { json(response, { error: 'wrong account' }, 403); return; }
        } catch (error) { auth.writeError(response, error); return; }
      }
      if (url.pathname === '/api/snapshot') {
        // Application state and log cursor are read synchronously with no await between them.
        // Состояние приложения и курсор читаются синхронно, без await между ними.
        json(response, { value: counter, cursor: store.currentCursor(scope), scope }); return;
      }
      if (url.pathname === '/api/stats') { json(response, { counter, attempts, store: store.stats() }); return; }
      if (request.method === 'POST' && ['/api/publish', '/api/drop'].includes(url.pathname)) {
        if (request.headers.origin && request.headers.origin !== uiOrigin) { json(response, { error: 'forbidden origin' }, 403); return; }
        if (url.pathname === '/api/drop') {
          for (const relay of relayServers) relay.closeAllConnections();
          json(response, { disconnected: true }); return;
        }
        const count = Number(url.searchParams.get('count') ?? 1);
        if (!Number.isInteger(count) || count < 1 || count > 64) { json(response, { error: 'count must be 1..64' }, 400); return; }
        // Commit the event and application state in one synchronous section in this reference demo.
        // В reference-демо событие и состояние приложения изменяются в одном синхронном участке.
        for (let i = 0; i < count; i++) {
          const value = counter + 1;
          store.append(scope, JSON.stringify({ value }), 'counter');
          counter = value;
        }
        json(response, { value: counter }); return;
      }
      let file;
      if (url.pathname === '/') file = 'demo/index.html';
      else if (url.pathname === '/demo.js') file = 'demo/demo.js';
      else if (/^\/lib\/[a-z-]+\.js$/u.test(url.pathname)) file = `dist/${url.pathname.slice(5)}`;
      else if (/^\/vendor\/[a-z.-]+\.js$/u.test(url.pathname)) file = `node_modules/eventsource-parser/dist/${url.pathname.slice(8)}`;
      if (!file) { response.writeHead(404); response.end(); return; }
      const body = await readFile(resolve(root, file));
      response.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch (error) { if (!response.headersSent) json(response, { error: String(error) }, 500); else response.destroy(); }
  });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  uiOrigin = `http://127.0.0.1:${server.address().port}`;
  return { url: uiOrigin, store, relayUrls, async close() {
    store.disconnect();
    for (const listener of [...relayServers, server]) { listener.closeAllConnections(); await new Promise(done => listener.close(done)); }
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const demo = await startDemo({ port: Number(process.env.PORT ?? 4178) });
  console.log(`SSE recovery demo: ${demo.url}`);
  console.log('Loopback-only demonstration. Synthetic DPoP sessions are demo-only, not OAuth. History is process-local.');
  const stop = async () => { await demo.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
