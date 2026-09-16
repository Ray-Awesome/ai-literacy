import test from 'node:test';
import assert from 'node:assert/strict';
import { beginAction, createActionState, resolveAction } from '../../js/admin-editorial-actions.js';

test('ambiguous send failures reuse the same Idempotency-Key until a definitive response', () => {
  let count = 0;
  const actions = createActionState(() => 'send-key-' + (++count));
  const first = beginAction(actions, 'send:12', { newsletterId: 12 });
  resolveAction(actions, first, 'retryable-error', '대기열 확인 필요');
  const retry = beginAction(actions, 'send:12', { newsletterId: 12 });

  assert.equal(retry.key, 'send-key-1');
  assert.equal(retry.attempt, 2);
  resolveAction(actions, retry, 'success');
  const nextAction = beginAction(actions, 'send:12', { newsletterId: 12 });
  assert.equal(nextAction.key, 'send-key-2');
});

test('retry action keys are stable only for the same newsletter and source send', () => {
  let count = 0;
  const actions = createActionState(() => 'key-' + (++count));
  const first = beginAction(actions, 'retry:12:30', { newsletterId: 12, sendId: 30 });
  resolveAction(actions, first, 'retryable-error');
  assert.equal(beginAction(actions, 'retry:12:30', { newsletterId: 12, sendId: 30 }).key, first.key);
  assert.equal(beginAction(actions, 'retry:12:31', { newsletterId: 12, sendId: 31 }).key, 'key-2');
});
