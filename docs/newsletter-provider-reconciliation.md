# Newsletter provider-operation reconciliation

Provider-operation rows contain recipient addresses and rendered mail bodies. They are server-only operational data: never expose them in browser APIs or logs.

Completed, accepted operations expire after 30 days only when no delivery remains pending or indeterminate; their ordinary delivery audit rows remain. An operation with a pending or `delivery_certainty = 'indeterminate'` delivery is retained for reconciliation. Use authorized Resend evidence for the stored provider idempotency key and frozen recipient list. Do not use normal failed-recipient retry for indeterminate rows and do not mint a new provider key until evidence establishes non-delivery. After evidence establishes non-delivery, an authorized operator may mark the affected deliveries `failed` with certainty `known`; after delivery is established, record the original provider result and mark them sent.
