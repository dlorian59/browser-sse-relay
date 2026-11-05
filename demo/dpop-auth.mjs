import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';

// Demo-only synthetic sessions, not an OAuth server or a production token verifier.
// Синтетические сессии только для демо: это не OAuth-сервер и не production-проверка токенов.
export class DemoDpopError extends Error {
  constructor(code, status = 401, nonce) {
    super(code);
    this.name = 'DemoDpopError';
    this.code = code;
    this.status = status;
    this.nonce = nonce;
  }
}
const hash = value => createHash('sha256').update(value).digest('base64url');
const random = () => randomBytes(32).toString('base64url');
const encodedHash = /^[A-Za-z0-9_-]{43}$/u;
const invalidProof = () => new DemoDpopError('invalid_dpop_proof');

function decodeObject(segment) {
  if (!/^[A-Za-z0-9_-]+$/u.test(segment)) throw invalidProof();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) throw invalidProof();
  const value = JSON.parse(bytes.toString('utf8'));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidProof();
  return value;
}
function publicKey(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk
      || !encodedHash.test(jwk.x) || !encodedHash.test(jwk.y)) throw invalidProof();
  for (const coordinate of [jwk.x, jwk.y]) {
    if (Buffer.from(coordinate, 'base64url').toString('base64url') !== coordinate) throw invalidProof();
  }
  const canonical = { crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y };
  return { key: createPublicKey({ key: canonical, format: 'jwk' }), jkt: hash(JSON.stringify(canonical)) };
}

export function createDemoDpopAuth({
  tokenTtlMs = 300000, proofMaxAgeSeconds = 60, clock = Date.now,
  maxSessions = 128, maxReplayEntries = 4096,
} = {}) {
  for (const value of [tokenTtlMs, proofMaxAgeSeconds, maxSessions, maxReplayEntries]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Positive integer bounds required');
  }
  if (tokenTtlMs > 2147483647) throw new TypeError('Token TTL must fit a Node timer');
  const sessions = new Map();
  const replays = new Map();
  const prune = now => {
    for (const [key, entry] of sessions) if (entry.expiresAt <= now) sessions.delete(key);
    for (const [key, expiresAt] of replays) if (expiresAt <= now) replays.delete(key);
  };
  return {
    // The caller allowlists fixture accounts. No password or identity is authenticated here.
    // Вызывающая сторона ограничивает демо-аккаунты; пароль и личность здесь не проверяются.
    issueSession({ accountId, jkt }) {
      if (typeof accountId !== 'string' || !accountId || accountId.length > 128
          || typeof jkt !== 'string' || !encodedHash.test(jkt)) throw new TypeError('Invalid demo account or thumbprint');
      const now = clock();
      prune(now);
      if (sessions.size >= maxSessions) throw new DemoDpopError('session_capacity', 503);
      const accessToken = random();
      const expiresAt = now + tokenTtlMs;
      sessions.set(accessToken, { accountId, cnf: { jkt }, expiresAt, nonce: random() });
      return { accessToken, tokenType: 'DPoP', expiresAt };
    },
    async verify({ authorization, proof, method, url }) {
      const now = clock();
      prune(now);
      if (typeof authorization !== 'string' || !/^DPoP [A-Za-z0-9_-]{43}$/u.test(authorization)) {
        throw new DemoDpopError('invalid_token');
      }
      const accessToken = authorization.slice(5);
      const session = sessions.get(accessToken);
      if (!session) throw new DemoDpopError('invalid_token');
      try {
        if (typeof proof !== 'string' || proof.length > 8192) throw invalidProof();
        const parts = proof.split('.');
        if (parts.length !== 3) throw invalidProof();
        const header = decodeObject(parts[0]);
        const claims = decodeObject(parts[1]);
        if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256' || header.crit !== undefined
            || header.b64 !== undefined) throw invalidProof();
        const { key, jkt } = publicKey(header.jwk);
        const signature = Buffer.from(parts[2], 'base64url');
        if (signature.length !== 64 || signature.toString('base64url') !== parts[2]
            || !verifySignature('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
              { key, dsaEncoding: 'ieee-p1363' }, signature)) throw invalidProof();
        const target = new URL(url);
        const expectedHtu = `${target.origin}${target.pathname}`;
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password
            || jkt !== session.cnf.jkt || claims.ath !== hash(accessToken)
            || claims.htm !== method || claims.htu !== expectedHtu
            || !Number.isSafeInteger(claims.iat) || claims.iat < Math.floor(now / 1000) - proofMaxAgeSeconds
            || claims.iat > Math.floor(now / 1000) + 5
            || typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 200) throw invalidProof();
        if (claims.nonce !== session.nonce) throw new DemoDpopError('use_dpop_nonce', 401, session.nonce);
        const replayKey = `${jkt}:${claims.jti}`;
        if (replays.has(replayKey)) throw invalidProof();
        // Never evict a live replay marker to admit another request: reject at capacity.
        // Не вытесняем действующую отметку повтора ради нового запроса: при заполнении отклоняем.
        if (replays.size >= maxReplayEntries) throw new DemoDpopError('replay_capacity', 503);
        replays.set(replayKey, (claims.iat + proofMaxAgeSeconds + 1) * 1000);
        return { accountId: session.accountId, expiresAt: session.expiresAt };
      } catch (error) {
        if (error instanceof DemoDpopError) throw error;
        throw invalidProof();
      }
    },
    writeError(response, error) {
      const failure = error instanceof DemoDpopError ? error : new DemoDpopError('invalid_dpop_proof');
      if (failure.nonce) response.setHeader('DPoP-Nonce', failure.nonce);
      if (failure.status === 401) response.setHeader('WWW-Authenticate', `DPoP error="${failure.code}"`);
      response.writeHead(failure.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ error: failure.code }));
    },
  };
}
