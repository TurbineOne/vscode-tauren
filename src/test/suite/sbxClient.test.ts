import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SbxClient, SBX_CREDENTIAL_DOCUMENTATION, type SbxClientOptions } from '../../sbx/sbxClient';
import type { SandboxLifecycleOptions } from '../../sbx/lifecycle';
import type { PiEvent, PiOAuthLoginCallbacks } from '../../pi/types';
import type { MessageConnection } from '@tauren/shared/sbx/protocol';
import { createCancellingExtensionUi } from '../../extensionUi/types';

const root = path.resolve(__dirname, '../../..');
const launcher = path.join(root, 'src/test/fixtures/sbxClientServer.cjs');
const main = path.join(root, 'sandbox-server/dist/main.js');
const offlineProvider = path.join(root, 'sandbox-server/dist/test/fixtures/offline-provider.js');

async function bounded<T>(work: PromiseLike<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 15_000);
    })]);
  } finally { clearTimeout(timer); }
}

function eventLatch(client: SbxClient, predicate: (event: PiEvent) => boolean) {
  let unsubscribe = () => {};
  const promise = bounded(new Promise<PiEvent>(resolve => {
    unsubscribe = client.onEvent(event => { if (predicate(event)) resolve(event); });
  }), 'sandbox agent event').finally(() => unsubscribe());
  // A failed prompt must not leave an unhandled latch rejection during cleanup.
  void promise.catch(() => undefined);
  return promise;
}

async function idle(client: SbxClient): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await client.getState()).isStreaming) {
    assert.ok(Date.now() < deadline, 'SDK must leave streaming state');
    await delay(10);
  }
}

async function completeTurn(client: SbxClient, message: string): Promise<void> {
  const finished = eventLatch(client, event => event.type === 'agent_settled' || event.type === 'agent_end');
  await client.prompt(message);
  await finished;
  await idle(client);
}

/** Only finite SBX discovery/probe commands are replaced. SbxClient still owns
 * SandboxLifecycle -> SbxSshTransport -> child stdio JSON-RPC -> real SDK server.
 * The child resets environment BEFORE importing the SDK: no local credentials,
 * extensions, session-dir overrides, or network model calls can leak into tests.
 */
async function createFixture(mode = 'real') {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tauren-sbx-client-')));
  const workspace = path.join(directory, 'workspace with spaces');
  const agent = path.join(directory, 'agent');
  const clients: SbxClient[] = [];
  const connections: MessageConnection[] = [];
  const docs: string[] = [];
  const commands: string[][] = [];
  await Promise.all([workspace, agent].map(value => fs.mkdir(value)));
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify({
    defaultProvider: 'offline', defaultModel: 'scripted', extensions: [offlineProvider],
    compaction: { enabled: false }, retry: { enabled: false }
  }));
  // Additional ordinary extension exercises reverse UI requests over the real
  // connection, not a stubbed host-side bridge.
  const uiExtension = path.join(agent, 'ui.mjs');
  await fs.writeFile(uiExtension, `export default function(pi) {
    pi.registerCommand('fixture-ui', { description: 'UI fixture', handler: async (_, ctx) => {
      const selected = await ctx.ui.select('Pick fixture', ['first', 'second']);
      const input = await ctx.ui.input('Type fixture', 'placeholder');
      ctx.ui.notify('fixture-ui:' + selected + ':' + input, 'info');
    }});
  }`);
  const settings = JSON.parse(await fs.readFile(path.join(agent, 'settings.json'), 'utf8'));
  settings.extensions.push(uiExtension);
  await fs.writeFile(path.join(agent, 'settings.json'), JSON.stringify(settings));
  const lifecycle: SandboxLifecycleOptions = {
    workspace, storageRoot: path.join(directory, 'storage'), sandboxName: 'sbx-client-fixture',
    extensionDirectory: root, workspaceTrusted: true, clientVersion: '1.10.0',
    expectedServerVersion: '0.0.0', expectedPiVersion: '1.5.1',
    sshExecutable: process.execPath,
    sshArgs: [launcher, directory, main, mode, require.resolve('@tauren/shared/sbx/protocol')],
    timeouts: { startup: 10_000, handshake: 15_000, shutdown: 500, command: 2000 },
    runCommand: async command => {
      commands.push(command.args);
      if (command.args.at(-1)?.endsWith('else command -v node; fi')) return { stdout: process.execPath, stderr: '' };
      if (command.args[0] === '--version') return { stdout: 'sbx 0.51.3', stderr: '' };
      if (command.args[0] === 'ls') return { stdout: JSON.stringify([{ name: 'sbx-client-fixture' }]), stderr: '' };
      if (command.args[0] === 'inspect') return { stdout: JSON.stringify({ name: 'sbx-client-fixture', workspace }), stderr: '' };
      throw new Error(`Unexpected finite command: ${JSON.stringify(command)}`);
    },
    configureConnection: connection => { connections.push(connection); }
  };
  return {
    directory, workspace, lifecycle, docs, commands, connections,
    client(overrides: Partial<SbxClientOptions> = {}) {
      const client = new SbxClient({ lifecycle, showCredentialDocumentation: url => { docs.push(url); },
        requestTimeoutMs: 15_000, ...overrides });
      clients.push(client);
      return client;
    },
    async records(): Promise<Array<{ type: string; method?: string; params?: unknown; pid?: number }>> {
      try { return (await fs.readFile(path.join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    },
    async close() {
      await Promise.all(clients.map(client => bounded(client.closeSession(), 'client cleanup')));
      for (const client of clients) client.dispose();
      for (const connection of connections) connection.dispose();
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}

suite('SBX client offline integration', function () {
  this.timeout(60_000);

  test('streams real SDK echo and tools, preserving rpc input source and sandbox cwd', async () => {
    const fixture = await createFixture();
    try {
      const client = fixture.client();
      const events: PiEvent[] = [];
      const errors: string[] = [];
      client.onEvent(event => events.push(event));
      client.onError(error => errors.push(error));
      await completeTurn(client, 'source-check');
      const answer = (await client.getLastAssistantText()).text;
      assert.ok(answer?.includes('fixture: source-check [source=rpc;'));
      assert.ok(answer?.includes(`cwd=${fixture.workspace};processCwd=${fixture.workspace}`));
      assert.ok(events.some(event => event.type === 'message_update'));
      assert.ok(events.some(event => event.type === 'agent_start'));
      await completeTurn(client, 'tools-roundtrip');
      assert.equal(await fs.readFile(path.join(fixture.workspace, 'roundtrip.txt'), 'utf8'), 'after\n');
      const tools = events.filter(event => event.type === 'tool_execution_end');
      assert.deepEqual(tools.map(event => event.toolName), ['write', 'read', 'edit', 'read']);
      assert.ok(tools.every(event => !event.isError));
      assert.match(JSON.stringify(await client.getMessages()), /fixture: tools-roundtrip/);
      assert.deepEqual(errors, []);
    } finally { await fixture.close(); }
  });

  test('reads models/settings/resources and applies runtime changes through the server', async () => {
    const fixture = await createFixture();
    try {
      const client = fixture.client();
      assert.match(JSON.stringify(await client.getAvailableModels()), /scripted/);
      assert.match(JSON.stringify(await client.getCommands()), /offline-status/);
      assert.match(JSON.stringify(await client.getStartupResources()), /offline-provider/);
      const selected = await client.setModel('offline', 'alternate');
      assert.equal(selected.id, 'alternate');
      await client.setThinkingLevel('low');
      assert.equal((await client.updateRuntimeSetting('compaction.enabled', false)).applied, 'live');
      await client.setSessionName('SBX fixture session');
      const state = await client.getState();
      assert.equal(state.model?.id, 'alternate');
      assert.equal(state.thinkingLevel, 'low');
      assert.equal(state.autoCompactionEnabled, false);
      assert.equal(state.sessionName, 'SBX fixture session');
      await completeTurn(client, 'export fixture');
      const output = path.join(fixture.directory, 'host-export.html');
      assert.deepEqual(await client.exportHtml(output), { path: output });
      const html = await fs.readFile(output, 'utf8');
      assert.match(html, /<!DOCTYPE html>/i);
      const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/.exec(html)?.[1];
      assert.ok(encoded, 'SDK export embeds session data');
      assert.match(Buffer.from(encoded, 'base64').toString('utf8'), /export fixture/);
    } finally { await fixture.close(); }
  });

  test('restores persisted history with an explicit sessionFile and reconnects without replay', async () => {
    const fixture = await createFixture();
    try {
      const first = fixture.client();
      await completeTurn(first, 'first persisted prompt');
      const sessionFile = (await first.getState()).sessionFile;
      assert.ok(sessionFile);
      const messages = (await first.getMessages()).messages;
      assert.match(await fs.readFile(sessionFile, 'utf8'), /first persisted prompt/);
      await first.closeSession();
      const resumed = fixture.client({ sessionFile });
      const events: PiEvent[] = [];
      resumed.onEvent(event => events.push(event));
      assert.deepEqual((await resumed.getMessages()).messages, messages);
      assert.equal(events.some(event => event.type === 'agent_start'), false);
      const disconnected = bounded(new Promise<string>(resolve => resumed.onError(resolve)), 'disconnect notification');
      fixture.connections.at(-1)!.dispose();
      assert.match(await disconnected, /disconnect/i);
      const launches = (await fixture.records()).length;
      await assert.rejects(resumed.getMessages(), /reconnect|disconnect/i);
      await assert.rejects(resumed.prompt('MUST NOT REPLAY'), /reconnect|disconnect/i);
      assert.equal((await fixture.records()).length, launches, 'queries must not reopen automatically');
      await resumed.reconnect();
      assert.deepEqual((await resumed.getMessages()).messages, messages);
      assert.equal(events.some(event => event.type === 'agent_start'), false);
      await completeTurn(resumed, 'second persisted prompt');
      const restored = JSON.stringify(await resumed.getMessages());
      assert.doesNotMatch(restored, /MUST NOT REPLAY/);
      assert.equal((restored.match(/first persisted prompt/g) ?? []).length, 2, 'one user prompt and one assistant echo, no replay');
      assert.match(restored, /second persisted prompt/);
    } finally { await fixture.close(); }
  });

  test('separate clients own independent server processes and disposing one preserves the other', async () => {
    const fixture = await createFixture();
    try {
      const one = fixture.client(); const two = fixture.client();
      await Promise.all([one.getState(), two.getState()]);
      const launches = (await fixture.records()).filter(record => record.type === 'launch');
      assert.equal(new Set(launches.map(record => record.pid)).size, 2);
      one.dispose();
      await one.closeSession();
      await assert.rejects(one.getState(), /disposed/i);
      await completeTurn(two, 'still usable');
      assert.equal((await two.getLastAssistantText()).text, 'fixture: still usable');
      assert.equal(fixture.commands.some(args => args.some(arg => ['stop', 'rm', 'remove'].includes(arg))), false);
    } finally { await fixture.close(); }
  });

  test('handles extension select/input/notification through reverse UI RPC', async () => {
    const fixture = await createFixture();
    try {
      const calls: unknown[] = [];
      let notified!: (message: string) => void;
      const notification = bounded(new Promise<string>(resolve => { notified = resolve; }), 'UI notification');
      const client = fixture.client({ extensionUi: {
        ...createCancellingExtensionUi(message => notified(message)),
        select: async (title, options) => { calls.push([title, options]); return options[1]; },
        input: async (title, placeholder) => { calls.push([title, placeholder]); return 'typed'; }
      } });
      await client.prompt('/fixture-ui');
      assert.equal(await notification, 'fixture-ui:second:typed');
      assert.deepEqual(calls, [['Pick fixture', ['first', 'second']], ['Type fixture', 'placeholder']]);
    } finally { await fixture.close(); }
  });

  test('auth entrypoints only show credential documentation, never call callbacks or open a connection', async () => {
    const fixture = await createFixture();
    try {
      const client = fixture.client();
      const forbidden = () => { throw new Error('OAuth callback must not be called'); };
      const callbacks: PiOAuthLoginCallbacks = { onAuth: forbidden, onDeviceCode: forbidden,
        onPrompt: forbidden, onSelect: forbidden, onProgress: forbidden, onManualCodeInput: forbidden };
      await client.loginWithApiKey('offline', 'SECRET-MUST-NOT-LEAVE-HOST');
      await client.loginWithOAuth('offline', callbacks);
      await client.logoutAuthProvider('offline');
      assert.deepEqual(fixture.docs, Array(3).fill(SBX_CREDENTIAL_DOCUMENTATION));
      assert.deepEqual(fixture.commands, []);
      assert.deepEqual(await fixture.records(), []);
      await client.getState();
      await client.loginWithApiKey('offline', 'SECRET-MUST-NOT-LEAVE-HOST');
      assert.doesNotMatch(JSON.stringify(await fixture.records()), /SECRET-MUST-NOT-LEAVE-HOST|auth\.login/);
    } finally { await fixture.close(); }
  });

  test('labels tree entries, forks, clones, switches and navigates real persisted sessions', async () => {
    const fixture = await createFixture();
    try {
      const client = fixture.client();
      await completeTurn(client, 'predecessor');
      const predecessor = await client.getMessages();
      await completeTurn(client, 'selected turn');
      const original = (await client.getState()).sessionFile!;
      const originalHistory = await client.getMessages();
      const tree = await client.getSessionTree();
      const selected = tree.find(entry => entry.role === 'user' && entry.text === 'selected turn');
      const earlierAssistant = tree.find(entry => entry.role === 'assistant' && entry.text === 'fixture: predecessor');
      assert.ok(selected); assert.ok(earlierAssistant);
      await client.setTreeEntryLabel(selected.entryId, 'branch marker');
      assert.equal((await client.getSessionTree()).find(entry => entry.entryId === selected.entryId)?.label, 'branch marker');
      await client.setTreeEntryLabel(selected.entryId, undefined);
      assert.ok(!(await client.getSessionTree()).find(entry => entry.entryId === selected.entryId)?.label);
      assert.ok((await client.getForkMessages()).messages?.some(entry => entry.entryId === selected.entryId));
      const forked = await client.fork(selected.entryId);
      assert.notEqual(forked.cancelled, true);
      assert.equal(forked.text, 'selected turn');
      const forkPath = (await client.getState()).sessionFile;
      assert.notEqual(forkPath, original);
      assert.deepEqual(await client.getMessages(), predecessor);
      await completeTurn(client, 'fork continuation');
      const forkHistory = await client.getMessages();
      assert.notEqual((await client.clone()).cancelled, true);
      assert.notEqual((await client.getState()).sessionFile, forkPath);
      assert.deepEqual(await client.getMessages(), forkHistory);
      await completeTurn(client, 'clone continuation');
      assert.notEqual((await client.switchSession(original)).cancelled, true);
      assert.deepEqual(await client.getMessages(), originalHistory);
      await client.navigateTree(earlierAssistant.entryId, { summarize: false });
      assert.deepEqual(await client.getMessages(), predecessor);
      const stats = await client.getSessionStats();
      assert.equal(typeof stats.tokens?.total, 'number');
      assert.equal(stats.sessionFile, original);
    } finally { await fixture.close(); }
  });

  test('imports actual JSONL without rewriting its source and pins sandbox workspace/store', async () => {
    const fixture = await createFixture();
    try {
      const client = fixture.client();
      await completeTurn(client, 'portable marker');
      const history = await client.getMessages();
      const original = (await client.getState()).sessionFile!;
      const records = (await fs.readFile(original, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const foreign = path.join(fixture.directory, 'foreign-workspace');
      await fs.mkdir(foreign);
      records[0] = { ...records[0], cwd: foreign };
      const source = records.map(record => JSON.stringify(record)).join('\n') + '\n';
      const input = path.join(fixture.directory, 'portable.jsonl');
      await fs.writeFile(input, source);
      assert.notEqual((await client.importFromJsonl(input)).cancelled, true);
      const imported = (await client.getState()).sessionFile!;
      assert.notEqual(imported, original);
      assert.notEqual(imported, input);
      assert.equal(path.dirname(imported), path.dirname(original));
      assert.deepEqual(await client.getMessages(), history);
      assert.equal(await fs.readFile(input, 'utf8'), source);
      assert.equal(JSON.parse((await fs.readFile(imported, 'utf8')).split('\n')[0]).cwd, fixture.workspace);
      await assert.rejects(client.importFromJsonl(input, foreign), /workspace|cwd|override/i);
      await completeTurn(client, 'source-check');
      assert.ok((await client.getLastAssistantText()).text?.includes(`cwd=${fixture.workspace}`));
    } finally { await fixture.close(); }
  });

  test('applies real file completions once and invalidates stale handles on reload', async () => {
    const fixture = await createFixture();
    try {
      await fs.writeFile(path.join(fixture.workspace, 'completion target.txt'), 'fixture');
      const client = fixture.client();
      const capabilities = await client.getComposerCompletionCapabilities();
      assert.ok(capabilities.triggerCharacters.includes('@'));
      const request = { id: 'composer', revision: 1, text: '@completion', selectionStart: 11, selectionEnd: 11 };
      const result = await client.getComposerCompletions(request, new AbortController().signal);
      const item = result.items.find(entry => entry.label === 'completion target.txt');
      assert.ok(item);
      const application = { id: request.id, revision: request.revision, itemId: item.id };
      assert.equal((await client.applyComposerCompletion(application))?.text, '@"completion target.txt" ');
      assert.equal(await client.applyComposerCompletion(application), undefined);
      const fresh = await client.getComposerCompletions(request, new AbortController().signal);
      assert.ok(fresh.items.length);
      await client.reload();
      assert.equal(await client.applyComposerCompletion({ ...application, itemId: fresh.items[0].id }), undefined);
      assert.ok((await client.getComposerCompletionCapabilities()).generation > capabilities.generation);
      await completeTurn(client, 'after reload');
      assert.equal((await client.getLastAssistantText()).text, 'fixture: after reload');
    } finally { await fixture.close(); }
  });

  for (const streamingBehavior of ['steer', 'followUp'] as const) {
    test(`delivers ${streamingBehavior} to a busy real SDK session without host queue semantics`, async () => {
      const fixture = await createFixture();
      try {
        const client = fixture.client();
        const streaming = eventLatch(client, event => (event.assistantMessageEvent as { delta?: string } | undefined)?.delta === 'fixture: waiting');
        const settled = eventLatch(client, event => event.type === 'agent_settled');
        await client.prompt('queue-window');
        await streaming;
        assert.equal((await client.getState()).isStreaming, true);
        await client.prompt(`queued-${streamingBehavior}`, streamingBehavior);
        await settled;
        await idle(client);
        const users = (await client.getMessages()).messages?.filter(message => (message as { role?: string }).role === 'user');
        assert.equal(users?.length, 2);
        assert.match(JSON.stringify(users?.[1]), new RegExp(`queued-${streamingBehavior}`));
        assert.equal((await client.getLastAssistantText()).text, `fixture: queued-${streamingBehavior}`);
      } finally { await fixture.close(); }
    });
  }

  test('aborts active real SDK generation and remains usable', async () => {
    const fixture = await createFixture();
    try {
      const client = fixture.client();
      const streaming = eventLatch(client, event => event.type === 'message_update');
      const finished = eventLatch(client, event => event.type === 'agent_end' || event.type === 'agent_settled');
      await client.prompt('wait-for-abort');
      await streaming;
      await client.abort();
      await finished;
      await idle(client);
      await completeTurn(client, 'after abort');
      assert.equal((await client.getLastAssistantText()).text, 'fixture: after abort');
    } finally { await fixture.close(); }
  });
});

suite('SBX client malformed/failed server boundaries', function () {
  this.timeout(30_000);

  test('rejects a malformed getState response rather than accepting wire types', async () => {
    const fixture = await createFixture('invalid-state');
    try { await assert.rejects(fixture.client().getState(), /invalid|state|boolean/i); }
    finally { await fixture.close(); }
  });

  test('reports malformed event payload and disconnects without delivering it', async () => {
    const fixture = await createFixture('invalid-event');
    try {
      const client = fixture.client();
      const events: PiEvent[] = []; const errors: string[] = [];
      client.onEvent(event => events.push(event));
      const disconnected = bounded(new Promise<void>(resolve => client.onError(error => {
        errors.push(error); if (/disconnect/i.test(error)) resolve();
      })), 'malformed event disconnect');
      await client.prompt('trigger malformed event').catch(() => undefined);
      await disconnected;
      assert.ok(errors.some(error => /invalid.*event/i.test(error)), errors.join('\n'));
      assert.deepEqual(events, []);
      await assert.rejects(client.getState(), /reconnect|disconnect/i);
    } finally { await fixture.close(); }
  });

  test('rejects pending requests on process exit and never reopens implicitly', async () => {
    const fixture = await createFixture('exit');
    try {
      const client = fixture.client();
      await client.getState();
      await assert.rejects(bounded(client.getMessages(), 'exit rejects pending RPC'));
      await assert.rejects(client.getState(), /reconnect|disconnect/i);
      assert.equal((await fixture.records()).filter(record => record.type === 'launch').length, 1);
    } finally { await fixture.close(); }
  });

  test('completion AbortSignal propagates RPC cancellation', async () => {
    const fixture = await createFixture('pending');
    try {
      const client = fixture.client();
      await client.getState();
      const connection = fixture.connections[0];
      const entered = bounded(new Promise<void>(resolve => connection.onNotification('fixture.pending', () => resolve())), 'pending completion');
      const cancelled = bounded(new Promise<void>(resolve => connection.onNotification('fixture.cancelled', () => resolve())), 'RPC cancellation');
      const controller = new AbortController();
      const pending = client.getComposerCompletions({ id: 'fixture', revision: 1, text: '/', selectionStart: 1, selectionEnd: 1 }, controller.signal);
      const rejected = assert.rejects(pending, /cancel|abort/i);
      await entered;
      controller.abort();
      await rejected;
      await cancelled;
      assert.equal((await client.getState()).isStreaming, false);
    } finally { await fixture.close(); }
  });

  test('request timeout cancels a pending RPC without replaying it', async () => {
    const fixture = await createFixture('pending');
    try {
      const client = fixture.client({ requestTimeoutMs: 500 });
      await client.getState();
      const cancelled = bounded(new Promise<void>(resolve => fixture.connections[0].onNotification('fixture.cancelled', () => resolve())), 'timeout RPC cancellation');
      await assert.rejects(client.getMessages(), /timed out|timeout/i);
      await cancelled;
      const requests = (await fixture.records()).filter(record => record.method === 'session.getMessages');
      assert.equal(requests.length, 1);
      assert.equal((await client.getState()).isStreaming, false);
    } finally { await fixture.close(); }
  });

  test('dispose rejects in-flight RPC and is idempotent', async () => {
    const fixture = await createFixture('pending');
    try {
      const client = fixture.client();
      await client.getState();
      const entered = bounded(new Promise<void>(resolve => fixture.connections[0].onNotification('fixture.pending', () => resolve())), 'pending messages');
      const rejected = assert.rejects(bounded(client.getMessages(), 'dispose pending request'));
      await entered;
      client.dispose(); client.dispose();
      await rejected;
      await client.closeSession();
      await assert.rejects(client.getMessages(), /disposed/i);
    } finally { await fixture.close(); }
  });
});
