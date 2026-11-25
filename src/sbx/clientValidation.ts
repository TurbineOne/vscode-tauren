import { ErrorCodes, ResponseError, type ChangeReviewRequest } from '@tauren/shared/sbx/protocol';
import type * as Pi from '../pi/types';
import type { ComposerCompletionApplied, ComposerCompletionCapabilities, ComposerCompletionResult } from '@tauren/shared/completion/types';
import type { WebviewTreeItem } from '../webviewProtocol/types';

type Check = (value: unknown) => void;
type Shape = Record<string, Check>;
const invalid = (): never => { throw new Error('Invalid sandbox response'); };
const string: Check = value => { if (typeof value !== 'string') invalid(); };
const boolean: Check = value => { if (typeof value !== 'boolean') invalid(); };
const number: Check = value => { if (typeof value !== 'number' || !Number.isFinite(value)) invalid(); };
const integer: Check = value => { if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(); };
const optional = (check: Check): Check => value => { if (value !== undefined) check(value); };
const nullable = (check: Check): Check => value => { if (value !== null) check(value); };
const array = (check: Check): Check => value => {
  if (!Array.isArray(value)) invalid();
  for (const item of value as unknown[]) check(item);
};
const enumeration = (...values: string[]): Check => value => { if (!values.includes(value as string)) invalid(); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
const shape = (required: Shape = {}, fields: Shape = {}): Check => value => {
  const record = object(value);
  for (const [key, check] of Object.entries(required)) check(record[key]);
  for (const [key, check] of Object.entries(fields)) optional(check)(record[key]);
};
const fields = (check: Check, keys: string): Shape => Object.fromEntries(keys.split(' ').map(key => [key, check]));
/** Never include untrusted payloads (including credentials) in validation errors.
 * Unknown SDK/extension fields are deliberately retained, not projected away.
 */
function decode<T>(value: unknown, check: Check): T {
  try { check(value); return value as T; } catch { return invalid(); }
}
const model = shape({}, { ...fields(string, 'provider id name'), reasoning: boolean, contextWindow: number });
const rendered = shape({ body: string }, { expandedBody: string, code: boolean });
const compact = shape({}, { ...fields(string, 'summary firstKeptEntryId'), ...fields(number, 'tokensBefore estimatedTokensAfter') });
const message = shape({}, {
  ...fields(string, 'role customType errorMessage summary toolCallId toolName'),
  ...fields(number, 'tokensBefore estimatedTokensAfter'), isError: boolean, taurenRenderedMessage: rendered
});
const state = shape({}, {
  model: nullable(model),
  ...fields(string, 'thinkingLevel steeringMode followUpMode sessionFile sessionId sessionName defaultProvider defaultModel defaultThinkingLevel transport activePersonaLabel'),
  ...fields(boolean, 'isStreaming isCompacting autoCompactionEnabled autoRetryEnabled hideThinkingBlock quietStartup imageAutoResize blockImages enableSkillCommands'),
  enabledModels: array(string), ...fields(number, 'messageCount pendingMessageCount')
});
const stats = shape({}, {
  ...fields(string, 'sessionFile sessionId sessionName'),
  ...fields(number, 'userMessages assistantMessages toolCalls toolResults totalMessages cost'),
  ...fields(boolean, 'usingSubscription autoCompactionEnabled'),
  tokens: shape({}, fields(number, 'input output cacheRead cacheWrite total')),
  contextUsage: shape({}, { tokens: nullable(number), contextWindow: number, percent: nullable(number) })
});
const command = shape({}, fields(string, 'name description source location path'));
const authType = enumeration('oauth', 'api_key');
const provider = shape({ id: string, name: string, authType, configured: boolean, canLogout: boolean }, {
  source: enumeration('stored', 'runtime', 'environment', 'fallback', 'models_json_key', 'models_json_command'),
  label: string, storedCredentialType: authType, usesCallbackServer: boolean
});
const treeItem = shape({ entryId: string, role: string, text: string, current: boolean }, {
  ...fields(string, 'parentId label labelTimestamp prefix'), depth: integer,
  ...fields(boolean, 'isLast activePath selectable'), ancestorContinues: array(boolean)
});
const capabilities = shape({ triggerCharacters: array(string), generation: integer });
const completionResult = shape({
  id: string, revision: integer, capabilities,
  items: array(shape({ id: string, value: string, label: string }, { description: string }))
});
const completionApplied: Check = value => {
  shape({ id: string, revision: integer, text: string, selectionStart: integer, selectionEnd: integer })(value);
  const result = value as ComposerCompletionApplied;
  if (result.selectionStart > result.selectionEnd || result.selectionEnd > result.text.length) invalid();
};

export const validateState = (value: unknown): Pi.PiSessionState => decode(value, state);
export const validateStats = (value: unknown): Pi.PiSessionStats => decode(value, stats);
export const validateModel = (value: unknown): Pi.PiModel => decode(value, model);
export const validateModels = (value: unknown): Pi.PiAvailableModels => decode(value, shape({}, { models: array(model) }));
export const validateCommands = (value: unknown): Pi.PiAvailableCommands => decode(value, shape({}, { commands: array(command) }));
export const validateStartupResources = (value: unknown): Pi.PiStartupResources => decode(value,
  shape({}, { sections: array(shape({ name: string, items: array(string) })) }));
export const validateAuthProviders = (value: unknown): Pi.PiAuthProvidersResult => decode(value, shape({ providers: array(provider) }));
export const validateCompact = (value: unknown): Pi.PiCompactResult => decode(value, compact);
export const validateExport = (value: unknown): { path: string; html: string } => decode(value, shape({ path: string, html: string }));
export const validateLastAssistantText = (value: unknown): Pi.PiLastAssistantText => decode(value, shape({}, { text: nullable(string) }));
export const validateMessages = (value: unknown): Pi.PiMessagesResult => decode(value, shape({}, { messages: array(message) }));
export const validateSessionResult = (value: unknown): Pi.PiNavigateTreeResult & Pi.PiForkResult => decode(value,
  shape({}, { ...fields(boolean, 'cancelled aborted'), ...fields(string, 'text editorText') }));
export const validateTree = (value: unknown): WebviewTreeItem[] => decode(value, array(treeItem));
export const validateForkMessages = (value: unknown): Pi.PiForkMessagesResult => decode(value,
  shape({}, { messages: array(shape({}, fields(string, 'entryId text'))) }));
export const validateCompletionCapabilities = (value: unknown): ComposerCompletionCapabilities => decode(value, capabilities);
export const validateCompletionResult = (value: unknown): ComposerCompletionResult => decode(value, completionResult);
// JSON-RPC encodes an absent application as null, rather than undefined.
export const validateCompletionApplied = (value: unknown): ComposerCompletionApplied | undefined =>
  value === null || value === undefined ? undefined : decode(value, completionApplied);

export function validateEventEnvelope(value: unknown, previousSequence: number): { sequence: number; event: Pi.PiEvent } {
  return decode(value, envelope => {
    // EventParams in shared/src/sbx/contract.ts supplies the envelope, and PiEventBase
    // in src/pi/types.ts requires an event type string. We also require the sequence
    // to be a nonnegative safe integer so JavaScript can compare it exactly.
    shape({ sequence: integer, event: shape({ type: string }) })(envelope);
    const { sequence, event } = envelope as { sequence: number; event: Pi.PiEvent };
    // The notification contract orders events per connection. Reject duplicates and
    // older numbers, but allow gaps. SbxClient resets previousSequence on reconnect.
    if (sequence <= previousSequence) invalid();
    // Check optional metadata against the known event types and PiRenderedContent
    // in src/pi/types.ts. Its UnknownPiEvent permits additional event types and fields,
    // so this check preserves them and leaves arbitrary tool arguments/results intact.
    shape({}, {
      ...fields(string, 'toolCallId toolName extensionPath error errorMessage'),
      ...fields(boolean, 'isError aborted willRetry success'), taurenRenderedTool: rendered
    })(event);
    // These payload names come from the corresponding event types in src/pi/types.ts.
    // Message payloads are typed as unknown there; this adapter additionally checks
    // their known message fields using the shared message validator above. Compaction
    // uses PiCompactResult and may be null. All of these payloads remain optional.
    if (event.type === 'message_start' || event.type === 'message_end') optional(message)(event.message);
    if (event.type === 'agent_end') optional(array(message))(event.messages);
    if (event.type === 'turn_end') optional(array(message))(event.toolResults);
    if (event.type === 'compaction_end') optional(nullable(compact))(event.result);
  });
}

const allowedReviewKeys = new Set([
  'toolCallId', 'toolName', 'path', 'absolutePath', 'beforeText', 'afterText', 'isNewFile'
]);

function failReviewRequest(): never {
  throw new ResponseError(ErrorCodes.InvalidParams, 'Invalid sandbox change review parameters');
}

export function validateChangeReviewRequest(value: unknown): ChangeReviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failReviewRequest();
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowedReviewKeys.has(key)) {
      failReviewRequest();
    }
  }

  if (typeof record.toolCallId !== 'string' || !record.toolCallId) {
    failReviewRequest();
  }
  if (record.toolName !== 'edit' && record.toolName !== 'write' && record.toolName !== 'hashline_edit') {
    failReviewRequest();
  }
  if (typeof record.path !== 'string' || !record.path.trim() || record.path.includes('\0')) {
    failReviewRequest();
  }
  if (typeof record.absolutePath !== 'string' || !record.absolutePath.trim() || record.absolutePath.includes('\0')) {
    failReviewRequest();
  }
  if (typeof record.beforeText !== 'string' || typeof record.afterText !== 'string') {
    failReviewRequest();
  }
  if (typeof record.isNewFile !== 'boolean') {
    failReviewRequest();
  }

  return {
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    path: record.path,
    absolutePath: record.absolutePath,
    beforeText: record.beforeText,
    afterText: record.afterText,
    isNewFile: record.isNewFile
  };
}
