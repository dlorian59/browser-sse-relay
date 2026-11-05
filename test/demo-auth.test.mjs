import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createDemoDpopAuth } from '../demo/dpop-auth.mjs';
import { startDemo } from '../demo/server.mjs';
import { until } from './helpers.mjs';

const hash = value => createHash('sha256').update(value).digest('base64url');
function keys() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const jkt = hash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
  return { ...pair, jwk, jkt };
}
function proof(pair, token, { url = 'https://relay.example/events', method = 'GET', now = Date.now(), nonce,
  claims = {}, header = {} } = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const target = new URL(url);
  const payload = encode({ jti: randomUUID(), iat: Math.floor(now / 1000), htm: method,
    htu: `${target.origin}${target.pathname}`, ath: hash(token), nonce, ...claims });
  const input = `${encode({ alg: 'ES256', typ: 'dpop+jwt', jwk: pair.jwk, ...header })}.${payload}`;
  return `${input}.${sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const rejected = (promise, code, status = 401) => assert.rejects(promise, error => error.code === code && error.status === status);
async function fixture(options) {
  const auth = createDemoDpopAuth(options);
  const pair = keys();
  const session = auth.issueSession({ accountId: 'a', jkt: pair.jkt });
  const request = (overrides = {}) => ({ authorization: `DPoP ${session.accessToken}`, method: 'GET',
    url: 'https://relay.example/events?ignored=1', ...overrides });
  const signProof = overrides => proof(pair, session.accessToken, overrides);
  let nonce;
  await assert.rejects(auth.verify(request({ proof: signProof({ now: options?.clock?.() }) })), error => {
    nonce = error.nonce;
    return error.status === 401 && error.code === 'use_dpop_nonce' && typeof nonce === 'string';
  });
  return { auth, pair, session, request, nonce, signProof };
}

test('synthetic DPoP session checks signature, token binding, nonce and a unique proof per request', async () => {
  const f = await fixture();
  assert.equal(f.session.tokenType, 'DPoP');
  const signed = f.signProof({ nonce: f.nonce });
  assert.deepEqual(await f.auth.verify(f.request({ proof: signed })), { accountId: 'a', expiresAt: f.session.expiresAt });
  await rejected(f.auth.verify(f.request({ proof: signed })), 'invalid_dpop_proof');
  await rejected(f.auth.verify(f.request({ proof: f.signProof({ nonce: 'incorrect' }) })), 'use_dpop_nonce');
  await rejected(f.auth.verify(f.request({ authorization: `Bearer ${f.session.accessToken}`, proof: signed })), 'invalid_token');
  await rejected(f.auth.verify(f.request({ proof: proof(keys(), f.session.accessToken, { nonce: f.nonce }) })), 'invalid_dpop_proof');
  const otherToken = f.auth.issueSession({ accountId: 'b', jkt: f.pair.jkt });
  await rejected(f.auth.verify(f.request({ authorization: `DPoP ${otherToken.accessToken}`,
    proof: f.signProof({ nonce: f.nonce }) })), 'invalid_dpop_proof');
});

test('proof target, method, timestamp, header and access-token hash are verified', async () => {
  const f = await fixture();
  const now = Date.now();
  const cases = [
    { url: 'https://other.example/events' }, { url: 'https://relay.example/other' }, { method: 'POST' },
    { now: now - 62000 }, { now: now + 10000 }, { claims: { ath: hash('wrong token') } },
    { claims: { htu: 'https://relay.example/events?ignored=1' } }, { claims: { jti: '' } },
    { header: { alg: 'HS256' } }, { header: { typ: 'JWT' } },
    { header: { jwk: f.pair.privateKey.export({ format: 'jwk' }) } }, { header: { crit: ['unknown'] } },
  ];
  for (const changed of cases) {
    await rejected(f.auth.verify(f.request({ proof: f.signProof({ nonce: f.nonce, ...changed }) })), 'invalid_dpop_proof');
  }
  const signed = f.signProof({ nonce: f.nonce });
  const parts = signed.split('.');
  const sig = Buffer.from(parts[2], 'base64url'); sig[0] ^= 1; parts[2] = sig.toString('base64url');
  await rejected(f.auth.verify(f.request({ proof: parts.join('.') })), 'invalid_dpop_proof');
  assert.equal((await f.auth.verify(f.request({ proof: signed }))).accountId, 'a');
});

test('bounded replay store fails closed without evicting live entries, and concurrent reuse has one winner', async () => {
  let now = 100000;
  const f = await fixture({ maxReplayEntries: 1, clock: () => now });
  const signed = f.signProof({ nonce: f.nonce, now });
  const results = await Promise.allSettled([f.auth.verify(f.request({ proof: signed })), f.auth.verify(f.request({ proof: signed }))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await rejected(f.auth.verify(f.request({ proof: f.signProof({ nonce: f.nonce, now }) })), 'replay_capacity', 503);
  await rejected(f.auth.verify(f.request({ proof: signed })), 'invalid_dpop_proof');
  now += 61000;
  assert.equal((await f.auth.verify(f.request({ proof: f.signProof({ nonce: f.nonce, now }) }))).accountId, 'a');
});

test('session bounds preserve existing tokens and expired sessions cannot authenticate', async () => {
  let now = 100000;
  const f = await fixture({ maxSessions: 1, tokenTtlMs: 1000, clock: () => now });
  assert.throws(() => f.auth.issueSession({ accountId: 'b', jkt: f.pair.jkt }), error => error.status === 503);
  assert.equal((await f.auth.verify(f.request({ proof: f.signProof({ nonce: f.nonce, now }) }))).accountId, 'a');
  now += 1000;
  await rejected(f.auth.verify(f.request({ proof: f.signProof({ nonce: f.nonce, now }) })), 'invalid_token');
  assert.equal(f.auth.issueSession({ accountId: 'b', jkt: f.pair.jkt }).tokenType, 'DPoP');
});

test('real demo denies bearer/actions without proof, challenges with CORS nonce, streams and closes at token expiry', async () => {
  const demo = await startDemo({ tokenTtlMs: 500 });
  const pair = keys();
  try {
    const config = await fetch(`${demo.url}/api/config`).then(response => response.json());
    assert.equal(config.token, undefined);
    assert.equal((await fetch(`${demo.url}/api/publish`, { method: 'POST' })).status, 401);
    const session = await fetch(`${demo.url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: config.scope.accountId, jkt: pair.jkt }) }).then(response => response.json());
    const url = config.relayUrls[0];
    assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${session.accessToken}` } })).status, 401);
    const headers = { Authorization: `DPoP ${session.accessToken}`, Origin: demo.url,
      DPoP: proof(pair, session.accessToken, { url }) };
    const challenge = await fetch(url, { headers });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get('WWW-Authenticate'), /DPoP error="use_dpop_nonce"/u);
    assert.match(challenge.headers.get('Access-Control-Expose-Headers'), /DPoP-Nonce/u);
    headers.DPoP = proof(pair, session.accessToken, { url, nonce: challenge.headers.get('DPoP-Nonce') });
    const live = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    assert.equal(live.status, 200);
    const reader = live.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /relay-hello/u);
    await assert.rejects(async () => { while (!(await reader.read()).done) {} });
    await until(() => demo.store.stats().subscribers === 0);
  } finally { await demo.close(); }
});
