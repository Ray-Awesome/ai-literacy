function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createEditorState(draft, identity) {
  return {
    identity,
    draft: clone(draft),
    revision: 0,
    nextOperationId: 1,
    activeOperationId: null,
    activeRevision: null,
    dirty: false,
    saving: false,
    saveStatus: 'saved',
    error: '',
  };
}

export function markDirty(editor) {
  editor.revision += 1;
  editor.dirty = true;
  editor.error = '';
  if (!editor.saving) editor.saveStatus = 'waiting';
}

export function beginSave(editor) {
  if (!editor.dirty || editor.saving) return null;
  const operation = {
    id: editor.nextOperationId++,
    identity: editor.identity,
    draftId: editor.draft.id,
    revision: editor.revision,
    payload: {
      subject: editor.draft.subject,
      previewText: editor.draft.previewText,
      blocks: clone(editor.draft.blocks),
    },
  };
  editor.activeOperationId = operation.id;
  editor.activeRevision = operation.revision;
  editor.saving = true;
  editor.saveStatus = 'saving';
  editor.error = '';
  return operation;
}

function accepts(editor, operation) {
  return Boolean(operation)
    && editor.identity === operation.identity
    && editor.activeOperationId === operation.id;
}

export function resolveSaveSuccess(editor, operation, serverDraft) {
  if (!accepts(editor, operation)) return { accepted: false, shouldFlush: false };
  editor.activeOperationId = null;
  editor.activeRevision = null;
  editor.saving = false;
  if (editor.draft.id == null && Number.isSafeInteger(serverDraft?.id) && serverDraft.id > 0) editor.draft.id = serverDraft.id;
  if (operation.revision !== editor.revision) {
    editor.dirty = true;
    editor.saveStatus = 'waiting';
    return { accepted: true, shouldFlush: true };
  }
  editor.dirty = false;
  editor.saveStatus = 'saved';
  editor.error = '';
  return { accepted: true, shouldFlush: false };
}

export function resolveSaveFailure(editor, operation, error) {
  if (!accepts(editor, operation)) return { accepted: false };
  editor.activeOperationId = null;
  editor.activeRevision = null;
  editor.saving = false;
  editor.dirty = true;
  editor.saveStatus = 'error';
  editor.error = String(error || '저장하지 못했습니다.');
  return { accepted: true };
}

export function canSend(editor, isValid) {
  return Boolean(editor.draft.id)
    && editor.draft.status === 'draft'
    && !editor.dirty
    && !editor.saving
    && Boolean(isValid);
}

export function navigationPlan(editor, isValid) {
  if (!editor.dirty && !editor.saving) return { kind: 'leave' };
  if (!isValid || editor.saveStatus === 'error') return { kind: 'confirm-discard' };
  return { kind: 'save-before-leave' };
}
