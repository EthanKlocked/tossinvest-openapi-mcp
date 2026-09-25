import test from 'node:test';
import assert from 'node:assert/strict';
import { TossInvestClient } from '../dist/tossClient.js';
import { loadConfig } from '../dist/config.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const issued = () => json({ access_token: 'same-token', expires_in: 60 });
const rejected = (code) => json({ error: { code } }, 401);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(handler) {
  const counts = { oauth: 0, data: 0 };
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'fixture-key', TOSS_SECRET_KEY: 'fixture-secret' }), async (url, init) => {
    const oauth = String(url).endsWith('/oauth2/token');
    counts[oauth ? 'oauth' : 'data']++;
    return handler({ oauth, url: String(url), init, counts });
  });
  return { client, counts };
}

for (const code of ['invalid-token', 'token-revoked']) {
  test(`GET recovers once from structured ${code} preserving request`, async () => {
    const requests = [];
    const { client, counts } = setup(({ oauth, url, init, counts }) => {
      if (oauth) return json({ access_token: `token-${counts.oauth}`, expires_in: 60 });
      requests.push({ url, init });
      return counts.data === 1 ? rejected(code) : json({ ok: true });
    });
    assert.deepEqual(await client.get('/api/v1/holdings', { query: { symbol: 'AAPL' }, accountRequired: true, accountSeq: 9 }), { ok: true });
    assert.deepEqual(counts, { oauth: 2, data: 2 });
    assert.equal(requests[0].url, requests[1].url);
    assert.equal(requests[0].init.headers['X-Tossinvest-Account'], '9');
    assert.equal(requests[1].init.headers['X-Tossinvest-Account'], '9');
    assert.equal(requests[0].init.headers.authorization, 'Bearer token-1');
    assert.equal(requests[1].init.headers.authorization, 'Bearer token-2');
  });
  test(`GET recovers once from top-level ${code} with error.message`, async () => {
    const requests = [];
    const { client, counts } = setup(({ oauth, init, counts }) => {
      if (oauth) return json({ access_token: `token-${counts.oauth}`, expires_in: 60 });
      requests.push(init.headers.authorization);
      return counts.data === 1 ? json({ code, error: { message: 'revoked' } }, 401) : json({ ok: true });
    });
    assert.deepEqual(await client.get('/api/v1/prices'), { ok: true });
    assert.deepEqual(counts, { oauth: 2, data: 2 });
    assert.deepEqual(requests, ['Bearer token-1', 'Bearer token-2']);
  });
  test(`repeated top-level ${code} with error.message stops after one retry`, async () => {
    const { client, counts } = setup(({ oauth }) => oauth ? issued() : json({ code, error: { message: 'revoked' } }, 401));
    await assert.rejects(client.get('/api/v1/prices'), /401/);
    assert.deepEqual(counts, { oauth: 2, data: 2 });
  });
  for (const nestedCode of ['permission-denied', null, '', 0]) {
    test(`present nested code ${JSON.stringify(nestedCode)} blocks top-level ${code} fallback`, async () => {
      const { client, counts } = setup(({ oauth }) => oauth ? issued() : json({ code, error: { code: nestedCode } }, 401));
      await assert.rejects(client.get('/api/v1/prices'), /401/);
      assert.deepEqual(counts, { oauth: 1, data: 1 });
    });
  }
  test(`nested ${code} takes precedence over conflicting top-level auth code`, async () => {
    const topLevelCode = code === 'invalid-token' ? 'token-revoked' : 'invalid-token';
    const { client, counts } = setup(({ oauth }) => oauth ? issued() : json({ code: topLevelCode, error: { code } }, 401));
    await assert.rejects(client.post('/api/v1/orders', { body: { symbol: 'AAPL' } }), /401/);
    assert.deepEqual(counts, code === 'invalid-token' ? { oauth: 2, data: 2 } : { oauth: 1, data: 1 });
  });
  test(`repeated ${code} terminates after one retry`, async () => {
    const { client, counts } = setup(({ oauth }) => oauth ? issued() : rejected(code));
    await assert.rejects(client.get('/api/v1/prices'), /failed \(401\)/);
    assert.deepEqual(counts, { oauth: 2, data: 2 });
  });
  for (const method of ['get', 'post']) test(`${method} retry false blocks ${code} replay`, async () => {
    const { client, counts } = setup(({ oauth }) => oauth ? issued() : rejected(code));
    await assert.rejects(client[method]('/api/v1/orders', { retryInvalidToken: false }), /401/);
    assert.deepEqual(counts, { oauth: 1, data: 1 });
  });
}

for (const payload of ['invalid-token', { message: 'invalid-token' }, { error: { message: 'invalid-token' } }, { arbitrary: ['invalid-token'] }, { metadata: { code: 'invalid-token' } }, { code: 'permission-denied' }, { error: { code: 'permission-denied', message: 'token-revoked' } }]) {
  test(`does not recover arbitrary/unrelated 401 ${JSON.stringify(payload)}`, async () => {
    const { client, counts } = setup(({ oauth }) => oauth ? issued() : json(payload, 401));
    await assert.rejects(client.get('/api/v1/prices'), /401/);
    assert.deepEqual(counts, { oauth: 1, data: 1 });
  });
}
test('POST preserves invalid-token recovery but never adds token-revoked replay', async () => {
  for (const code of ['invalid-token', 'token-revoked']) {
    const { client, counts } = setup(({ oauth }) => oauth ? issued() : rejected(code));
    await assert.rejects(client.post('/api/v1/orders', { body: { symbol: 'AAPL' } }), /401/);
    assert.deepEqual(counts, code === 'invalid-token' ? { oauth: 2, data: 2 } : { oauth: 1, data: 1 });
  }
});
test('fresh cache reuse and exact 30-second expiry boundary', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { client, counts } = setup(({ oauth }) => oauth ? issued() : json({}));
  await client.get('/api/v1/prices');
  now += 29_999;
  await client.get('/api/v1/prices');
  assert.equal(counts.oauth, 1);
  now += 1;
  await client.get('/api/v1/prices');
  assert.equal(counts.oauth, 2);
  const status = await client.authStatus();
  assert.equal(status.tokenLifecycle.reason, 'expiry-margin');
  assert.equal(status.tokenLifecycle.expiresAt, now + 60_000);
});
test('concurrent cold requests share a single pending issuance', async () => {
  const gate = deferred();
  const { client, counts } = setup(async ({ oauth }) => { if (oauth) { await gate.promise; return issued(); } return json({}); });
  const pending = Promise.all([client.get('/a'), client.get('/b'), client.get('/c')]);
  await tick();
  const observed = counts.oauth;
  gate.resolve();
  await pending;
  assert.equal(observed, 1);
});
for (const code of ['invalid-token', 'token-revoked']) test(`concurrent ${code} refreshes coalesce`, async () => {
  const gate = deferred();
  const { client, counts } = setup(async ({ oauth, counts }) => {
    if (oauth) { if (counts.oauth > 1) await gate.promise; return issued(); }
    return counts.data <= 3 ? rejected(code) : json({});
  });
  const pending = Promise.allSettled([client.get('/a'), client.get('/b'), client.get('/c')]);
  await tick();
  const observed = counts.oauth;
  gate.resolve();
  const results = await pending;
  assert.equal(observed, 2);
  assert.ok(results.every(r => r.status === 'fulfilled'));
  assert.equal(counts.data, 6);
});
test('late old-generation rejection cannot invalidate replacement with identical token string', async () => {
  const late = deferred();
  const { client, counts } = setup(({ oauth, url, counts }) => {
    if (oauth) return issued();
    if (url.endsWith('/late') && counts.data === 2) return late.promise;
    if (url.endsWith('/refresh') && counts.oauth === 1) return rejected('invalid-token');
    return json({});
  });
  await client.get('/warm');
  const pending = client.get('/late');
  await tick();
  await client.get('/refresh');
  late.resolve(rejected('invalid-token'));
  await pending;
  assert.equal(counts.oauth, 2);
});
for (const failure of ['network', 'http', 'missing-token']) test(`shared ${failure} issuance failure is safe and later call can recover`, async () => {
  const gate = deferred();
  let failing = true;
  const leak = 'RAW fixture-key fixture-secret same-token Authorization private-account';
  const { client, counts } = setup(async ({ oauth }) => {
    if (!oauth) return json({});
    await gate.promise;
    if (!failing) return issued();
    if (failure === 'network') throw new Error(leak);
    return json({ message: leak }, failure === 'http' ? 401 : 200);
  });
  const pending = Promise.allSettled([client.get('/a'), client.get('/b')]);
  await tick(); gate.resolve();
  const results = await pending;
  assert.equal(counts.oauth, 1);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Toss OAuth.*Check/i);
    assert.doesNotMatch(result.reason.message, /RAW|fixture-key|fixture-secret|same-token|Authorization|private-account/);
  }
  const status = await client.authStatus();
  assert.equal(status.tokenLifecycle.outcome, 'failed');
  assert.equal(status.tokenLifecycle.expiresAt, null);
  assert.doesNotMatch(JSON.stringify(status), /RAW|fixture-key|fixture-secret|same-token|Authorization|private-account/);
  failing = false;
  await client.get('/c');
});
test('rejected reads share failed refresh without replaying data requests', async () => {
  const gate = deferred();
  let rejectReads = false;
  const { client, counts } = setup(async ({ oauth, counts }) => {
    if (oauth) {
      if (counts.oauth === 1) return issued();
      await gate.promise;
      throw new Error('private upstream text');
    }
    return rejectReads ? rejected('token-revoked') : json({});
  });
  await client.get('/warm');
  rejectReads = true;
  const pending = Promise.allSettled([client.get('/a'), client.get('/b')]);
  await tick();
  const observed = counts.oauth;
  gate.resolve();
  const results = await pending;
  assert.equal(observed, 2);
  assert.deepEqual(counts, { oauth: 2, data: 3 });
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /Toss OAuth token issuance failed/);
    assert.doesNotMatch(result.reason.message, /private upstream text/);
  }
});

test('auth status exposes safe issuance reason timing expiry and outcome', async (t) => {
  t.mock.method(Date, 'now', () => 1_000_000);
  const { client } = setup(({ oauth, counts }) => oauth ? issued() : counts.data === 1 ? rejected('token-revoked') : json({}));
  const status = await client.authStatus();
  assert.equal(status.authenticated, true);
  assert.deepEqual(status.tokenLifecycle, { reason: 'token-revoked', startedAt: 1_000_000, completedAt: 1_000_000, durationMs: 0, expiresAt: 1_060_000, outcome: 'succeeded' });
  assert.doesNotMatch(JSON.stringify(status.tokenLifecycle), /fixture|same-token|Bearer|Authorization/);
});
