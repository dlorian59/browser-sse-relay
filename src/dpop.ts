/** Browser-side RFC 9449 proof creation; token issuance and server verification belong to the application. */
export interface DpopProofOptions {
  readonly keyPair: CryptoKeyPair;
  readonly url: string | URL;
  readonly method: string;
  readonly accessToken?: string;
  readonly nonce?: string;
}

export interface DpopFetchOptions {
  readonly keyPair: CryptoKeyPair;
  readonly getAccessToken: (signal: AbortSignal) => string | Promise<string>;
  /** One trusted HTTPS origin; HTTP is allowed only for literal loopback hosts or localhost. */
  readonly origin: string;
  readonly fetch?: typeof fetch;
}

const encoder = new TextEncoder();
const tokenSyntax = /^[A-Za-z0-9\-._~+/]+=*$/;
const nonceSyntax = /^[\x21\x23-\x5b\x5d-\x7e]+$/;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function digest(value: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

function checkedUrl(value: string | URL, base?: string): URL {
  const url = new URL(value, base);
  if (url.username || url.password) throw new TypeError('DPoP URLs must not contain credentials');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError('DPoP requires HTTPS except on loopback');
  }
  return url;
}

function checkedToken(token: string): string {
  if (typeof token !== 'string' || !tokenSyntax.test(token)) throw new TypeError('A non-empty access token is required');
  return token;
}

function validNonce(nonce: string | null): nonce is string {
  return nonce !== null && nonceSyntax.test(nonce);
}

async function publicJwk(keyPair: CryptoKeyPair): Promise<JsonWebKey> {
  for (const [key, type] of [[keyPair.publicKey, 'public'], [keyPair.privateKey, 'private']] as const) {
    const algorithm = key.algorithm as EcKeyAlgorithm;
    if (key.type !== type || algorithm.name !== 'ECDSA' || algorithm.namedCurve !== 'P-256') {
      throw new TypeError('DPoP requires an ECDSA P-256 key pair');
    }
  }
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  return { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! };
}

/** Create a non-extractable private key and an exportable public key; the caller owns persistence. */
export async function createDpopKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
}

/** RFC 7638 SHA-256 thumbprint for binding an issued token's cnf.jkt to this public key. */
export async function getDpopThumbprint(keyPair: CryptoKeyPair): Promise<string> {
  const jwk = await publicJwk(keyPair);
  return digest(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

/** Sign a fresh ES256 proof. Omit accessToken only for authorization-server token requests. */
export async function createDpopProof(options: DpopProofOptions): Promise<string> {
  const url = checkedUrl(options.url);
  if (!/^[!#$%&'*+.^_`|~A-Za-z0-9-]+$/.test(options.method)) throw new TypeError('Invalid HTTP method');
  if (options.nonce !== undefined && !validNonce(options.nonce)) throw new TypeError('Invalid DPoP nonce');
  const jwk = await publicJwk(options.keyPair);
  const ath = options.accessToken === undefined ? undefined : await digest(checkedToken(options.accessToken));
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk };
  const payload = {
    jti: crypto.randomUUID(), htm: options.method.toUpperCase(), htu: `${url.origin}${url.pathname}`,
    iat: Math.floor(Date.now() / 1000), ...(ath === undefined ? {} : { ath }),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  };
  const input = `${base64url(encoder.encode(JSON.stringify(header)))}.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, options.keyPair.privateKey, encoder.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

/** Parse only the relevant auth-param, without confusing another scheme or a quoted description with DPoP. */
function requestsNonce(header: string | null): boolean {
  if (!header) return false;
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index++) {
    const character = header[index];
    if (escaped) { escaped = false; continue; }
    if (quoted && character === '\\') { escaped = true; continue; }
    if (character === '"') quoted = !quoted;
    if (!quoted && character === ',') { parts.push(header.slice(start, index)); start = index + 1; }
  }
  if (quoted) return false;
  parts.push(header.slice(start));
  let dpop = false;
  for (const part of parts) {
    let parameter = part.trim();
    const challenge = /^([!#$%&'*+.^_`|~A-Za-z0-9-]+)(?:[\t ]+(.*))?$/.exec(parameter);
    if (challenge && !challenge[2]?.trimStart().startsWith('=')) {
      dpop = challenge[1]!.toLowerCase() === 'dpop';
      parameter = challenge[2] ?? '';
    }
    const error = /^error[\t ]*=[\t ]*(?:"([^"\\]*)"|([!#$%&'*+.^_`|~A-Za-z0-9-]+))[\t ]*$/i.exec(parameter);
    if (dpop && error && (error[1] ?? error[2]) === 'use_dpop_nonce') return true;
  }
  return false;
}

/**
 * GET-only SSE fetch transport scoped to one origin. Owns auth headers, disables redirects/cache,
 * and retries at most once for a valid resource-server nonce challenge. Never falls back to Bearer.
 * This does not obtain/refresh/bind tokens or verify server responses; use HTTPS and a trusted fetch.
 */
export function createDpopFetch(options: DpopFetchOptions): typeof fetch {
  const trusted = checkedUrl(options.origin);
  if (trusted.pathname !== '/' || trusted.search || trusted.hash) throw new TypeError('origin must contain only an origin');
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  let nonce: string | undefined;
  return async (input, init) => {
    const original = input instanceof Request ? input : undefined;
    const method = (init?.method ?? original?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' || (init?.body !== undefined && init.body !== null)) throw new TypeError('DPoP SSE transport supports GET without a body only');
    const url = checkedUrl(original?.url ?? String(input), trusted.origin);
    if (url.origin !== trusted.origin) throw new TypeError('DPoP request origin does not match the trusted origin');
    const request = new Request(original ?? url, init);
    const signal = request.signal;
    signal.throwIfAborted();
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      const token = checkedToken(await options.getAccessToken(signal));
      signal.throwIfAborted();
      const proof = await createDpopProof({ keyPair: options.keyPair, url, method: 'GET', accessToken: token,
        ...(nonce === undefined ? {} : { nonce }) });
      signal.throwIfAborted();
      const headers = new Headers(request.headers);
      headers.set('Authorization', `DPoP ${token}`);
      headers.set('DPoP', proof);
      const response = await transport(request, { headers, signal, redirect: 'error', cache: 'no-store' });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        signal.throwIfAborted();
      }
      const receivedNonce = response.headers.get('DPoP-Nonce');
      if (validNonce(receivedNonce)) nonce = receivedNonce;
      if (attempt === 0 && response.status === 401 && validNonce(receivedNonce) && requestsNonce(response.headers.get('WWW-Authenticate'))) {
        await response.body?.cancel();
        continue;
      }
      return response;
    }
    throw new Error('Unreachable DPoP retry state');
  };
}
