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
