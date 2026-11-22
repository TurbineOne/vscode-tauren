// Node executable prefix for the concrete SSH transport. SSH's final argument is
// deliberately not evaluated: there is no shell and no sandbox daemon in tests.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const [directory, main, mode, protocol] = process.argv.slice(2);
const record = value => fs.appendFileSync(path.join(directory, 'wire.jsonl'), JSON.stringify(value) + '\n');
record({ type: 'launch', pid: process.pid, command: process.argv.at(-1) });
const environment = { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
  TMPDIR: directory, NO_COLOR: '1', PI_CODING_AGENT_DIR: path.join(directory, 'agent') };
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, environment);
if (mode === 'missing-server') {
  console.error("Error: Cannot find module '/home/agent/.tauren/server/dist/main.js'");
  process.exit(1);
} else if (mode === 'real') {
  import(pathToFileURL(main).href).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  // Fault injection is confined to the subprocess boundary; normal tests use the
  // actual server, resource discovery, SDK, provider stream and filesystem tools.
  const { createProtocolConnection, Requests, Notifications, PROTOCOL_VERSION } = require(protocol);
  const connection = createProtocolConnection(process.stdin, process.stdout);
  let states = 0;
  for (const [name, request] of Object.entries(Requests)) {
    connection.onRequest(request, async (params, token) => {
      record({ type: 'request', method: request.method, params });
      if (name === 'initialize') return { protocolVersion: PROTOCOL_VERSION,
        serverVersion: '0.0.0', piVersion: '1.5.1', workspace: params.workspace,
        sessionDirectory: params.sessionDirectory, capabilities: Object.values(Requests).map(value => value.method) };
      if (name === 'shutdown') return null;
      if (name === 'getState') {
        if (++states > 1 && mode === 'invalid-state') return { isStreaming: 'not a boolean' };
        return { isStreaming: false, sessionFile: path.join(directory, 'session.jsonl') };
      }
      if (name === 'getMessages' && mode === 'exit') process.exit(23);
      if (name === 'prompt' && mode === 'invalid-event') {
        await connection.sendNotification(Notifications.event, { sequence: 0, event: { type: 42 } });
        return null;
      }
      if (name === 'getCompletions' || (name === 'getMessages' && mode === 'pending')) {
        await connection.sendNotification('fixture.pending', null);
        return new Promise(resolve => token.onCancellationRequested(async () => {
          record({ type: 'cancelled' });
          await connection.sendNotification('fixture.cancelled', null);
          resolve(null);
        }));
      }
      return null;
    });
  }
  connection.listen();
  process.stdin.on('end', () => process.exit(0));
}
