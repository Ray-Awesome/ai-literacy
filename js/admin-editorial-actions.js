function sameContext(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createActionState(keyFactory) {
  return { keyFactory, actions: new Map() };
}

export function beginAction(state, slot, context) {
  const current = state.actions.get(slot);
  if (current && sameContext(current.context, context) && (current.status === 'pending' || current.status === 'retryable-error')) {
    current.attempt += 1;
    current.status = 'pending';
    current.error = '';
    return current;
  }
  const action = { slot, context, key: state.keyFactory(), attempt: 1, status: 'pending', error: '' };
  state.actions.set(slot, action);
  return action;
}

export function resolveAction(state, action, status, error = '') {
  if (state.actions.get(action.slot) !== action) return false;
  action.status = status;
  action.error = error;
  return true;
}
