# Newsletter provider-operation reconciliation

Provider-operation rows contain recipient addresses and rendered mail bodies. They are server-only operational data: never expose them in browser APIs or logs.

Completed accepted operations and definitive provider rejections expire after 30 days only when no delivery remains pending or indeterminate; their ordinary delivery audit rows remain. An operation with a pending or `delivery_certainty = 'indeterminate'` delivery is retained for reconciliation. Use authorized Resend evidence for the stored provider idempotency key and frozen recipient list. Do not use normal failed-recipient retry for indeterminate rows and do not mint a new provider key until evidence establishes non-delivery.

## Authorized settlement procedure

Settlement is a writer-paused D1 batch (or one transaction in an authorized
reconciliation tool), never an editor retry. First read the operation by its
stored `operation_key`, retain the ordered `delivery_ids_json`, and record the
authorized provider evidence outside browser logs. Do not put `request_body`,
recipient addresses, tokens, or provider credentials in a ticket.

For proven non-delivery, in this order: set the operation `outcome =
'rejected'`, store only the documented provider error code in `provider_result`,
and set `settled_at`; set exactly those pending operation deliveries to
`failed`, `delivery_certainty = 'known'`, and the same error code; then run the
same send aggregate and latest-send-guard newsletter recomputation used by the
Worker. Only after that batch commits can normal failed-recipient retry become
eligible. The local retention fixture exercises this path and confirms the
settled operation can age out with its terminal history after 24 months.

For proven delivery, in this order: persist `outcome = 'accepted'`,
`status = 'accepted'`, ordered provider message IDs in `provider_result`, and
`accepted_at`/`settled_at`; update the matching ordered pending deliveries to
`sent` with their provider IDs and `delivery_certainty = 'known'`; then run the
same aggregate/latest-send-guard recomputation. Do not invent provider IDs or
mark a delivery sent without provider evidence.

If evidence is incomplete, leave the operation `outcome = 'pending'` and the
affected delivery `indeterminate` (or pending before DLQ); retain the original
key and do not enqueue, retry, or mint a new provider key. This is the only
state intentionally held beyond normal terminal retention.
