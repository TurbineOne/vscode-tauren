import * as assert from 'assert';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { traceOrigin, type TraceOriginInput } from '../../origin/sessionOriginTracer';
import { listAgentSessions } from '../../sessions/agentSessionList';
import type { WebviewSessionItem } from '../../webviewProtocol/types';

suite('SBX session discovery', () => {
  let root: string;
  let workspace: string;
  let store: string;
  let otherWorkspace: string;
  let localFile: string;
  let sessionFile: string;
  let earlier: string;
  let originInputs: TraceOriginInput[];

  const options = () => ({ backend: 'sbx' as const, sbxWorkspace: workspace, sbxSessionStore: store });

  async function writeSession(file: string, id: string, cwd: string, timestamp: string, parentSession?: string) {
    await writeFile(file, [
      { type: 'session', id, cwd, timestamp, parentSession },
      { type: 'message', message: { role: 'user', content: `Prompt ${id}` } },
      { type: 'session_info', name: `Session ${id}` },
      { type: 'tool_execution_end', id: `write-${id}`, timestamp, toolName: 'write', args: { path: 'src/example.ts' } }
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  }

  setup(async function () {
    if (process.platform === 'win32') this.skip();
    root = await realpath(await mkdtemp(join(tmpdir(), 'tauren-sbx-discovery-')));
    workspace = join(root, 'workspace');
    otherWorkspace = join(root, 'elsewhere', 'workspace');
    store = join(root, 'sessions');
    const localStore = join(root, 'local');
    const nested = join(store, 'nested');
    await Promise.all([workspace, otherWorkspace, localStore, nested, join(store, 'directory.jsonl')]
      .map((path) => mkdir(path, { recursive: true })));
    localFile = join(localStore, 'local.jsonl');
    sessionFile = join(store, 'valid.jsonl');
    earlier = '2026-01-01T00:00:00.000Z';
    originInputs = [{ kind: 'file', path: 'src/example.ts', absolutePath: join(workspace, 'src', 'example.ts') }];
    await Promise.all([
      writeSession(sessionFile, 'valid', workspace, '2026-01-02T00:00:00.000Z'),
      writeSession(join(store, 'other.jsonl'), 'other', otherWorkspace, earlier),
      writeSession(join(store, 'relative.jsonl'), 'relative', 'workspace', earlier),
      writeSession(join(nested, 'nested.jsonl'), 'nested', workspace, earlier),
      writeSession(join(store, 'ignored.txt'), 'ignored', workspace, earlier),
      writeSession(localFile, 'local', workspace, earlier),
      writeFile(join(store, 'malformed.jsonl'), '{not-json\n'),
      symlink(localFile, join(store, 'escape.jsonl')),
      symlink(sessionFile, join(store, 'alias.jsonl')),
      symlink(store, join(root, 'store-link'), 'dir'),
      symlink(workspace, join(root, 'workspace-link'), 'dir')
    ]);
  });

  teardown(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('lists only sessions for the canonical workspace and retains fork and current markers', async () => {
    const forkFile = join(store, 'fork.jsonl');
    await writeSession(forkFile, 'fork', join(root, 'workspace-link'), '2026-01-03T00:00:00.000Z', sessionFile);
    const progress: WebviewSessionItem[][] = [];
    const sessions = await listAgentSessions({
      ...options(), cwd: otherWorkspace, currentSessionFile: forkFile, onProgress: (items) => progress.push(items)
    });
    assert.deepStrictEqual(sessions.map(({ path, cwd, name, firstMessage, depth, current }) => ({ path, cwd, name, firstMessage, depth, current })), [
      { path: sessionFile, cwd: workspace, name: 'Session valid', firstMessage: 'Prompt valid', depth: 0, current: false },
      { path: forkFile, cwd: workspace, name: 'Session fork', firstMessage: 'Prompt fork', depth: 1, current: true }
    ]);
    assert.deepStrictEqual(progress, [sessions]);
    assert.ok(sessions.every((session) => session.metadataState === 'ready'));
  });

  test('traces only SBX store sessions associated with the workspace', async () => {
    const result = await traceOrigin(originInputs, options());
    assert.strictEqual(result?.sessionPath, sessionFile);
    assert.strictEqual(result?.sessionCwd, workspace);
    assert.strictEqual(result?.recordId, 'write-valid');
    assert.strictEqual(result?.sessionEndedAt, '2026-01-02T00:00:00.000Z');

    const excluded = [localFile, join(store, 'escape.jsonl'), join(store, 'other.jsonl'), join(store, 'nested', 'nested.jsonl')];
    assert.strictEqual(await traceOrigin(originInputs, { ...options(), sessionFiles: excluded }), undefined);
    assert.strictEqual((await traceOrigin(originInputs, { ...options(), sessionFiles: [...excluded, sessionFile] }))?.sessionPath, sessionFile);
  });

  test('never falls back to local Pi for missing or invalid SBX paths', async () => {
    const original = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'local');
    try {
      assert.deepStrictEqual((await listAgentSessions({ backend: 'pi' })).map((session) => session.path), [localFile]);
      assert.strictEqual((await traceOrigin(originInputs))?.sessionPath, localFile);
      for (const invalidScope of [
        { sbxSessionStore: undefined },
        { sbxWorkspace: undefined },
        { sbxSessionStore: join(root, 'missing') },
        { sbxSessionStore: relative(process.cwd(), store) },
        { sbxSessionStore: join(root, 'store-link') },
        { sbxWorkspace: join(root, 'workspace-link') }
      ]) {
        const invalidOptions = { ...options(), ...invalidScope, currentSessionFile: localFile };
        assert.deepStrictEqual(await listAgentSessions(invalidOptions), []);
        assert.strictEqual(await traceOrigin(originInputs, { ...invalidOptions, sessionFiles: [localFile, sessionFile] }), undefined);
      }
    } finally {
      if (original === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = original;
    }
  });
});
