import * as assert from 'node:assert/strict';
import { createProtocolConnection, Requests, PROTOCOL_VERSION, type InitializeParams, type InitializeResult } from '@tauren/shared/sbx/protocol';
import { PassThrough } from 'node:stream';
import { buildServerLaunchCommand } from '@tauren/shared/ssh/serverLaunch';
import { buildSshArguments, SbxSshTransport } from '../../sbx/sshTransport';

// A real Node child stands in for ssh. Only its prefix argv is interpreted locally;
// the appended SSH options and remote command are inspected, never executed.
const fixture = String.raw`
const { createProtocolConnection, Requests, PROTOCOL_VERSION } = require(process.argv[1]);
const mode = process.argv[2];
const connection = createProtocolConnection(process.stdin, process.stdout);
const keepAlive = setInterval(() => {}, 1000);
connection.onRequest(Requests.initialize, params => ({ protocolVersion: PROTOCOL_VERSION,
  serverVersion: 'fixture', piVersion: 'fixture', workspace: params.workspace,
  sessionDirectory: params.sessionDirectory, capabilities: [] }));
connection.onRequest('argv', () => process.argv.slice(3));
connection.onRequest('echo', value => value);
connection.onRequest('pid', () => process.pid);
connection.onRequest('hang', () => new Promise(() => {}));
connection.onRequest('exit', () => {
  process.stderr.write('SSH fixture failed: check remote paths\n', () => process.exit(23));
  return new Promise(() => {});
});
connection.onRequest('malformed', () => {
  process.stdout.write('Content-Length: 1\r\n\r\n!');
  return new Promise(() => {});
});
connection.onRequest('stderr', () => {
  process.stderr.write('x'.repeat(40000) + ' diagnostic tail\n');
  return 'stdout stays framed';
});
connection.onRequest('reverse', async () => {
  await connection.sendNotification('fixture.notice', { text: '通知' });
  return connection.sendRequest('fixture.question', { text: 'café 😀' });
});
connection.onRequest('fragment', () => {
  // send a UTF-8 multibyte response a byte at a time, including split headers.
  const response = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 0, result: 'café 😀 日本語' }));
  const frame = Buffer.concat([Buffer.from('Content-Length: ' + response.length + '\r\n\r\n'), response]);
  let index = 0;
  const next = () => {
    if (index < frame.length) { process.stdout.write(frame.subarray(index, ++index)); setImmediate(next); }
  };
  next();
  return new Promise(() => {});
});
connection.onRequest(Requests.shutdown, () => {
  if (mode === 'stubborn') return new Promise(() => {});
  clearInterval(keepAlive);
  return null;
});
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  process.stdin.on('end', () => {});
}
connection.listen();
`;

const launch = {
  nodePath: '/explicit/node', serverPath: '/server path/main.js',
  workspace: '/workspace/it\'s here', sessionDirectory: '/sessions'
};

suite('sbx SSH transport', function () {
  this.timeout(10_000);
  const transports: SbxSshTransport[] = [];
  async function open(mode = 'normal'): Promise<SbxSshTransport> {
    const transport = await SbxSshTransport.open({ sandboxName: 'fixture', launch,
      executable: process.execPath,
      args: ['-e', fixture, '--', require.resolve('@tauren/shared/sbx/protocol'), mode],
      timeoutMs: 1000, shutdownTimeoutMs: 80 });
    transports.push(transport);
    return transport;
  }
  teardown(async () => { await Promise.all(transports.splice(0).map(transport => transport.dispose(false))); });

  function deadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture request timed out')), 3000);
    })]).finally(() => clearTimeout(timer));
  }

  test('builds the same safe SSH arguments for probes and live launches', () => {
    assert.deepStrictEqual(buildSshArguments('fixture', 'command -v node', 1201), [
      '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', 'fixture.sbx', 'command -v node'
    ]);
    for (const name of ['-bad', 'bad.sbx', 'bad\nname', 'bad\n', 'a;id']) {
      assert.throws(() => buildSshArguments(name, 'true'), /Invalid sandbox/);
    }
    assert.throws(() => buildSshArguments('fixture', 'true', NaN), /timeouts/);
    assert.throws(() => buildSshArguments('fixture', 'true', 0), /timeouts/);
  });

  test('opens without stdout, listens immediately and initializes on the first request', async () => {
    const transport = await open();
    const params: InitializeParams = { protocolVersion: PROTOCOL_VERSION, clientVersion: 'test',
      workspace: launch.workspace, sessionDirectory: launch.sessionDirectory };
    const result: InitializeResult = await deadline(transport.connection.sendRequest(Requests.initialize, params));
    assert.equal(result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(result.workspace, launch.workspace);
    assert.deepStrictEqual(await transport.connection.sendRequest('argv'),
      buildSshArguments('fixture', buildServerLaunchCommand(launch), 1000));
  });

  test('decodes byte-fragmented headers and UTF-8 responses', async () => {
    const transport = await open();
    // It is the first request (id zero), matching the deliberately hand-framed response.
    assert.equal(await deadline(transport.connection.sendRequest('fragment')), 'café 😀 日本語');
  });

  test('supports reverse requests and notifications on the same channel', async () => {
    const transport = await open();
    const notices: unknown[] = [];
    transport.connection.onNotification('fixture.notice', value => notices.push(value));
    transport.connection.onRequest('fixture.question', value => ({ answer: value.text }));
    assert.deepStrictEqual(await deadline(transport.connection.sendRequest('reverse')), { answer: 'café 😀' });
    assert.deepStrictEqual(notices, [{ text: '通知' }]);
  });

  test('keeps a bounded stderr tail separate from framed stdout', async () => {
    const transport = await open();
    assert.equal(await deadline(transport.connection.sendRequest('stderr')), 'stdout stays framed');
    // A subsequent roundtrip ensures the stderr write has reached the parent too.
    await transport.connection.sendRequest('echo', null);
    assert.ok(transport.stderr.endsWith('diagnostic tail\n'));
    assert.ok(transport.stderr.length <= 16 * 1024);
  });

  test('SSH exit rejects all pending requests and retains actionable diagnostics', async () => {
    const transport = await open();
    const pending = assert.rejects(deadline(transport.connection.sendRequest('hang')), /disposed|closed/i);
    await assert.rejects(deadline(transport.connection.sendRequest('exit')), /disposed|closed/i);
    await pending;
    await transport.dispose(false);
    assert.match(transport.stderr, /check remote paths/);
  });

  test('malformed JSON frames reject pending requests and clean up the child', async () => {
    const transport = await open();
    const pid = await transport.connection.sendRequest<number>('pid');
    await assert.rejects(deadline(transport.connection.sendRequest('malformed')), /disposed|closed/i);
    await transport.dispose(false);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.match(transport.stderr, /protocol|framing/i);
  });

  test('spawn ENOENT reports the executable failure without hanging', async () => {
    await assert.rejects(deadline(SbxSshTransport.open({ sandboxName: 'fixture', launch,
      executable: '/nonexistent-tauren-test/ssh', shutdownTimeoutMs: 30 })), /SSH startup failed.*ENOENT/);
  });

  test('already-cancelled startup never launches a child', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(SbxSshTransport.open({ sandboxName: 'fixture', launch, signal: controller.signal,
      executable: '/never-executed/ssh' }), /startup aborted/);
  });

  test('synchronous startup cancellation cleans up even with a pending spawn event', async () => {
    const controller = new AbortController();
    const opening = SbxSshTransport.open({ sandboxName: 'fixture', launch, executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)', '--'], signal: controller.signal, shutdownTimeoutMs: 30 });
    controller.abort();
    await assert.rejects(deadline(opening), /startup aborted/);
  });

  test('silent shutdown is bounded, idempotent and force-kills an uncooperative child', async () => {
    const transport = await open('stubborn');
    const pid = await transport.connection.sendRequest<number>('pid');
    const pending = assert.rejects(transport.connection.sendRequest('hang'), /disposed|closed/i);
    const start = Date.now();
    const disposal = transport.dispose();
    assert.equal(transport.dispose(), disposal);
    await deadline(disposal);
    await pending;
    assert.ok(Date.now() - start < 2000);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  test('non-graceful disposal does not wait for the shutdown RPC', async () => {
    const transport = await open('stubborn');
    const pid = await transport.connection.sendRequest<number>('pid');
    await deadline(transport.dispose(false));
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  test('independent connection disposal rejects pending work and tears down SSH', async () => {
    const transport = await open();
    const pid = await transport.connection.sendRequest<number>('pid');
    const pending = assert.rejects(transport.connection.sendRequest('hang'), /disposed|closed/i);
    transport.connection.dispose();
    await pending;
    await deadline(transport.dispose());
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });

  test('disposing one connection does not dispose another protocol connection', async () => {
    const transport = await open();
    const input = new PassThrough();
    const output = new PassThrough();
    const independent = createProtocolConnection(input, output);
    independent.listen();
    let disposed = false;
    independent.onDispose(() => { disposed = true; });
    try {
      await transport.dispose();
      assert.equal(disposed, false);
    } finally { independent.dispose(); input.destroy(); output.destroy(); }
  });
});
