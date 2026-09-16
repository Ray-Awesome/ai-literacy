import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginSave,
  canSend,
  createEditorState,
  markDirty,
  resolveSaveFailure,
  resolveSaveSuccess,
} from '../../js/admin-editorial-state.js';

function draft(id = 12, subject = '초안') {
  return { id, subject, previewText: '미리보기', blocks: [{ id: 'p1', type: 'paragraph', data: { text: '본문' } }], status: 'draft' };
}

test('autosave success preserves edits made after its submitted snapshot and requests a follow-up save', () => {
  const editor = createEditorState(draft(), 'draft-12');
  markDirty(editor);
  const operation = beginSave(editor);
  editor.draft.subject = '더 새로운 제목';
  markDirty(editor);

  const result = resolveSaveSuccess(editor, operation, draft(12, '오래된 제목'));
  assert.equal(result.accepted, true);
  assert.equal(result.shouldFlush, true);
  assert.equal(editor.draft.subject, '더 새로운 제목');
  assert.equal(editor.dirty, true);
  assert.equal(editor.saving, false);
});

test('a stale save response cannot change a newly opened draft', () => {
  const oldEditor = createEditorState(draft(12), 'draft-12');
  markDirty(oldEditor);
  const operation = beginSave(oldEditor);
  const currentEditor = createEditorState(draft(13, '다른 초안'), 'draft-13');

  const result = resolveSaveSuccess(currentEditor, operation, draft(12, '오래된 응답'));
  assert.equal(result.accepted, false);
  assert.equal(currentEditor.draft.id, 13);
  assert.equal(currentEditor.draft.subject, '다른 초안');
});

test('a failed save remains dirty and exposes an explicit retryable state', () => {
  const editor = createEditorState(draft(), 'draft-12');
  markDirty(editor);
  const operation = beginSave(editor);
  const result = resolveSaveFailure(editor, operation, '저장 실패');

  assert.equal(result.accepted, true);
  assert.equal(editor.dirty, true);
  assert.equal(editor.saving, false);
  assert.equal(editor.saveStatus, 'error');
  assert.equal(editor.error, '저장 실패');
});

test('send actions are immediately blocked for dirty, saving, non-draft, or invalid editor state', () => {
  const editor = createEditorState(draft(), 'draft-12');
  assert.equal(canSend(editor, true), true);
  markDirty(editor);
  assert.equal(canSend(editor, true), false);
  const operation = beginSave(editor);
  assert.equal(canSend(editor, true), false);
  resolveSaveSuccess(editor, operation, draft());
  assert.equal(canSend(editor, false), false);
  editor.draft.status = 'sending';
  assert.equal(canSend(editor, true), false);
});
