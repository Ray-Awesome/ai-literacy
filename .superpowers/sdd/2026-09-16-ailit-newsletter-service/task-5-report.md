# Task 5 — Editorial room

## Status

Implemented the newsletter draft APIs and the `에이릿 편집실` integration. No real email, deployment, remote D1 operation, or push was performed; test sends were mocked in automated tests.

## Files

- `functions/api/admin/newsletters/index.js` — guarded, paginated draft list and validated draft creation.
- `functions/api/admin/newsletters/[id].js` — guarded validated read/update with draft-only atomic updates.
- `functions/api/admin/newsletters/[id]/test-send.js` — one-address test send using rendered, escaped content and a visible test banner; it creates no send or delivery rows.
- `functions/api/admin/newsletter-subscribers.js` and `functions/api/admin/newsletter-sends.js` — paginated safe list APIs, including per-send delivery listing.
- `admin.html`, `js/admin-editorial.js`, and `css/style.css` — member/answer-compatible editorial UI, block editor, autosave, safe preview, and responsive width controls.
- `tests/newsletter/admin.test.js` — authorization, validation, immutability, test-send, pagination/privacy, and UI integration coverage.

## TDD evidence

- RED: API test first failed because `functions/api/admin/newsletters/index.js` did not exist.
- GREEN: API tests passed after the guarded handlers were added.
- RED: UI integration test failed because `js/admin-editorial.js` did not exist.
- GREEN: UI test passed after the page and script were integrated.
- RED: delivery `sendId` pagination and single-destination tests failed before the handler validation was added.
- GREEN: focused tests, static build, and full suite now pass.

## Commit

Recorded in the Task 5 implementation commit (hash added after commit).

## Self-review

- Every new handler invokes `requireAdmin` before parsing or database access and fails closed when the session secret is unavailable.
- IDs, pagination values, JSON object bodies, test email input, and block payloads are checked server-side. HTTPS image validation remains the default through `validateBlocks` and `renderNewsletter`.
- Subscriber responses are explicitly projected, so confirmation hashes and action tokens cannot be returned. Test sends send a single validated address with a `[테스트]` subject and banner only; they do not write bulk-send tables.
- Existing 회원 and 답변 routes remain available through their original endpoints and are rendered with DOM text nodes. The responsive preview CSS constrains desktop to 640px and mobile to 375px; the editorial grid collapses at 760px.

## Concerns

- Full-send remains intentionally non-operational in this task; the UI explains that no send was started. Queue-backed bulk dispatch belongs to the later endpoint contract.
