import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../dist/tools.js';
import { TossInvestClient } from '../dist/tossClient.js';
import { loadConfig } from '../dist/config.js';
import { WORKFLOW_CONFIRMATION_TEXT, clearPreviewStoreForTests } from '../dist/workflow.js';

function makeDeps(env = {}, fetcher = async () => new Response('{}', { status: 200 })) {
  const config = loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_ACCOUNT_SEQ: '1', ...env });
  const client = new TossInvestClient(config, fetcher);
  return { client, config };
}

test('portfolio_snapshot returns structured partial results and warning flags', async () => {
  const calls = [];
  const deps = makeDeps({}, async (input, init) => {
    calls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/holdings')) return new Response(JSON.stringify([{ symbol: '005930', quantity: 2, price: 70000, valuationAmount: 140000 }]), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([{ orderId: 'open-1', symbol: '005930', status: 'OPEN' }]), { status: 200 });
    if (String(input).includes('/api/v1/buying-power?currency=KRW')) return new Response(JSON.stringify({ currency: 'KRW', amount: 1000000 }), { status: 200 });
    return new Response(JSON.stringify({ message: 'USD endpoint unavailable' }), { status: 503 });
  });

  const snapshot = await executeTool('portfolio_snapshot', {}, deps);
  assert.equal(snapshot.account.accountSeqConfigured, true);
  assert.equal(snapshot.partialFailures.length, 1);
  assert.equal(snapshot.buyingPower.KRW.status, 'ok');
  assert.equal(snapshot.buyingPower.USD.status, 'partial_failure');
  assert.equal(snapshot.openOrders.items.length, 1);
  assert.equal(snapshot.holdings.items[0].weightStatus, 'calculated');
  assert.ok(snapshot.warningFlags.includes('partial_failures_present'));
  assert.equal(calls.some((call) => call.method === 'POST' && !call.input.endsWith('/oauth2/token')), false);
});

test('pre_trade_check is separate from execution and returns blockers, missing, warnings, and dry-run status', async () => {
  const deps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input, init) => {
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/market-calendar')) return new Response(JSON.stringify({ isOpen: false }), { status: 200 });
    if (String(input).includes('/api/v1/stocks/005930/warnings')) return new Response(JSON.stringify({ warnings: ['investment_warning'] }), { status: 200 });
    if (String(input).includes('/api/v1/price-limits')) return new Response(JSON.stringify({ upperLimit: 71000, lowerLimit: 60000 }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ amount: 200000 }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([{ orderId: 'dup', symbol: '005930', status: 'OPEN' }]), { status: 200 });
    if (String(input).includes('/api/v1/commissions')) return new Response(JSON.stringify({ rate: 0.001 }), { status: 200 });
    return new Response('{}', { status: 200 });
  });

  const result = await executeTool('pre_trade_check', {
    request: { symbol: '005930', side: 'BUY', orderType: 'MARKET', quantity: '1', price: '70000', currency: 'KRW' },
    delegatedAuthority: { remainingAmount: 50000, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  }, deps);

  assert.equal(result.canProceedDryRun, false);
  assert.equal(result.realOrderBlockedByDefault, false);
  assert.ok(result.blockers.some((item) => item.code === 'market_closed'));
  assert.ok(result.blockers.some((item) => item.code === 'market_order_blocked'));
  assert.ok(result.blockers.some((item) => item.code === 'delegated_amount_exceeded'));
  assert.ok(result.warnings.some((item) => item.code === 'duplicate_open_order'));
  assert.deepEqual(result.dataFreshness.source, 'fresh_reads');
});

test('pre_trade_check parses official-style buying power aliases, market session fields, and commission estimate', async () => {
  const deps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input) => {
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/market-calendar')) return new Response(JSON.stringify({ session: 'REGULAR', sessionStatus: 'OPEN' }), { status: 200 });
    if (String(input).includes('/api/v1/stocks/005930/warnings')) return new Response(JSON.stringify({ warnings: [] }), { status: 200 });
    if (String(input).includes('/api/v1/price-limits')) return new Response(JSON.stringify({ upperLimit: 80000, lowerLimit: 60000 }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ currency: 'KRW', result: { cashBuyingPower: 200000 } }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    if (String(input).includes('/api/v1/commissions')) return new Response(JSON.stringify({ commissionRate: 0.0015 }), { status: 200 });
    return new Response('{}', { status: 200 });
  });

  const result = await executeTool('pre_trade_check', {
    request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' }
  }, deps);

  assert.equal(result.canProceedDryRun, true);
  assert.ok(result.checks.some((item) => item.code === 'market_open' && item.session === 'REGULAR'));
  assert.ok(result.checks.some((item) => item.code === 'buying_power_sufficient' && item.available === 200000));
  assert.ok(!result.missing.some((item) => item.code === 'buying_power_not_calculable'));
  const commission = result.checks.find((item) => item.code === 'commission_estimated');
  assert.equal(commission.estimatedFee, 105);
});

test('pre_trade_check and order_preview classify KR/US null today market sessions as non-business-day blockers', async () => {
  clearPreviewStoreForTests();
  const deps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input) => {
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/market-calendar')) return new Response(JSON.stringify({ result: { calendars: { KR: { today: { session: null } }, US: { today: { session: null } } } } }), { status: 200 });
    if (String(input).includes('/api/v1/stocks/005930/warnings')) return new Response(JSON.stringify({ warnings: [] }), { status: 200 });
    if (String(input).includes('/api/v1/price-limits')) return new Response(JSON.stringify({ upperLimit: 80000, lowerLimit: 60000 }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ result: { cashBuyingPower: 200000 } }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    if (String(input).includes('/api/v1/commissions')) return new Response(JSON.stringify({ commissionRate: 0.0015 }), { status: 200 });
    return new Response('{}', { status: 200 });
  });

  const request = { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' };
  const result = await executeTool('pre_trade_check', { request }, deps);
  const preview = await executeTool('order_preview', { request }, deps);

  assert.equal(result.canProceedDryRun, false);
  assert.ok(result.blockers.some((item) => item.code === 'market_closed_non_business_day'));
  assert.ok(!result.missing.some((item) => item.code === 'market_open_unknown'));
  assert.ok(result.checks.some((item) => item.code === 'buying_power_sufficient' && item.available === 200000));
  assert.equal(preview.executable, false);
  assert.ok(preview.gate.blockers.some((item) => item.code === 'market_closed_non_business_day'));
  assert.ok(!preview.gate.missing.some((item) => item.code === 'market_open_unknown'));
});

test('order_preview never calls Toss order POST and returns preview contract fields', async () => {
  clearPreviewStoreForTests();
  const calls = [];
  const deps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input, init) => {
    calls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ amount: 200000 }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    return new Response('{}', { status: 200 });
  });

  const preview = await executeTool('order_preview', { request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' } }, deps);
  assert.match(preview.previewId, /^preview_/);
  assert.match(preview.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.ttlSeconds, 90);
  assert.equal(preview.confirmationText, WORKFLOW_CONFIRMATION_TEXT);
  assert.equal(preview.gate.status, 'pass');
  assert.equal(calls.some((call) => call.method === 'POST' && !call.input.endsWith('/oauth2/token')), false);
});

test('order_execute rejects preview that was blocked at preview time before order POST', async () => {
  clearPreviewStoreForTests();
  const calls = [];
  const deps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input, init) => {
    calls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/market-calendar')) return new Response(JSON.stringify({ isOpen: false }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ amount: 200000 }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    if (String(input).endsWith('/api/v1/orders')) return new Response(JSON.stringify({ orderId: 'should-not-post' }), { status: 200 });
    return new Response('{}', { status: 200 });
  });

  const preview = await executeTool('order_preview', { request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' } }, deps);
  assert.equal(preview.gate.status, 'blocked');
  assert.ok(preview.executable === false || preview.executable === undefined);

  const result = await executeTool('order_execute', { previewId: preview.previewId, confirmation: WORKFLOW_CONFIRMATION_TEXT, requestHash: preview.requestHash }, deps);
  assert.equal(result.status, 'blocked');
  assert.match(result.failures.join(' '), /preview gate/i);
  assert.equal(calls.filter((call) => call.input.endsWith('/api/v1/orders') && call.method === 'POST').length, 0);
});

test('order_execute rejects missing, confirmation mismatch, hash mismatch, expired preview, and failed env gates before order POST', async () => {
  clearPreviewStoreForTests();
  const orderPostCalls = [];
  const previewDeps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input, init) => {
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ amount: 200000 }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    if (init?.method === 'POST' && String(input).endsWith('/api/v1/orders')) orderPostCalls.push({ input: String(input), method: init?.method });
    return new Response(JSON.stringify({ orderId: 'should-not-post' }), { status: 200 });
  });
  const preview = await executeTool('order_preview', { request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' }, ttlSeconds: 1 }, previewDeps);

  assert.equal((await executeTool('order_execute', { previewId: 'missing', confirmation: WORKFLOW_CONFIRMATION_TEXT, requestHash: preview.requestHash }, previewDeps)).status, 'blocked');
  assert.equal((await executeTool('order_execute', { previewId: preview.previewId, confirmation: 'wrong', requestHash: preview.requestHash }, previewDeps)).status, 'blocked');
  assert.equal((await executeTool('order_execute', { previewId: preview.previewId, confirmation: WORKFLOW_CONFIRMATION_TEXT, requestHash: '0'.repeat(64) }, previewDeps)).status, 'blocked');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal((await executeTool('order_execute', { previewId: preview.previewId, confirmation: WORKFLOW_CONFIRMATION_TEXT, requestHash: preview.requestHash }, previewDeps)).status, 'blocked');

  const blockedDeps = makeDeps({ ENABLE_TRADING: 'false', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input, init) => {
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ amount: 200000 }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    if (init?.method === 'POST' && String(input).endsWith('/api/v1/orders')) orderPostCalls.push({ input: String(input), method: init?.method });
    return new Response(JSON.stringify({ orderId: 'should-not-post' }), { status: 200 });
  });
  const freshPreview = await executeTool('order_preview', { request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' } }, previewDeps);
  assert.equal((await executeTool('order_execute', { previewId: freshPreview.previewId, confirmation: WORKFLOW_CONFIRMATION_TEXT, requestHash: freshPreview.requestHash }, blockedDeps)).status, 'blocked');
  assert.equal(orderPostCalls.length, 0);
});

test('order_execute posts exactly once for an approved preview and reports ambiguous timeout state', async () => {
  clearPreviewStoreForTests();
  const calls = [];
  const deps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input, init) => {
    calls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/market-calendar')) return new Response(JSON.stringify({ isOpen: true }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ amount: 200000 }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    if (String(input).endsWith('/api/v1/orders')) return new Response(JSON.stringify({ orderId: 'created' }), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  const preview = await executeTool('order_preview', { request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' } }, deps);
  const executed = await executeTool('order_execute', { previewId: preview.previewId, confirmation: WORKFLOW_CONFIRMATION_TEXT, requestHash: preview.requestHash }, deps);
  assert.equal(executed.status, 'submitted');
  assert.deepEqual(executed.response, { orderId: 'created' });
  assert.equal(calls.filter((call) => call.input.endsWith('/api/v1/orders') && call.method === 'POST').length, 1);

  clearPreviewStoreForTests();
  const timeoutCalls = [];
  const timeoutDeps = makeDeps({ ENABLE_TRADING: 'true', ENABLE_ORDER_CREATE: 'true', MAX_ORDER_KRW: '100000', ALLOWED_SYMBOLS: '005930' }, async (input, init) => {
    timeoutCalls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('/api/v1/market-calendar')) return new Response(JSON.stringify({ isOpen: true }), { status: 200 });
    if (String(input).includes('/api/v1/buying-power')) return new Response(JSON.stringify({ amount: 200000 }), { status: 200 });
    if (String(input).includes('/api/v1/orders?')) return new Response(JSON.stringify([]), { status: 200 });
    if (String(input).endsWith('/api/v1/orders')) throw new Error('Toss API request timed out after 15000ms');
    return new Response('{}', { status: 200 });
  });
  const timeoutPreview = await executeTool('order_preview', { request: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000', currency: 'KRW' } }, timeoutDeps);
  const timeoutResult = await executeTool('order_execute', { previewId: timeoutPreview.previewId, confirmation: WORKFLOW_CONFIRMATION_TEXT, requestHash: timeoutPreview.requestHash }, timeoutDeps);
  assert.equal(timeoutResult.status, 'unknown_execution_state');
  assert.match(timeoutResult.nextStep, /order_status_summary/);
  assert.equal(timeoutCalls.filter((call) => call.input.endsWith('/api/v1/orders') && call.method === 'POST').length, 1);
});

test('order_status_summary reads open and closed orders without side effects and summarizes states', async () => {
  const calls = [];
  const deps = makeDeps({}, async (input, init) => {
    calls.push({ input: String(input), method: init?.method });
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    if (String(input).includes('status=OPEN')) return new Response(JSON.stringify([{ orderId: 'open', status: 'OPEN', symbol: '005930' }]), { status: 200 });
    if (String(input).includes('status=CLOSED')) return new Response(JSON.stringify([{ orderId: 'filled', status: 'FILLED', symbol: '005930' }, { orderId: 'rejected', status: 'REJECTED', symbol: 'AAPL', replaceOrderId: 'new-1' }]), { status: 200 });
    return new Response('{}', { status: 200 });
  });
  const summary = await executeTool('order_status_summary', { symbol: '005930', limit: 20 }, deps);
  assert.equal(summary.openOrders.items.length, 1);
  assert.equal(summary.recentlyClosedOrders.items.length, 2);
  assert.equal(summary.stateCounts.OPEN, 1);
  assert.equal(summary.stateCounts.FILLED, 1);
  assert.equal(summary.stateCounts.REJECTED, 1);
  assert.ok(summary.caveats.some((caveat) => caveat.includes('replace')));
  assert.equal(calls.some((call) => call.method === 'POST' && !call.input.endsWith('/oauth2/token')), false);
});
