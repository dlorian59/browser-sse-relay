import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createDpopKeyPair, getDpopThumbprint, createDpopProof, createDpopFetch } from '../dist/index.js';

const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const claims = proof => decode(proof.split('.')[1]);
const hash = value => createHash('sha256').update(value).digest('base64url');
const challenge = (nonce = 'nonce-1', auth = 'DPoP error="use_dpop_nonce"') =>
  new Response('challenge', { status: 401, headers: { 'WWW-Authenticate': auth, 'DPoP-Nonce': nonce } });

test('P-256 private key stays non-extractable; RFC 7638 thumbprint and ES256 proof verify independently', async () => {
  const keyPair = await createDpopKeyPair();
  assert.equal(keyPair.privateKey.extractable, false);
  assert.equal(keyPair.publicKey.extractable, true);
  await assert.rejects(crypto.subtle.exportKey('jwk', keyPair.privateKey));
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  assert.equal(await getDpopThumbprint(keyPair), hash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
  const before = Math.floor(Date.now() / 1000);
  const proof = await createDpopProof({ keyPair, url: 'https://EXAMPLE.test:443/events?a=1#fragment', method: 'get', accessToken: 'token-A', nonce: 'opaque!nonce' });
  const [encodedHeader, encodedPayload, signature] = proof.split('.');
  const header = decode(encodedHeader);
  const payload = decode(encodedPayload);
  assert.equal(header.typ, 'dpop+jwt'); assert.equal(header.alg, 'ES256');
  assert.deepEqual(Object.keys(header.jwk).sort(), ['crv', 'kty', 'x', 'y']);
  const imported = await crypto.subtle.importKey('jwk', header.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const verify = (data, publicKey = imported) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
    Buffer.from(signature, 'base64url'), new TextEncoder().encode(data));
  assert.equal(await verify(`${encodedHeader}.${encodedPayload}`), true);
  assert.equal(await verify(`${encodedHeader}.${encodedPayload}x`), false);
  assert.equal(await verify(`${encodedHeader}.${encodedPayload}`, (await createDpopKeyPair()).publicKey), false);
  assert.equal(payload.htm, 'GET'); assert.equal(payload.htu, 'https://example.test/events');
  assert.equal(payload.ath, hash('token-A')); assert.notEqual(payload.ath, hash('token-B'));
  assert.equal(payload.nonce, 'opaque!nonce');
  assert.ok(payload.iat >= before && payload.iat <= Math.floor(Date.now() / 1000));
  const second = claims(await createDpopProof({ keyPair, url: 'https://example.test/token', method: 'POST' }));
  assert.notEqual(second.jti, payload.jti); assert.equal(second.htm, 'POST');
  assert.equal('ath' in second, false); assert.equal('nonce' in second, false);
});

test('transport owns auth, redirect and cache headers; preserves SSE cursor and input Request settings', async () => {
  const keyPair = await createDpopKeyPair(); const requests = [];
  const transport = createDpopFetch({ keyPair, origin: 'https://example.test', getAccessToken: signal => {
    assert.ok(signal instanceof AbortSignal); return 'token-A';
  }, fetch: async (request, init) => { requests.push({ request, init }); return new Response('stream'); } });
  const input = new Request('https://example.test/events?feature=inbox', { headers: { Authorization: 'Bearer forbidden', DPoP: 'stale', 'Last-Event-ID': '12', Accept: 'text/event-stream' }, credentials: 'omit' });
  assert.equal(await (await transport(input, { redirect: 'follow', cache: 'force-cache' })).text(), 'stream');
  await transport('/events?feature=other');
  const [{ request, init }] = requests;
  assert.equal(request.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.get('Authorization'), 'DPoP token-A');
  assert.equal(init.headers.get('Last-Event-ID'), '12'); assert.equal(init.headers.get('Accept'), 'text/event-stream');
  assert.equal(claims(init.headers.get('DPoP')).htu, 'https://example.test/events');
  assert.notEqual(claims(init.headers.get('DPoP')).jti, claims(requests[1].init.headers.get('DPoP')).jti);
  assert.equal(input.headers.get('Authorization'), 'Bearer forbidden');
});

test('nonce challenge cancels its body and retries once with a fresh proof and current token', async () => {
  const keyPair = await createDpopKeyPair(); const proofs = []; let cancelled = false; let tokens = 0;
  const transport = createDpopFetch({ keyPair, origin: 'https://example.test', getAccessToken: () => `token-${++tokens}`,
    fetch: async (_request, init) => {
      proofs.push(claims(init.headers.get('DPoP')));
      if (proofs.length === 1) return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
        status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="old", DPoP realm="a,b", error="use_dpop_nonce"', 'DPoP-Nonce': 'nonce-1' },
      });
      assert.equal(cancelled, true);
      return new Response('ready', { headers: { 'DPoP-Nonce': 'nonce-2' } });
    } });
  assert.equal(await (await transport('/events')).text(), 'ready');
  await transport('/events');
  assert.equal(proofs.length, 3); assert.equal('nonce' in proofs[0], false);
  assert.equal(proofs[1].nonce, 'nonce-1'); assert.equal(proofs[2].nonce, 'nonce-2');
  assert.equal(new Set(proofs.map(value => value.jti)).size, 3);
  assert.equal(proofs[1].ath, hash('token-2'));
});

test('nonce retry budget is bounded and the final challenged response remains readable', async () => {
  const keyPair = await createDpopKeyPair(); let attempts = 0;
  const transport = createDpopFetch({ keyPair, origin: 'https://example.test', getAccessToken: () => 'token',
    fetch: async () => { attempts++; return challenge(`nonce-${attempts}`); } });
  const response = await transport('/events');
  assert.equal(attempts, 2); assert.equal(response.status, 401); assert.equal(await response.text(), 'challenge');
});

test('only a DPoP resource nonce challenge with a valid nonce permits the immediate retry', async () => {
  const keyPair = await createDpopKeyPair();
  const cases = [
    ['nonce', 'Bearer error="use_dpop_nonce"', 401],
    ['nonce', 'DPoP realm="example", Bearer error="use_dpop_nonce"', 401],
    ['nonce', 'DPoP error_description="error=use_dpop_nonce"', 401],
    ['nonce', 'DPoP error="invalid_dpop_proof"', 401],
    ['nonce', 'DPoP error="USE_DPOP_NONCE"', 401],
    ['nonce', 'DPoP error="use_dpop_nonce"', 400],
    ['bad nonce', 'DPoP error="use_dpop_nonce"', 401],
    ['bad"nonce', 'DPoP error="use_dpop_nonce"', 401],
    ['bad\\nonce', 'DPoP error="use_dpop_nonce"', 401],
    ['', 'DPoP error="use_dpop_nonce"', 401],
  ];
  for (const [nonce, auth, status] of cases) {
    let attempts = 0;
    const transport = createDpopFetch({ keyPair, origin: 'https://example.test', getAccessToken: () => 'token', fetch: async () => {
      attempts++; return new Response('denied', { status, headers: { 'WWW-Authenticate': auth, 'DPoP-Nonce': nonce } });
    } });
    await transport('/events'); assert.equal(attempts, 1, `${status}: ${auth} / ${nonce}`);
  }
});

test('nonce is retained from any response but is isolated between origin-scoped transports', async () => {
  const keyPair = await createDpopKeyPair(); const seen = [];
  const options = { keyPair, getAccessToken: () => 'token', fetch: async (request, init) => {
    seen.push(claims(init.headers.get('DPoP'))); return new Response('error', { status: 503, headers: { 'DPoP-Nonce': 'next-nonce' } });
  } };
  const first = createDpopFetch({ ...options, origin: 'https://one.test' });
  const second = createDpopFetch({ ...options, origin: 'https://two.test' });
  await first('/events'); await first('/events'); await second('/events');
  assert.equal(seen[1].nonce, 'next-nonce'); assert.equal('nonce' in seen[2], false);
});

test('foreign origins, credentials, insecure origins and non-GET requests fail before token access or network', async () => {
  const keyPair = await createDpopKeyPair(); let tokens = 0; let calls = 0;
  const options = { keyPair, getAccessToken: () => { tokens++; return 'token'; }, fetch: async () => { calls++; return new Response(); } };
  const transport = createDpopFetch({ ...options, origin: 'https://example.test' });
  for (const url of ['https://other.test/events', '//other.test/events', 'https://example.test:8443/events', 'http://example.test/events', 'https://user:pass@example.test/events']) {
    await assert.rejects(transport(url), TypeError);
  }
  await assert.rejects(transport('/events', { method: 'POST' }), TypeError);
  await assert.rejects(transport('/events', { body: 'body' }), TypeError);
  await assert.rejects(transport(new Request('https://example.test/events', { method: 'HEAD' })), TypeError);
  for (const origin of ['http://example.test', 'http://localhost.evil.test', 'https://example.test/path', 'https://example.test/?query', 'ftp://localhost']) {
    assert.throws(() => createDpopFetch({ ...options, origin }), TypeError);
  }
  assert.equal(tokens, 0); assert.equal(calls, 0);
  for (const origin of ['http://localhost:5180', 'http://127.0.0.1:5180', 'http://[::1]:5180']) {
    await createDpopFetch({ ...options, origin })('/events');
  }
  assert.equal(calls, 3);
});

test('abort before token acquisition and while awaiting token prevents network work', async () => {
  const keyPair = await createDpopKeyPair(); let tokens = 0; let calls = 0; let resolveToken;
  const transport = createDpopFetch({ keyPair, origin: 'https://example.test', getAccessToken: () => {
    tokens++; return new Promise(resolve => { resolveToken = resolve; });
  }, fetch: async () => { calls++; return new Response(); } });
  const first = new AbortController(); first.abort(new Error('already stopped'));
  await assert.rejects(transport('/events', { signal: first.signal }), /already stopped/);
  assert.equal(tokens, 0);
  const second = new AbortController(); const pending = transport('/events', { signal: second.signal });
  second.abort(new Error('stopped during token acquisition')); resolveToken('token');
  await assert.rejects(pending, /stopped during token acquisition/); assert.equal(calls, 0);
});

test('abort while signing prevents dispatch; abort while cancelling a challenge prevents retry', async t => {
  const keyPair = await createDpopKeyPair(); let calls = 0; const controller = new AbortController();
  const realSign = crypto.subtle.sign.bind(crypto.subtle);
  const signing = t.mock.method(crypto.subtle, 'sign', (...args) => {
    const promise = realSign(...args); controller.abort(new Error('stopped during proof')); return promise;
  });
  const options = { keyPair, origin: 'https://example.test', getAccessToken: () => 'token' };
  const transport = createDpopFetch({ ...options, fetch: async () => { calls++; return new Response(); } });
  await assert.rejects(transport('/events', { signal: controller.signal }), /stopped during proof/); assert.equal(calls, 0);
  signing.mock.restore();
  const retry = new AbortController();
  const challengeTransport = createDpopFetch({ ...options, fetch: async () => {
    calls++; return new Response(new ReadableStream({ cancel() { retry.abort(new Error('stopped before retry')); } }), {
      status: 401, headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'nonce' },
    });
  } });
  await assert.rejects(challengeTransport('/events', { signal: retry.signal }), /stopped before retry/); assert.equal(calls, 1);
});

test('invalid access tokens never dispatch and invalid proof inputs fail explicitly', async () => {
  const keyPair = await createDpopKeyPair(); let calls = 0;
  for (const token of ['', 'with whitespace', 'bad\nheader']) {
    const transport = createDpopFetch({ keyPair, origin: 'https://example.test', getAccessToken: () => token,
      fetch: async () => { calls++; return new Response(); } });
    await assert.rejects(transport('/events'), TypeError);
  }
  assert.equal(calls, 0);
  await assert.rejects(createDpopProof({ keyPair, url: 'https://example.test', method: 'bad method' }), TypeError);
  await assert.rejects(createDpopProof({ keyPair, url: 'https://example.test', method: 'GET', nonce: 'bad nonce' }), TypeError);
  const wrongCurve = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, false, ['sign', 'verify']);
  await assert.rejects(createDpopProof({ keyPair: wrongCurve, url: 'https://example.test', method: 'GET' }), TypeError);
});

test('native fetch refuses redirects instead of forwarding credentials to the redirect target', async t => {
  let redirected = 0; let authorized = 0;
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      if (request.headers.authorization === 'DPoP token') authorized++;
      response.writeHead(302, { Location: '/target' }); response.end();
    } else {
      redirected++; response.end('must not be reached');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const transport = createDpopFetch({ keyPair: await createDpopKeyPair(),
    origin: `http://127.0.0.1:${server.address().port}`, getAccessToken: () => 'token' });
  await assert.rejects(transport('/redirect'), TypeError);
  assert.equal(authorized, 1); assert.equal(redirected, 0);
});
