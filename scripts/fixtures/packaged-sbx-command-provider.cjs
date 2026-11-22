// Emulates `pi-sbx command`: emits a Version 1 command specification without creating directories or invoking SBX.
const { appendFileSync } = require('node:fs');
const path = require('node:path');

const [mainKit, extraMixin, stateRoot, sandboxName, calls] = process.argv.slice(2);
const workspace = process.cwd();
const sandboxState = path.join(stateRoot, sandboxName);
const agentsDir = path.join(sandboxState, 'agents');
const sessionsDir = path.join(sandboxState, 'sessions');

appendFileSync(calls, `${workspace}\n`);

process.stdout.write(`${JSON.stringify({
  version: 1,
  command: ['sbx', 'create'],
  agent: mainKit,
  workspaces: [
    workspace,
    agentsDir,
    sessionsDir
  ],
  options: {
    kit: [extraMixin],
    name: sandboxName,
    env: {
      PI_CODING_AGENT_DIR: agentsDir,
      PI_CODING_AGENT_SESSION_DIR: sessionsDir
    }
  }
})}\n`);
