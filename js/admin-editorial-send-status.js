function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function sendOutcome(send = {}) {
  const retryableCount = count(send.retryableFailureCount);
  const indeterminateCount = count(send.indeterminateCount);
  return {
    retryableCount,
    indeterminateCount,
    canRetry: retryableCount > 0 && ['partial', 'failed'].includes(send.status),
    reconciliationMessage: indeterminateCount > 0
      ? `확인 필요 ${indeterminateCount}명: 제공업체 확인이 필요합니다.`
      : '',
  };
}
