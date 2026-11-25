const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { computeChangeReviewPreview, isReviewableToolName } = require('../dist/cjs/review/preview.js');
const { createPerChangeReviewExtension } = require('../dist/cjs/review/extension.js');

let cachedCreateEditToolDefinition;
async function getPreviewOptions() {
  if (!cachedCreateEditToolDefinition) {
    const sdk = await import('@earendil-works/pi-coding-agent');
    cachedCreateEditToolDefinition = sdk.createEditToolDefinition;
  }
  return { createEditToolDefinition: cachedCreateEditToolDefinition };
}

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tauren-review-test-'));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function createFakePi() {
  const handlers = new Map();
  const sentMessages = [];
  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async sendUserMessage(content, options) {
      sentMessages.push({ content, options });
    }
  };

  async function emit(eventName, event, ctx) {
    const list = handlers.get(eventName) ?? [];
    let result;
    for (const handler of list) {
      result = await handler(event, ctx);
    }
    return result;
  }

  return { pi, emit, sentMessages };
}

function computeTestHashTag(lineNumber, lineText) {
  const chars = 'ZPMQVRWSNKTXJBYH';
  const normalized = lineText.replace(/\r$/, '').replace(/^\uFEFF/, '').replace(/\s+/g, '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const byte = (hash >>> 0) & 0xff;
  return `${lineNumber}#${chars[byte >>> 4]}${chars[byte & 0x0f]}`;
}

test('isReviewableToolName identifies file-modifying tools only', () => {
  assert.equal(isReviewableToolName('edit'), true);
  assert.equal(isReviewableToolName('write'), true);
  assert.equal(isReviewableToolName('hashline_edit'), true);
  assert.equal(isReviewableToolName('bash'), false);
  assert.equal(isReviewableToolName('read'), false);
});

test('computeChangeReviewPreview handles edit normal match, multi-edit, and legacy input via Pi edit tool', () =>
  withTempDir(async (dir) => {
    const previewOptions = await getPreviewOptions();
    const filePath = path.join(dir, 'app.ts');
    const original = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
    writeFileSync(filePath, original, 'utf-8');

    const single = await computeChangeReviewPreview(
      'edit',
      { path: 'app.ts', edits: [{ oldText: 'const b = 2;', newText: 'const b = 20;' }] },
      dir,
      previewOptions
    );
    assert.ok(single);
    assert.equal(single.toolName, 'edit');
    assert.equal(single.path, 'app.ts');
    assert.equal(single.absolutePath, filePath);
    assert.equal(single.isNewFile, false);
    assert.equal(single.beforeText, original);
    assert.equal(single.afterText, 'const a = 1;\nconst b = 20;\nconst c = 3;\n');

    const multi = await computeChangeReviewPreview(
      'edit',
      {
        path: 'app.ts',
        edits: [
          { oldText: 'const a = 1;', newText: 'const a = 10;' },
          { oldText: 'const c = 3;', newText: 'const c = 30;' }
        ]
      },
      dir,
      previewOptions
    );
    assert.ok(multi);
    assert.equal(multi.afterText, 'const a = 10;\nconst b = 2;\nconst c = 30;\n');

    const legacy = await computeChangeReviewPreview(
      'edit',
      { path: '@app.ts', oldText: 'const a = 1;', newText: 'const a = 99;' },
      dir,
      previewOptions
    );
    assert.ok(legacy);
    assert.equal(legacy.path, 'app.ts');
    assert.equal(legacy.afterText, 'const a = 99;\nconst b = 2;\nconst c = 3;\n');

    // Dry-run preview must never modify the file on disk.
    assert.equal(readFileSync(filePath, 'utf-8'), original);
  }));

test('computeChangeReviewPreview handles edit fuzzy match, BOM, and CRLF line endings via Pi edit tool', () =>
  withTempDir(async (dir) => {
    const previewOptions = await getPreviewOptions();
    const filePath = path.join(dir, 'crlf.txt');
    const original = '\uFEFFfirst line  \r\nhello \u201Cworld\u201D  \r\nthird line\r\n';
    writeFileSync(filePath, original, 'utf-8');

    const preview = await computeChangeReviewPreview(
      'edit',
      {
        path: 'crlf.txt',
        edits: [{ oldText: 'hello "world"', newText: 'hello "tauren"' }]
      },
      dir,
      previewOptions
    );
    assert.ok(preview);
    assert.equal(preview.beforeText, 'first line  \nhello \u201Cworld\u201D  \nthird line\n');
    assert.equal(preview.afterText, 'first line  \nhello "tauren"\nthird line\n');
    assert.equal(readFileSync(filePath, 'utf-8'), original);
  }));

test('computeChangeReviewPreview skips invalid edit inputs and binary files', () =>
  withTempDir(async (dir) => {
    const previewOptions = await getPreviewOptions();
    const filePath = path.join(dir, 'dup.ts');
    writeFileSync(filePath, 'dup();\ndup();\n', 'utf-8');

    // Missing file
    assert.equal(
      await computeChangeReviewPreview('edit', { path: 'missing.ts', edits: [{ oldText: 'a', newText: 'b' }] }, dir, previewOptions),
      undefined
    );
    // Non-matching oldText
    assert.equal(
      await computeChangeReviewPreview('edit', { path: 'dup.ts', edits: [{ oldText: 'nope()', newText: 'x()' }] }, dir, previewOptions),
      undefined
    );
    // Duplicate match
    assert.equal(
      await computeChangeReviewPreview('edit', { path: 'dup.ts', edits: [{ oldText: 'dup();', newText: 'ok();' }] }, dir, previewOptions),
      undefined
    );
    // Overlapping edits
    const overlapPath = path.join(dir, 'overlap.ts');
    writeFileSync(overlapPath, 'abcdef\n', 'utf-8');
    assert.equal(
      await computeChangeReviewPreview(
        'edit',
        {
          path: 'overlap.ts',
          edits: [
            { oldText: 'abcd', newText: '1234' },
            { oldText: 'cdef', newText: '5678' }
          ]
        },
        dir,
        previewOptions
      ),
      undefined
    );
    // No-op replacement
    assert.equal(
      await computeChangeReviewPreview('edit', { path: 'overlap.ts', edits: [{ oldText: 'abcdef', newText: 'abcdef' }] }, dir, previewOptions),
      undefined
    );
    // Binary file
    const binPath = path.join(dir, 'blob.bin');
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62]));
    assert.equal(
      await computeChangeReviewPreview('edit', { path: 'blob.bin', edits: [{ oldText: 'ab', newText: 'cd' }] }, dir, previewOptions),
      undefined
    );
  }));

test('computeChangeReviewPreview handles write for new and existing files', () =>
  withTempDir(async (dir) => {
    const previewOptions = await getPreviewOptions();
    const newPreview = await computeChangeReviewPreview(
      'write',
      { path: 'nested/new.ts', content: 'export const x = 1;\r\n' },
      dir,
      previewOptions
    );
    assert.ok(newPreview);
    assert.equal(newPreview.toolName, 'write');
    assert.equal(newPreview.path, 'nested/new.ts');
    assert.equal(newPreview.isNewFile, true);
    assert.equal(newPreview.beforeText, '');
    assert.equal(newPreview.afterText, 'export const x = 1;\n');

    const existingPath = path.join(dir, 'existing.ts');
    writeFileSync(existingPath, '\uFEFFold line\r\n', 'utf-8');
    const overwritePreview = await computeChangeReviewPreview(
      'write',
      { path: 'existing.ts', content: 'new line\n' },
      dir,
      previewOptions
    );
    assert.ok(overwritePreview);
    assert.equal(overwritePreview.isNewFile, false);
    assert.equal(overwritePreview.beforeText, 'old line\n');
    assert.equal(overwritePreview.afterText, 'new line\n');

    // Image extension skipped
    assert.equal(
      await computeChangeReviewPreview('write', { path: 'icon.png', content: 'fake' }, dir, previewOptions),
      undefined
    );
  }));

test('computeChangeReviewPreview handles hashline_edit valid and invalid tags', () =>
  withTempDir(async (dir) => {
    const previewOptions = await getPreviewOptions();
    const filePath = path.join(dir, 'lines.txt');
    writeFileSync(filePath, 'alpha\nbeta\ngamma', 'utf-8');

    const tag2 = computeTestHashTag(2, 'beta');
    const valid = await computeChangeReviewPreview(
      'hashline_edit',
      {
        path: 'lines.txt',
        operations: [{ op: 'replace_range', start: tag2, end: tag2, content: 'BETA' }]
      },
      dir,
      previewOptions
    );
    assert.ok(valid);
    assert.equal(valid.beforeText, 'alpha\nbeta\ngamma');
    assert.equal(valid.afterText, 'alpha\nBETA\ngamma');

    // Mismatched hash skips review
    const invalid = await computeChangeReviewPreview(
      'hashline_edit',
      {
        path: 'lines.txt',
        operations: [{ op: 'replace_range', start: '2#ZZ', end: '2#ZZ', content: 'BETA' }]
      },
      dir,
      previewOptions
    );
    assert.equal(invalid, undefined);
  }));

test('createPerChangeReviewExtension maps approve, approve_session, reject, steer, and cancel', () =>
  withTempDir(async (dir) => {
    const { createEditToolDefinition } = await getPreviewOptions();
    const filePath = path.join(dir, 'sample.ts');
    writeFileSync(filePath, 'const value = 1;\n', 'utf-8');

    let enabled = true;
    let nextDecision = { action: 'approve' };
    const seenRequests = [];
    const autoApproveChanges = [];

    const { pi, emit, sentMessages } = createFakePi();
    const factory = createPerChangeReviewExtension({
      isEnabled: () => enabled,
      createEditToolDefinition,
      reviewChange: async (request) => {
        seenRequests.push(request);
        return nextDecision;
      },
      onSessionAutoApproveChange: (value) => autoApproveChanges.push(value)
    });
    factory(pi);

    const editEvent = {
      type: 'tool_call',
      toolCallId: 'call-1',
      toolName: 'edit',
      input: { path: 'sample.ts', edits: [{ oldText: 'const value = 1;', newText: 'const value = 2;' }] }
    };
    const ctx = { cwd: dir };

    // Disabled skips review
    enabled = false;
    assert.equal(await emit('tool_call', editEvent, ctx), undefined);
    assert.equal(seenRequests.length, 0);

    // Non-reviewable tool skips review
    enabled = true;
    assert.equal(await emit('tool_call', { type: 'tool_call', toolCallId: 'call-bash', toolName: 'bash', input: { command: 'ls' } }, ctx), undefined);
    assert.equal(seenRequests.length, 0);

    // Approve allows tool
    nextDecision = { action: 'approve' };
    assert.equal(await emit('tool_call', editEvent, ctx), undefined);
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0].toolCallId, 'call-1');

    // Reject blocks tool
    nextDecision = { action: 'reject', reason: 'Keep value = 1' };
    const rejected = await emit('tool_call', editEvent, ctx);
    assert.deepEqual(rejected, { block: true, reason: 'Keep value = 1' });

    // Steer blocks tool and sends steer message
    nextDecision = { action: 'steer', feedback: 'Use a constant named answer = 42' };
    const steered = await emit('tool_call', editEvent, ctx);
    assert.equal(steered.block, true);
    assert.match(steered.reason, /Use a constant named answer = 42/);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].options.deliverAs, 'steer');
    assert.match(sentMessages[0].content, /Use a constant named answer = 42/);

    // Cancel blocks tool without steering
    nextDecision = { action: 'cancel' };
    const cancelled = await emit('tool_call', editEvent, ctx);
    assert.equal(cancelled.block, true);
    assert.match(cancelled.reason, /Cancelled diff review/);
    assert.equal(sentMessages.length, 1);

    // Approve session allows current and skips subsequent until session_start
    const countBefore = seenRequests.length;
    nextDecision = { action: 'approve_session' };
    assert.equal(await emit('tool_call', editEvent, ctx), undefined);
    assert.equal(seenRequests.length, countBefore + 1);
    assert.deepEqual(autoApproveChanges, [true]);

    // Subsequent edit is auto-approved without calling reviewChange
    assert.equal(await emit('tool_call', editEvent, ctx), undefined);
    assert.equal(seenRequests.length, countBefore + 1);

    // session_start resets session auto-approve
    await emit('session_start', { type: 'session_start' }, ctx);
    assert.deepEqual(autoApproveChanges, [true, false]);
    nextDecision = { action: 'approve' };
    assert.equal(await emit('tool_call', editEvent, ctx), undefined);
    assert.equal(seenRequests.length, countBefore + 2);
  }));

test('createPerChangeReviewExtension aborts in-flight review when AbortSignal fires', () =>
  withTempDir(async (dir) => {
    const { createEditToolDefinition } = await getPreviewOptions();
    const filePath = path.join(dir, 'abort.ts');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const abortController = new AbortController();
    const { pi, emit } = createFakePi();

    const factory = createPerChangeReviewExtension({
      isEnabled: () => true,
      createEditToolDefinition,
      getAbortSignal: () => abortController.signal,
      reviewChange: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true });
        })
    });
    factory(pi);

    const event = {
      type: 'tool_call',
      toolCallId: 'call-abort',
      toolName: 'edit',
      input: { path: 'abort.ts', edits: [{ oldText: 'const x = 1;', newText: 'const x = 2;' }] }
    };

    const pending = emit('tool_call', event, { cwd: dir });
    abortController.abort();
    const result = await pending;
    assert.equal(result.block, true);
    assert.match(result.reason, /Cancelled diff review/);

    // Subsequent call with already-aborted signal blocks immediately
    const preAborted = await emit('tool_call', event, { cwd: dir });
    assert.equal(preAborted.block, true);
    assert.match(preAborted.reason, /Cancelled diff review/);
  }));
