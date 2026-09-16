import test from 'node:test';
import assert from 'node:assert/strict';
import { sendOutcome } from '../../js/admin-editorial-send-status.js';

test('known retryable failures remain eligible for recipient retry', () => {
  const outcome = sendOutcome({ status: 'partial', retryableFailureCount: 2, indeterminateCount: 0 });

  assert.equal(outcome.retryableCount, 2);
  assert.equal(outcome.indeterminateCount, 0);
  assert.equal(outcome.canRetry, true);
  assert.equal(outcome.reconciliationMessage, '');
});

test('indeterminate outcomes require provider reconciliation instead of ordinary retry', () => {
  const outcome = sendOutcome({ status: 'failed', failureCount: 3, retryableFailureCount: 0, indeterminateCount: 3 });

  assert.equal(outcome.canRetry, false);
  assert.equal(outcome.indeterminateCount, 3);
  assert.match(outcome.reconciliationMessage, /3명/);
  assert.match(outcome.reconciliationMessage, /제공업체 확인/);
});

test('mixed known and indeterminate failures retain retry only for known failures', () => {
  const outcome = sendOutcome({ status: 'partial', retryableFailureCount: 1, indeterminateCount: 1 });

  assert.equal(outcome.canRetry, true);
  assert.equal(outcome.retryableCount, 1);
  assert.match(outcome.reconciliationMessage, /제공업체 확인/);
});
