import test from 'node:test';
import assert from 'node:assert/strict';
import { TossInvestClient } from '../dist/tossClient.js';
import { loadConfig } from '../dist/config.js';

test('auth status reports missing credentials instead of throwing', async () => {
  const client = new TossInvestClient(loadConfig({}), async () => { throw new Error('should not fetch'); });
  assert.deepEqual(await client.authStatus(), { configured: false, authenticated: false, reason: 'Missing TOSS_API_KEY or TOSS_SECRET_KEY' });
});

test('uses official OAuth2 client credentials token flow', async () => {
  const calls = [];
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({ access_token: 'token', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
  });
  await client.authStatus();
  assert.equal(calls[0].input, 'https://openapi.tossinvest.com/oauth2/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(String(calls[0].init.body), /grant_type=client_credentials/);
  assert.match(String(calls[0].init.body), /client_id=key/);
  assert.match(String(calls[0].init.body), /client_secret=secret/);
});

test('adds X-Tossinvest-Account from per-call accountSeq or env and errors when missing', async () => {
  const calls = [];
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_ACCOUNT_SEQ: '3' }), async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await client.get('/api/v1/holdings', { accountRequired: true });
  assert.equal(calls[1].init.headers['X-Tossinvest-Account'], '3');
  await client.get('/api/v1/holdings', { accountRequired: true, accountSeq: 9 });
  assert.equal(calls[2].init.headers['X-Tossinvest-Account'], '9');

  const missing = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async () => new Response('{}'));
  await assert.rejects(missing.get('/api/v1/holdings', { accountRequired: true }), /accountSeq/);
});

test('nested invalid-token API response refreshes token and retries the original request once', async () => {
  const calls = [];
  let tokenIssueCount = 0;
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/oauth2/token')) {
      tokenIssueCount += 1;
      return new Response(JSON.stringify({ access_token: `token-${tokenIssueCount}`, expires_in: 3600 }), { status: 200 });
    }
    if (String(init?.headers?.authorization) === 'Bearer token-1') {
      return new Response(JSON.stringify({ error: { code: 'invalid-token', message: '유효하지 않은 토큰입니다.' } }), { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  assert.deepEqual(await client.get('/api/v1/prices', { query: { symbol: 'AAPL' } }), { ok: true });
  assert.deepEqual(calls.map((call) => call.input), [
    'https://openapi.tossinvest.com/oauth2/token',
    'https://openapi.tossinvest.com/api/v1/prices?symbol=AAPL',
    'https://openapi.tossinvest.com/oauth2/token',
    'https://openapi.tossinvest.com/api/v1/prices?symbol=AAPL'
  ]);
  assert.equal(calls[1].init.headers.authorization, 'Bearer token-1');
  assert.equal(calls[3].init.headers.authorization, 'Bearer token-2');
});

test('invalid-token retry happens only once before returning the API error', async () => {
  const calls = [];
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: `token-${calls.length}`, expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ code: 'invalid-token' }), { status: 401 });
  });

  await assert.rejects(client.get('/api/v1/prices'), /invalid-token/);
  assert.equal(calls.filter((call) => call.input.endsWith('/oauth2/token')).length, 2);
  assert.equal(calls.filter((call) => call.input.endsWith('/api/v1/prices')).length, 2);
});

test('GET retries one 429 response and then returns the successful payload', async () => {
  const calls = [];
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (calls.filter((call) => call.input.includes('/api/v1/holdings')).length === 1) {
      return new Response(JSON.stringify({ message: 'rate limited' }), { status: 429, headers: { 'Retry-After': '0' } });
    }
    return new Response(JSON.stringify({ result: { items: [{ symbol: '005930' }] } }), { status: 200 });
  });

  assert.deepEqual(await client.get('/api/v1/holdings', { accountRequired: true, accountSeq: 1 }), { result: { items: [{ symbol: '005930' }] } });
  assert.equal(calls.filter((call) => call.input.includes('/api/v1/holdings')).length, 2);
});

test('GET retry exhaustion preserves HTTP status in the thrown error', async () => {
  const calls = [];
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async (input) => {
    calls.push(String(input));
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ message: 'still rate limited' }), { status: 429, headers: { 'Retry-After': '0' } });
  });

  await assert.rejects(client.get('/api/v1/holdings', { accountRequired: true, accountSeq: 1 }), /failed \(429\)/);
  assert.equal(calls.filter((input) => input.includes('/api/v1/holdings')).length, 4);
});

test('GET does not block on Retry-After values above the local cap', { timeout: 800 }, async () => {
  const startedAt = Date.now();
  const calls = [];
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async (input) => {
    calls.push(String(input));
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ message: 'slow retry-after' }), { status: 429, headers: { 'Retry-After': '60' } });
  });

  await assert.rejects(client.get('/api/v1/holdings', { accountRequired: true, accountSeq: 1 }), /failed \(429\)/);
  assert.ok(Date.now() - startedAt < 800);
  assert.equal(calls.filter((input) => input.includes('/api/v1/holdings')).length, 1);
});

test('auth status separates token issuance from data endpoint reachability and accountSeq configuration', async () => {
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret' }), async (input) => {
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).endsWith('/api/v1/accounts')) return new Response(JSON.stringify({ code: 'invalid-token' }), { status: 401 });
    return new Response('{}', { status: 404 });
  });

  assert.deepEqual(await client.authStatus(), {
    configured: true,
    tokenAvailable: true,
    dataApiReachable: false,
    authenticated: false,
    tokenCache: 'memory',
    accountSeqConfigured: false,
    accountSeqRequiredForAccountTools: true,
    dataApiCheck: {
      endpoint: '/api/v1/accounts',
      ok: false,
      error: 'Toss API GET /api/v1/accounts failed (401): {"code":"invalid-token"}'
    }
  });
});


test('passes an AbortSignal to Toss requests for configured timeout support', async () => {
  const calls = [];
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_REQUEST_TIMEOUT_MS: '1000' }), async (input, init) => {
    calls.push({ input: String(input), init });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await client.get('/api/v1/prices', { query: { symbols: 'AAPL' } });
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.ok(calls[1].init.signal instanceof AbortSignal);
});
