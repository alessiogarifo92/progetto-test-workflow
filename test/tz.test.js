import test from 'node:test';
import assert from 'node:assert/strict';

// Day-key tests depend on the local zone: the suite pins it to Europe/Rome
// via test/setup-tz.mjs (see package.json), locally and in CI.
test('the suite runs in Europe/Rome (UTC+2 in October)', () => {
  assert.equal(new Date(2026, 9, 3, 0, 30).getTimezoneOffset(), -120);
});
