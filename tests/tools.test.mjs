import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions } from '../dist/tools.js';

test('registers all requested read-only and trading tools', () => {
  const names = toolDefinitions.map((tool) => tool.name).sort();
  assert.deepEqual(names, ['accounts', 'auth_status', 'buying_power', 'candles', 'commissions', 'exchange_rate', 'holdings', 'market_calendar', 'order_cancel', 'order_create', 'order_detail', 'order_execute', 'order_modify', 'order_preview', 'order_status_summary', 'order_validate', 'orderbook', 'orders_closed', 'orders_open', 'portfolio_snapshot', 'pre_trade_check', 'price_limits', 'prices', 'sellable_quantity', 'stock_info', 'stock_warnings', 'trades'].sort());
});

test('uses only official Toss Open API paths for tool mappings', () => {
  for (const tool of toolDefinitions) {
    if ('path' in tool) assert.match(tool.path, /^\/api\/v1\//);
  }
});

test('marks order tools as dry-run and side-effect gated in descriptions', () => {
  for (const name of ['order_create', 'order_modify', 'order_cancel']) {
    const tool = toolDefinitions.find((candidate) => candidate.name === name);
    assert.match(tool.description, /dry-run/i);
    assert.match(tool.description, /ENABLE_TRADING/);
  }
});
