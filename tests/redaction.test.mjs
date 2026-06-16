import test from 'node:test';
import assert from 'node:assert/strict';
import { maskAccountNo, redactSensitive } from '../dist/redaction.js';

test('redacts API keys, secrets, bearer tokens, sensitive headers, and account numbers', () => {
  const redacted = redactSensitive({
    apiKey: 'live_api_key_value', secretKey: 'live_secret_value', Authorization: 'Bearer abc.def.ghi',
    'X-Tossinvest-Account': '12345678901', nested: { accountNo: '98765432109', ok: 'visible' }
  });
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('live_api_key_value'), false);
  assert.equal(text.includes('live_secret_value'), false);
  assert.equal(text.includes('abc.def.ghi'), false);
  assert.equal(text.includes('12345678901'), false);
  assert.equal(text.includes('visible'), true);
});

test('masks account numbers while preserving a small suffix', () => {
  assert.equal(maskAccountNo('12345678901'), '*******8901');
});
