import test from 'node:test';
import assert from 'node:assert/strict';
import { TossInvestClient } from '../dist/tossClient.js';
import { loadConfig } from '../dist/config.js';

test('unknown enum/status values pass through without validation rejection', async () => {
  const client = new TossInvestClient(loadConfig({ TOSS_API_KEY: 'key', TOSS_SECRET_KEY: 'secret', TOSS_ACCOUNT_SEQ: '1' }), async (input) => {
    if (String(input).endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ orders: [{ orderId: 'o1', status: 'FUTURE_STATUS', orderType: 'FUTURE_TYPE' }], nextCursor: null, hasNext: false }), { status: 200 });
  });
  const response = await client.get('/api/v1/orders', { accountRequired: true, query: { status: 'OPEN' } });
  assert.equal(response.orders[0].status, 'FUTURE_STATUS');
  assert.equal(response.orders[0].orderType, 'FUTURE_TYPE');
});
