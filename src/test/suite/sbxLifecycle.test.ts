import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION, Requests, type InitializeParams, type MessageConnection } from '@tauren/shared/sbx/protocol';
import { SandboxLifecycle, type SandboxLifecycleOptions } from '../../sbx/lifecycle';
import { compatibleRuntimeVersion } from '../../sbx/handshake';
import { runHostCommand, SandboxLifecycleError, type CommandRunner, type HostCommand } from '../../sbx/process';
import { parseSandboxInspection } from '../../sbx/sbxControl';
import { buildServerLaunchCommand } from '@tauren/shared/ssh/serverLaunch';

// Deliberately provisional SBX schema: these tests cover the current narrow
// { name, workspace } adapter, not a claim about an independently verified CLI.
// Every finite command uses a real child; no real SBX, SSH or shell is invoked.
const fixture = String.raw`
const fs = require('node:fs');
const [file, executable, ...args] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => {
  const temporary = file + '.' + process.pid;
  fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, file);
};
const fail = text => { process.stderr.write(text); process.exitCode = 23; };
const operation = executable === 'transport' ? (args.at(-1) === 'command -v node' ? 'probe' : 'transport') : args.find(x => ['--version', 'ls', 'inspect', 'create'].includes(x));
if (state.hang === operation) { setInterval(() => {}, 1000); }
else if (operation === '--version') console.log(state.version || 'sbx version 0.51.3');
else if (operation === 'ls') console.log(state.listOutput === undefined ? JSON.stringify(state.sandbox ? [{ name: state.sandbox.name }] : []) : state.listOutput);
else if (operation === 'inspect') {
  if (state.inspectError) fail(state.inspectError);
  else console.log(state.inspectOutput === undefined ? JSON.stringify(state.sandbox) : state.inspectOutput);
} else if (operation === 'create') {
  const name = args[args.indexOf('--name') + 1];
  state.sandbox = { name, workspace: state.workspace, status: 'stopped' };
  save(); console.log('creation is not a readiness signal');
} else if (operation === 'probe') {
  if (args.at(-1) !== 'command -v node') throw Error('unexpected SSH command');
  state.probes = (state.probes || 0) + 1;
  if (state.sandbox) state.sandbox.status = 'running'; // SSH auto-starts stopped VMs.
  save();
  if (state.probes <= (state.probeFailures || 0)) fail('fixture SSH: connection refused');
  else console.log(state.nodeOutput === undefined ? '/remote/node' : state.nodeOutput);
} else if (operation === 'transport') {
  const { createProtocolConnection, Requests, PROTOCOL_VERSION } = require(args[0]);
  const record = event => fs.appendFileSync(args[1], JSON.stringify({ pid: process.pid, ...event }) + '\n');
  record({ type: 'launch', args: args.slice(2) });
  const connection = createProtocolConnection(process.stdin, process.stdout);
  const keepAlive = setInterval(() => {}, 1000);
  connection.onRequest(Requests.initialize, async params => {
    record({ type: 'initialize', params });
    await connection.sendNotification('fixture.initialize', params);
    if (state.handshake === 'hang') return new Promise(() => {});
    if (state.handshake === 'reject') throw Error('wire closed');
    if (state.handshake === 'reverse') await connection.sendRequest('fixture.question', { workspace: params.workspace });
    if (Object.hasOwn(state, 'reply')) return state.reply;
    return { protocolVersion: PROTOCOL_VERSION, serverVersion: '1.10.7', piVersion: '1.5.9',
      workspace: params.workspace, sessionDirectory: params.sessionDirectory, capabilities: ['sessions'], ...state.replyOverrides };
  });
  connection.onRequest(Requests.shutdown, () => {
    record({ type: 'shutdown' }); clearInterval(keepAlive); return null;
  });
  process.stderr.write('fixture server stderr\n');
  connection.listen();
} else throw Error('unexpected command: ' + JSON.stringify(args));
`;

interface FixtureState {
  workspace: string;
  sandbox?: { name: string; workspace: string; status: string; workspaces?: string[] };
  version?: string;
  listOutput?: string;
  inspectOutput?: string;
  inspectError?: string;
  probeFailures?: number;
  probes?: number;
  nodeOutput?: string;
  hang?: string;
  handshake?: 'hang' | 'reject' | 'reverse';
  reply?: unknown;
  replyOverrides?: Record<string, unknown>;
}
interface FixtureRecord {
  pid: number;
  type: 'launch' | 'initialize' | 'shutdown';
  args?: string[];
  params?: InitializeParams;
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function failure(kind: SandboxLifecycleError['kind'], message?: RegExp): (error: unknown) => boolean {
  return error => {
    assert.ok(error instanceof SandboxLifecycleError, String(error));
    assert.equal(error.kind, kind);
    if (message) assert.match(error.message, message);
    return true;
  };
}

suite('sbx lifecycle', function () {
  this.timeout(15_000);
  let root: string, workspace: string, storageRoot: string, script: string, stateFile: string, recordsFile: string;
  let commands: HostCommand[], connections: MessageConnection[];
  let providerCalls: number;
  let options: SandboxLifecycleOptions;
  const name = 'fixture-project';
  const state = async (): Promise<FixtureState> => JSON.parse(await readFile(stateFile, 'utf8'));
  const configure = async (patch: Partial<FixtureState>): Promise<void> => {
    await writeFile(stateFile, JSON.stringify({ ...await state(), ...patch }));
  };
  const sessionDirectory = (): string => path.join(storageRoot, name, 'sessions');
  const records = async (): Promise<FixtureRecord[]> => (await readFile(recordsFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const launches = async (): Promise<FixtureRecord[]> => (await records()).filter(record => record.type === 'launch');
  const requests = async (): Promise<InitializeParams[]> => (await records()).filter(record => record.type === 'initialize').map(record => record.params!);
  const assertChildrenStopped = async (): Promise<void> => {
    for (const record of await launches()) assert.throws(() => process.kill(record.pid, 0), /ESRCH/);
    assert.equal((await records()).some(record => record.type === 'shutdown'), false, 'failed handshake must not request graceful shutdown');
  };
  let run: CommandRunner;

  setup(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tauren-lifecycle-')));
    workspace = path.join(root, 'project with spaces');
    storageRoot = path.join(root, 'store');
    script = path.join(root, 'sbx.cjs'); stateFile = path.join(root, 'state.json');
    await mkdir(workspace);
    await writeFile(script, fixture);
    await writeFile(stateFile, JSON.stringify({ workspace }));
    recordsFile = path.join(root, 'records.jsonl');
    await writeFile(recordsFile, '');
    commands = []; connections = []; providerCalls = 0;
    run = async (command, limits) => {
      commands.push(command);
      if (command.executable === process.execPath) return runHostCommand(command, limits);
      return runHostCommand({ executable: process.execPath,
        args: [script, stateFile, command.executable, ...command.args], cwd: command.cwd }, limits);
    };
    options = { workspace, storageRoot, sandboxName: name, extensionDirectory: root,
      workspaceTrusted: true, clientVersion: '1.10.0', expectedServerVersion: '1.10.0', expectedPiVersion: '1.5.1',
      sbxExecutable: 'fixture-sbx', sshExecutable: process.execPath,
      sshArgs: [script, stateFile, 'transport', require.resolve('@tauren/shared/sbx/protocol'), recordsFile], runCommand: run,
      timeouts: { command: 2000, startup: 2000, handshake: 1000, shutdown: 100, probeInterval: 5 },
      commandProvider: async () => { providerCalls++; return { version: 1, argv: ['sbx', 'create', 'fixture-kit'] }; },
      configureConnection: connection => { connections.push(connection); }
    };
  });
  teardown(async () => {
    for (const connection of connections) connection.dispose();
    await rm(root, { recursive: true, force: true });
  });
  async function existing(status = 'running'): Promise<void> {
    await configure({ sandbox: { name, workspace, status } });
  }
  function assertNoDestructiveCommands(): void {
    assert.equal(commands.some(command => command.args.some(arg => ['stop', 'rm', 'remove', 'start', 'run', '-d', '--detach'].includes(arg))), false);
  }

  test('creates an absent sandbox once, reinspects it, probes SSH and forwards resume paths', async () => {
    const sessionFile = path.join(sessionDirectory(), 'resume.jsonl');
    const session = await new SandboxLifecycle(options).open(undefined, sessionFile);
    assert.equal(providerCalls, 1);
    assert.deepEqual(commands.map(command => command.executable === process.execPath ? command.args[options.sshArgs!.length] : command.args[0]),
      ['--version', 'ls', '--no-input', 'ls', 'inspect', '-T']);
    const create = commands[2];
    assert.equal(create.cwd, workspace);
    assert.deepEqual(create.args.slice(0, 4), ['--no-input', 'create', '--name', name]);
    assert.ok(create.args.includes(`PI_CODING_AGENT_SESSION_DIR=${sessionDirectory()}`));
    assert.ok(create.args.includes(path.join(root, 'resources/generated-sbx-kit')));
    assert.ok((await stat(sessionDirectory())).isDirectory());
    assert.equal((await launches())[0].args!.at(-1), buildServerLaunchCommand({ nodePath: '/remote/node',
      workspace, sessionDirectory: sessionDirectory(), serverPath: '/home/agent/.tauren/server/dist/main.js' }));
    assert.deepEqual((await requests())[0], { protocolVersion: PROTOCOL_VERSION, clientVersion: '1.10.0', workspace,
      sessionDirectory: sessionDirectory(), sessionFile });
    assert.equal(session.name, name);
    assert.equal(session.handshake.piVersion, '1.5.9');
    await session.dispose();
    assertNoDestructiveCommands();
  });

  for (const status of ['running', 'stopped']) {
    test(`adopts a ${status} sandbox without provider or policy-changing start commands`, async () => {
      await existing(status);
      options.workspaceTrusted = false; // Adoption does not execute a workspace provider.
      const session = await new SandboxLifecycle(options).open();
      assert.equal(providerCalls, 0);
      assert.equal((await state()).sandbox?.status, 'running');
      assert.equal((await requests())[0].sessionFile, undefined);
      await assert.rejects(stat(sessionDirectory()), { code: 'ENOENT' });
      await session.dispose();
      assertNoDestructiveCommands();
    });
  }

  test('two lifecycle instances serialize creation from missing storage but own independent server pipes', async () => {
    const [one, two] = await Promise.all([new SandboxLifecycle(options).open(), new SandboxLifecycle(options).open()]);
    assert.equal(providerCalls, 1);
    assert.equal(commands.filter(command => command.args.includes('create')).length, 1);
    const children = await launches();
    assert.equal(children.length, 2);
    assert.notEqual(children[0].pid, children[1].pid);
    assert.notEqual(one.connection, two.connection);
    await one.dispose();
    assert.equal((await records()).filter(record => record.type === 'shutdown').length, 1);
    await assert.rejects(async () => one.connection.sendRequest(Requests.initialize, (await requests())[0]), /disposed|closed/i);
    const before = (await requests()).length;
    await two.connection.sendRequest(Requests.initialize, (await requests())[0]);
    assert.equal((await requests()).length, before + 1);
    await two.dispose();
    for (const child of children) assert.throws(() => process.kill(child.pid, 0), /ESRCH/);
    assertNoDestructiveCommands();
    assert.ok((await state()).sandbox);
  });

  test('wrong primary workspace is rejected before SSH even when an extra workspace matches', async () => {
    const other = path.join(root, 'other'); await mkdir(other);
    await configure({ sandbox: { name, workspace: other, status: 'running', workspaces: [workspace] } });
    await assert.rejects(new SandboxLifecycle(options).open(), failure('incompatible', /another workspace/));
    assert.equal(providerCalls, 0); assert.equal((await launches()).length, 0);
    assert.equal(commands.some(command => command.executable === process.execPath), false);
  });

  test('untrusted absent workspace cannot invoke provider or mutate storage', async () => {
    options.workspaceTrusted = false;
    await assert.rejects(new SandboxLifecycle(options).open(), failure('prerequisite', /Trust/));
    assert.equal(providerCalls, 0);
    await assert.rejects(stat(storageRoot), { code: 'ENOENT' });
  });

  for (const version of ['sbx 0.50.9', 'sbx 1.0.0', 'sbx 0.51.0-beta.1', 'banner\nsbx 0.51.0']) {
    test(`rejects unsupported CLI version ${JSON.stringify(version)} before lookup`, async () => {
      await configure({ version });
      await assert.rejects(new SandboxLifecycle(options).open(), failure('prerequisite', /stable SBX/));
      assert.equal(commands.length, 1);
    });
  }

  for (const listOutput of ['not json', '{}', '[{}]', `[{"name":"${name}"},{"name":"${name}"}]`]) {
    test(`fails closed on list output ${listOutput}`, async () => {
      await configure({ listOutput });
      await assert.rejects(new SandboxLifecycle(options).open(), failure('incompatible', /schema/));
      assert.equal(providerCalls, 0); assert.equal((await launches()).length, 0);
    });
  }

  test('inspect command failure is not mistaken for absence or retried as create', async () => {
    await existing(); await configure({ inspectError: 'fixture inspection permission denied' });
    await assert.rejects(new SandboxLifecycle(options).open(), failure('command', /permission denied/));
    assert.equal(providerCalls, 0); assert.equal((await launches()).length, 0);
  });

  for (const output of ['banner\n{}', 'null', '[]', '{}', '{"name":"wrong","workspace":"/tmp"}',
    `{"name":"${name}","workspace":"relative"}`, `{"name":"${name}","workspaces":["/tmp"]}`]) {
    test(`rejects unverified inspection schema ${output}`, () => {
      assert.throws(() => parseSandboxInspection(output, name), failure('incompatible', /schema/));
    });
  }

  const invalidReplies: Array<[string, Partial<FixtureState>, RegExp]> = [
    ['protocol', { replyOverrides: { protocolVersion: -1 } }, /protocol/],
    ['server', { replyOverrides: { serverVersion: '1.11.0' } }, /server version/],
    ['Pi', { replyOverrides: { piVersion: '1.6.0' } }, /Pi SDK/],
    ['workspace', { replyOverrides: { workspace: '/wrong' } }, /workspace or session/],
    ['session directory', { replyOverrides: { sessionDirectory: '/wrong' } }, /workspace or session/],
    ['capabilities', { replyOverrides: { capabilities: [42] } }, /capabilities/],
    ['malformed', { reply: 'not an initialize object' }, /invalid initialize/],
    ['null', { reply: null }, /invalid initialize/]
  ];
  for (const [label, response, message] of invalidReplies) {
    test(`rejects ${label} handshake mismatch and forcibly disposes only its transport`, async () => {
      await existing(); await configure(response);
      await assert.rejects(new SandboxLifecycle(options).open(), failure('incompatible', message));
      await assertChildrenStopped();
      assertNoDestructiveCommands();
    });
  }

  test('installs reverse handlers before initialize can request host UI', async () => {
    await existing(); await configure({ handshake: 'reverse' });
    const questions: unknown[] = [];
    options.configureConnection = connection => {
      connections.push(connection);
      connection.onRequest('fixture.question', params => { questions.push(params); return { accepted: true }; });
    };
    const session = await new SandboxLifecycle(options).open();
    assert.deepEqual(questions, [{ workspace }]);
    await session.dispose();
  });

  test('a throwing configureConnection hook disposes the real pipe before initialize', async () => {
    await existing();
    let disposed = false;
    options.configureConnection = connection => {
      connections.push(connection);
      connection.onDispose(() => { disposed = true; });
      throw new Error('fixture hook failed');
    };
    await assert.rejects(new SandboxLifecycle(options).open(), failure('server'));
    assert.equal(disposed, true);
    assert.deepEqual(await requests(), []);
    await assertChildrenStopped();
    assertNoDestructiveCommands();
  });

  test('cancellation inside configureConnection disposes the pipe', async () => {
    await existing();
    const controller = new AbortController();
    let disposed = false;
    options.configureConnection = connection => {
      connections.push(connection);
      connection.onDispose(() => { disposed = true; });
      controller.abort();
    };
    await assert.rejects(new SandboxLifecycle(options).open(controller.signal), failure('cancelled'));
    assert.equal(disposed, true);
    await assertChildrenStopped();
    assertNoDestructiveCommands();
  });

  test('validates the server release independently of the client release', async () => {
    await existing();
    options.clientVersion = '9.2.0';
    const session = await new SandboxLifecycle(options).open();
    assert.equal((await requests())[0].clientVersion, '9.2.0');
    assert.equal(session.handshake.serverVersion, '1.10.7');
    await session.dispose();
  });

  test('reports rejected handshake diagnostics and disposes transport', async () => {
    await existing(); await configure({ handshake: 'reject' });
    await assert.rejects(new SandboxLifecycle(options).open(), failure('server', /server kit and Pi: fixture server stderr/));
    await assertChildrenStopped();
  });

  test('reports launch failure with actionable SSH setup guidance', async () => {
    await existing();
    // Readiness still uses the real Node fixture; fail only the subsequent live spawn.
    options.runCommand = async (command, limits) => {
      const result = await run(command, limits);
      if (command.executable === process.execPath) options.sshExecutable = path.join(root, 'missing-ssh');
      return result;
    };
    await assert.rejects(new SandboxLifecycle(options).open(), failure('ssh', /sbx login and sbx setup ssh/));
  });

  test('retries only readiness probes after transient SSH failures', async () => {
    await configure({ probeFailures: 2 });
    const session = await new SandboxLifecycle(options).open();
    assert.equal((await state()).probes, 3);
    assert.equal(providerCalls, 1);
    assert.equal(commands.filter(command => command.args.includes('create')).length, 1);
    await session.dispose();
  });

  test('readiness deadline retains the last SSH diagnostic and never launches transport', async () => {
    await existing(); await configure({ probeFailures: 999 });
    options.timeouts!.startup = 700;
    // Leave most of the deadline for backoff, ensuring the last completed probe
    // (rather than a child killed while starting) supplies the diagnostic.
    options.timeouts!.probeInterval = 1000;
    await assert.rejects(new SandboxLifecycle(options).open(), failure('ssh', /sbx login.*connection refused/));
    assert.equal((await launches()).length, 0); assert.equal(providerCalls, 0);
  });

  test('a hung readiness command is bounded by the startup budget', async () => {
    await existing(); await configure({ hang: 'probe' }); options.timeouts!.startup = 100;
    await assert.rejects(new SandboxLifecycle(options).open(), failure('ssh', /startup deadline.*timed out/));
    assert.equal((await launches()).length, 0);
  });

  for (const nodeOutput of ['node', '/node\n/banner', '']) {
    test(`invalid Node discovery ${JSON.stringify(nodeOutput)} is not retried`, async () => {
      await existing(); await configure({ nodeOutput });
      await assert.rejects(new SandboxLifecycle(options).open(), failure('incompatible', /absolute POSIX/));
      assert.equal((await state()).probes, 1); assert.equal((await launches()).length, 0);
    });
  }

  test('pre-cancelled startup runs no commands', async () => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(new SandboxLifecycle(options).open(controller.signal), failure('cancelled'));
    assert.equal(commands.length, 0);
  });

  test('cancellation interrupts an actual provisioning command and releases the name queue', async () => {
    await configure({ hang: '--version' });
    const controller = new AbortController(); const started = deferred();
    options.runCommand = (command, limits) => {
      const pending = run(command, limits); started.resolve(); return pending;
    };
    const opening = new SandboxLifecycle(options).open(controller.signal);
    const rejected = assert.rejects(opening, failure('cancelled'));
    await started.promise; controller.abort(); await rejected;
    assert.equal(providerCalls, 0);
    await configure({ hang: undefined });
    const session = await new SandboxLifecycle(options).open(); await session.dispose();
  });

  test('cancelled queue waiter never enters provisioning and does not cancel its owner', async () => {
    // Keep path canonicalization independent of the owner's mkdir boundary.
    await mkdir(sessionDirectory(), { recursive: true });
    const entered = deferred(); const release = deferred();
    options.commandProvider = async () => {
      providerCalls++; entered.resolve(); await release.promise;
      return { version: 1, argv: ['sbx', 'create', 'fixture-kit'] };
    };
    const owner = new SandboxLifecycle(options).open();
    await entered.promise;
    const controller = new AbortController();
    const waiter = new SandboxLifecycle(options).open(controller.signal);
    const rejected = assert.rejects(waiter, failure('cancelled'));
    controller.abort(); release.resolve();
    const session = await owner; await rejected;
    assert.equal(providerCalls, 1); assert.equal((await launches()).length, 1);
    assert.equal(commands.filter(command => command.args[0] === '--version').length, 1);
    await session.dispose();
  });

  for (const mode of ['timeout', 'cancelled'] as const) {
    test(`pending handshake ${mode} cleans up without stopping the sandbox`, async () => {
      await existing(); const entered = deferred(); const controller = new AbortController();
      await configure({ handshake: 'hang' });
      options.configureConnection = connection => {
        connections.push(connection);
        connection.onNotification('fixture.initialize', () => entered.resolve());
      };
      // Include child startup in this deadline, not just an in-memory handler.
      options.timeouts!.handshake = mode === 'timeout' ? 500 : 2000;
      const opening = new SandboxLifecycle(options).open(controller.signal);
      const rejected = assert.rejects(opening, failure(mode, mode === 'timeout' ? /handshake timed out/ : /cancelled/));
      await entered.promise;
      if (mode === 'cancelled') controller.abort();
      await rejected;
      await assertChildrenStopped(); assertNoDestructiveCommands();
    });
  }
});

suite('sbx runtime version compatibility', () => {
  for (const [actual, expected, compatible] of [
    ['1.10.9', '1.10.0', true], ['1.5.0', '1.5.1', true],
    ['1.10.1+build.2', '1.10.0+build.1', true],
    ['1.11.0', '1.10.0', false], ['2.10.0', '1.10.0', false],
    ['1.10.0-beta.1', '1.10.0-beta.1', true],
    ['1.10.0-beta.2', '1.10.0-beta.1', false],
    ['1.10.1-beta.1', '1.10.0-beta.1', false],
    ['1.10.0-beta.1+two', '1.10.0-beta.1+one', false],
    ['1.10.0', '1.10.0-beta.1', false], ['1.10.0-beta.1', '1.10.0', false],
    ['v1.10.0', '1.10.0', false], ['01.10.0', '1.10.0', false], ['1.10', '1.10.0', false],
    ['1.10.0', 'invalid', false]
  ] as const) {
    test(`${actual} vs ${expected}: ${compatible}`, () => {
      assert.equal(compatibleRuntimeVersion(actual, expected), compatible);
    });
  }
});

suite('sbx host command runner', function () {
  this.timeout(5000);
  test('passes literal argv and preserves separate stdout and stderr', async () => {
    const argument = 'spaces ; $(not-a-shell) "quotes"';
    const result = await runHostCommand({ executable: process.execPath, args: ['-e',
      'process.stdout.write(process.argv[1]); process.stderr.write("diagnostic")', '--', argument] });
    assert.deepEqual(result, { stdout: argument, stderr: 'diagnostic' });
  });
  test('command failure retains stderr and exit code', async () => {
    await assert.rejects(runHostCommand({ executable: process.execPath,
      args: ['-e', 'process.stderr.write("fixture denied"); process.exitCode = 17'] }), failure('command', /17.*fixture denied/));
  });
  test('timeout terminates a silent child', async () => {
    await assert.rejects(runHostCommand({ executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'] }, { timeoutMs: 60 }), failure('timeout', /timed out/));
  });
  test('cancellation terminates a pending child', async () => {
    const controller = new AbortController();
    const pending = runHostCommand({ executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'] }, { signal: controller.signal });
    const rejected = assert.rejects(pending, failure('cancelled'));
    controller.abort(); await rejected;
  });
  test('combined stdout and stderr overflow is bounded', async () => {
    await assert.rejects(runHostCommand({ executable: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(40)); process.stderr.write("y".repeat(40))'] },
    { maxOutputBytes: 64 }), failure('command', /output limit/));
  });
  test('missing executable reports a prerequisite error', async () => {
    await assert.rejects(runHostCommand({ executable: '/nonexistent-tauren-fixture/sbx', args: [] }), failure('prerequisite', /ENOENT/));
  });
});
