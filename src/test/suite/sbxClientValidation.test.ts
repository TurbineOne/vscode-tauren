import * as assert from 'node:assert/strict';
import * as validate from '../../sbx/clientValidation';

suite('sbx client payload validation', () => {
  const rejects = (decode: (value: unknown) => unknown, value: unknown): void => {
    assert.throws(() => decode(value), { name: 'Error', message: 'Invalid sandbox response' });
  };

  test('all object results reject invalid roots without exposing payloads', () => {
    const decoders = [validate.validateState, validate.validateStats, validate.validateModel, validate.validateModels,
      validate.validateCommands, validate.validateStartupResources, validate.validateAuthProviders, validate.validateCompact,
      validate.validateExport, validate.validateLastAssistantText, validate.validateMessages, validate.validateSessionResult,
      validate.validateForkMessages, validate.validateCompletionCapabilities, validate.validateCompletionResult];
    for (const decode of decoders) {
      for (const value of [undefined, null, [], 'secret-token', 42, true]) rejects(decode, value);
    }
  });

  test('validates optional state and model fields recursively', () => {
    const state = { model: { provider: 'p', id: 'm', name: 'Model', reasoning: true, contextWindow: 1000 },
      enabledModels: ['p/m'], sessionFile: '/remote/session.jsonl', isStreaming: false, pendingMessageCount: 0 };
    assert.equal(validate.validateState(state), state);
    assert.deepEqual(validate.validateState({ model: null }), { model: null });
    assert.deepEqual(validate.validateState({}), {});
    for (const value of [{ model: [] }, { model: { reasoning: 'yes' } }, { model: { contextWindow: Infinity } },
      { enabledModels: ['ok', 1] }, { sessionFile: null }, { isStreaming: 1 }, { pendingMessageCount: NaN }]) {
      rejects(validate.validateState, value);
    }
    rejects(validate.validateModels, { models: [{ id: 1 }] });
    assert.deepEqual(validate.validateModels({ models: [{ id: 'm' }] }), { models: [{ id: 'm' }] });
  });

  test('validates nested statistics, commands and startup resources', () => {
    const stats = { tokens: { input: 12, output: 1 }, cost: 0.5, contextUsage: { tokens: null, percent: null, contextWindow: 100 } };
    assert.equal(validate.validateStats(stats), stats);
    for (const value of [{ tokens: { input: 'secret-token' } }, { contextUsage: { percent: false } }, { cost: Infinity }]) {
      rejects(validate.validateStats, value);
    }
    const commands = { commands: [{ name: 'test', sourceInfo: { extension: 'plugin' } }] };
    assert.equal(validate.validateCommands(commands), commands);
    rejects(validate.validateCommands, { commands: [{ path: 123 }] });
    const resources = { sections: [{ name: 'Skills', items: ['skill'] }] };
    assert.equal(validate.validateStartupResources(resources), resources);
    for (const value of [{ sections: [{}] }, { sections: [{ name: 'Skills', items: [false] }] }]) {
      rejects(validate.validateStartupResources, value);
    }
  });

  test('validates required auth fields and closed auth enumerations', () => {
    const provider = { id: 'p', name: 'Provider', authType: 'oauth', configured: true, canLogout: false,
      source: 'environment', storedCredentialType: 'api_key', usesCallbackServer: false };
    const result = { providers: [provider] };
    assert.equal(validate.validateAuthProviders(result), result);
    rejects(validate.validateAuthProviders, {});
    for (const patch of [{ id: undefined }, { authType: 'other' }, { configured: 'yes' }, { canLogout: undefined },
      { source: 'other' }, { storedCredentialType: false }, { usesCallbackServer: 1 }]) {
      rejects(validate.validateAuthProviders, { providers: [{ ...provider, ...patch }] });
    }
  });

  test('preserves enriched tool/custom messages and opaque extension content', () => {
    const messages = { messages: [{ role: 'custom', customType: 'plugin', display: { custom: true },
      content: [{ type: 'extension-content', value: { arbitrary: [1, null] } }], details: { plugin: true },
      taurenRenderedMessage: { body: 'rendered', expandedBody: 'expanded', code: false }, futureField: 'retained' },
    { role: 'toolResult', toolName: 'bash', toolCallId: 'call', isError: false }] };
    assert.equal(validate.validateMessages(messages), messages);
    for (const message of [{ role: 1 }, { toolName: false }, { isError: 'no' },
      { taurenRenderedMessage: {} }, { taurenRenderedMessage: { body: 'ok', code: 'yes' } }]) {
      rejects(validate.validateMessages, { messages: [message] });
    }
  });

  test('validates compact, export, assistant and session mutation results', () => {
    const compact = { summary: 'summary', tokensBefore: 10, details: { plugin: true } };
    assert.equal(validate.validateCompact(compact), compact);
    rejects(validate.validateCompact, { estimatedTokensAfter: 'ten' });
    const exported = { path: '/remote/export.html', html: '<html></html>' };
    assert.equal(validate.validateExport(exported), exported);
    for (const value of [{}, { path: 'file' }, { path: 'file', html: null }]) rejects(validate.validateExport, value);
    assert.deepEqual(validate.validateLastAssistantText({ text: null }), { text: null });
    rejects(validate.validateLastAssistantText, { text: false });
    const mutation = { cancelled: false, aborted: true, text: 'fork', editorText: 'navigation' };
    assert.equal(validate.validateSessionResult(mutation), mutation);
    rejects(validate.validateSessionResult, { cancelled: 'yes' });
    rejects(validate.validateSessionResult, { editorText: [] });
    assert.deepEqual(validate.validateForkMessages({ messages: [{ entryId: '1', text: 'fork' }] }),
      { messages: [{ entryId: '1', text: 'fork' }] });
    rejects(validate.validateForkMessages, { messages: [{ entryId: 123 }] });
  });

  test('validates tree fields without stripping lane rendering metadata', () => {
    const tree = [{ entryId: 'e', role: 'user', text: 'hello', current: true, depth: 0, ancestorContinues: [true, false],
      activePath: true, selectable: false, label: 'label', prefix: 'prefix' }];
    assert.equal(validate.validateTree(tree), tree);
    for (const value of [{}, [null], [{}], [{ ...tree[0], current: 'yes' }], [{ ...tree[0], depth: -1 }],
      [{ ...tree[0], ancestorContinues: [0] }], [{ ...tree[0], labelTimestamp: 1 }]]) rejects(validate.validateTree, value);
  });

  test('validates completion structures and absent application wire results', () => {
    const capabilities = { triggerCharacters: ['/', '@'], generation: 2 };
    const result = { id: 'request', revision: 1, items: [{ id: 'item', label: 'Label', value: 'value', description: 'desc' }], capabilities };
    assert.equal(validate.validateCompletionCapabilities(capabilities), capabilities);
    assert.equal(validate.validateCompletionResult(result), result);
    for (const generation of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      rejects(validate.validateCompletionCapabilities, { ...capabilities, generation });
    }
    rejects(validate.validateCompletionCapabilities, { triggerCharacters: [1], generation: 1 });
    rejects(validate.validateCompletionResult, { ...result, items: [{ id: 'item', label: 'Label' }] });
    rejects(validate.validateCompletionResult, { ...result, revision: '1' });
    const applied = { id: 'r', revision: 0, text: 'hello', selectionStart: 1, selectionEnd: 5 };
    assert.equal(validate.validateCompletionApplied(applied), applied);
    assert.equal(validate.validateCompletionApplied(null), undefined);
    assert.equal(validate.validateCompletionApplied(undefined), undefined);
    for (const patch of [{ selectionStart: -1 }, { selectionEnd: 6 }, { selectionStart: 4, selectionEnd: 2 }, { text: false }]) {
      rejects(validate.validateCompletionApplied, { ...applied, ...patch });
    }
  });

  test('requires nonnegative safe strictly increasing event sequences and string event types', () => {
    const decode = (value: unknown) => validate.validateEventEnvelope(value, 4);
    const envelope = { sequence: 6, event: { type: 'future_sdk_event', payload: { custom: true } } };
    assert.equal(decode(envelope), envelope);
    assert.equal(validate.validateEventEnvelope({ sequence: 0, event: { type: 'agent_start' } }, -1).sequence, 0);
    for (const sequence of [-1, 0, 4, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '5']) {
      rejects(decode, { sequence, event: { type: 'agent_start' } });
    }
    for (const value of [null, [], {}, { sequence: 5 }, { sequence: 5, event: [] }, { sequence: 5, event: { type: 7 } }]) {
      rejects(decode, value);
    }
  });

  test('checks known event properties while preserving server enrichments', () => {
    const decode = (value: unknown) => validate.validateEventEnvelope({ sequence: 1, event: value }, 0);
    const event = { type: 'tool_execution_end', toolName: 'bash', toolCallId: 'c', isError: false,
      result: { arbitrary: true }, taurenRenderedTool: { body: 'output', expandedBody: 'full', code: true } };
    assert.equal(decode(event).event, event);
    decode({ type: 'message_end', message: { role: 'custom', customType: 'plugin', taurenRenderedMessage: { body: 'rendered' } } });
    decode({ type: 'compaction_end', result: null });
    for (const event of [{ type: 'tool_execution_end', toolCallId: 2 },
      { type: 'tool_execution_update', taurenRenderedTool: { body: false } },
      { type: 'message_end', message: { taurenRenderedMessage: { code: true } } },
      { type: 'agent_end', messages: [{ role: false }] }, { type: 'turn_end', toolResults: [null] },
      { type: 'compaction_end', result: { tokensBefore: 'bad' } }, { type: 'auto_retry_end', success: 'yes' }]) rejects(decode, event);
  });

  test('validates incoming sandbox change review requests strictly', () => {
    const valid = {
      toolCallId: 'call-1',
      toolName: 'edit' as const,
      path: 'src/app.ts',
      absolutePath: '/workspace/src/app.ts',
      beforeText: 'a\n',
      afterText: 'b\n',
      isNewFile: false
    };
    assert.deepEqual(validate.validateChangeReviewRequest(valid), valid);
    for (const invalidValue of [
      null,
      [],
      { ...valid, extra: true },
      { ...valid, toolCallId: '' },
      { ...valid, toolName: 'bash' },
      { ...valid, path: '' },
      { ...valid, path: 'a\0b' },
      { ...valid, absolutePath: '' },
      { ...valid, beforeText: 42 },
      { ...valid, afterText: null },
      { ...valid, isNewFile: 'false' }
    ]) {
      assert.throws(
        () => validate.validateChangeReviewRequest(invalidValue),
        (err: unknown) => err instanceof Error && (err as { code?: number }).code === -32602
      );
    }
  });
});
