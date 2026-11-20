const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const fixtures = path.join(__dirname, '../fixtures');
const serverDir = '/home/agent/.tauren/server';
const createTimeout = 600_000;
const requestTimeout = 30_000;
const offlineModel = { provider: 'packaged-offline', id: 'scripted' };
const secret = `packaged-sbx-test-canary-${randomUUID()}`;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));

const setupAgent = `
  const fs = require('node:fs');
  const path = require('node:path');
  const [extension] = process.argv.slice(1);
  fs.accessSync(extension, fs.constants.R_OK);
  const agent = process.env.PI_CODING_AGENT_DIR || path.join(require('node:os').homedir(), '.pi/agent');
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({
    defaultProvider: 'packaged-offline', defaultModel: 'scripted', extensions: [extension],
    compaction: { enabled: false }, retry: { enabled: false }
  }));`;

function waitForEvent(subscribe, matches, label) {
  let unsubscribe;
  let timer;
  const promise = new Promise((resolve, reject) => {
    unsubscribe = subscribe(event => { if (matches(event)) resolve(event); });
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), requestTimeout);
  });
  // The event may time out while the action that triggers it is still pending.
  void promise.catch(() => {});
  return { promise, dispose() { clearTimeout(timer); unsubscribe(); } };
}

async function turn(client, prompt) {
  const finished = waitForEvent(listener => client.onEvent(listener), event => event.type === 'agent_settled', 'Pi to finish the offline turn');
  try {
    const model = (await client.getState()).model;
    assert(model?.provider === offlineModel.provider && model.id === offlineModel.id, 'Only the deterministic offline model may receive test prompts');
    await client.prompt(prompt);
    await finished.promise;
    return (await client.getMessages()).messages;
  } finally { finished.dispose(); }
}

async function concurrently(...operations) {
  // Wait for both clients to settle so error cleanup cannot race provisioning.
  const results = await Promise.allSettled(operations);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) {
    // Report the inspection blocker even if another caller fails differently.
    throw results.find(result => result.status === 'rejected' && isSchemaBlocker(result.reason))?.reason ?? failure.reason;
  }
  return results.map(result => result.value);
}

function isSchemaBlocker(error) {
  return error?.kind === 'incompatible' && error.message.includes('Unsupported SBX JSON inspection schema');
}

async function exercisePackagedSandbox({ extension, run, sbx, ssh, t }) {
  extension = await fs.realpath(extension);
  const { SbxClient } = require(path.join(extension, 'out/sbx/sbxClient.js'));
  const { SBX_READINESS_COMMAND } = require(path.join(extension, 'out/sbx/lifecycle.js'));
  assert(typeof SBX_READINESS_COMMAND === 'string' && SBX_READINESS_COMMAND, 'The VSIX must include the lifecycle readiness command used by this test.');
  const mainKit = path.join(extension, 'resources/generated-sbx-sandbox');
  const serverKit = path.join(extension, 'resources/generated-sbx-kit');
  const manifest = await readJson(path.join(serverKit, 'build-manifest.json'));
  const serverHash = createHash('sha256').update(await fs.readFile(path.join(serverKit, manifest.entrypoint))).digest('hex');
  const runSbx = (args, options) => run(sbx, args, options);
  const listNames = async () => {
    const { stdout } = await runSbx(['ls', '--json']);
    let list;
    try { list = JSON.parse(stdout); } catch { /* Reject malformed output without printing it. */ }
    assert(Array.isArray(list) && list.every(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.name === 'string'),
      'Unsupported SBX JSON list schema. Capture sanitized sbx --version and sbx ls --json.');
    return list.map(item => item.name);
  };
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'tauren-packaged-sbx-'));
  try {
    const externalKit = path.join(tmp, 'provider-main-kit');
    const extraMixin = path.join(tmp, 'provider-extra-mixin');
    const extraMarker = randomUUID();
    await fs.cp(mainKit, externalKit, { recursive: true });
    const spec = await fs.readFile(path.join(externalKit, 'spec.yaml'), 'utf8');
    assert.match(spec, /^displayName: Tauren Pi$/m);
    await fs.writeFile(path.join(externalKit, 'spec.yaml'), spec.replace(/^displayName: Tauren Pi$/m, 'displayName: Packaged provider test Pi'));
    await fs.mkdir(path.join(extraMixin, 'files/home'), { recursive: true });
    await fs.writeFile(path.join(extraMixin, 'spec.yaml'), 'schemaVersion: "2"\nkind: mixin\nname: packaged-provider-test\nrequires:\n  agent: pi\n');
    await fs.writeFile(path.join(extraMixin, 'files/home/.tauren-packaged-provider-test'), extraMarker);

    for (const provider of ['default', 'external']) {
      const name = `tauren-vsix-${provider}-${randomUUID()}`;
      // Reserve no preexisting sandbox, even if its workspace happens to match.
      assert(!(await listNames()).includes(name), `Test sandbox ${name} already exists. It will not be touched.`);
      const workspace = path.join(tmp, provider);
      const storageRoot = path.join(tmp, 'store');
      const sessionDirectory = path.join(storageRoot, name, 'sessions');
      const providerCalls = path.join(tmp, 'provider-calls');
      const offlineExtension = path.join(workspace, 'packaged-offline-provider.mjs');
      await fs.mkdir(workspace);
      await fs.copyFile(path.join(fixtures, path.basename(offlineExtension)), offlineExtension);
      const remote = (argv, timeoutMs = requestTimeout) => run(ssh, ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
        `${name}.sbx`, argv.map(quote).join(' ')], { timeoutMs });
      const remoteRead = async file => (await remote(['node', '-e', 'process.stdout.write(require("node:fs").readFileSync(process.argv[1]))', file])).stdout;
      let creations = 0;
      let owned = false;
      let failedCreate = false;
      let setup;
      const clients = [];
      const outbound = [];
      const diagnostics = [];
      const credentialLinks = [];
      const expectedCreate = ['--no-input', 'create', ...(provider === 'external' ? ['--kit', extraMixin] : []),
        '--name', name, '--kit', serverKit, '--env', `PI_CODING_AGENT_SESSION_DIR=${sessionDirectory}`,
        provider === 'external' ? externalKit : mainKit, workspace, sessionDirectory];
      const lifecycle = {
        extensionDirectory: extension, workspace, storageRoot, sandboxName: name,
        workspaceTrusted: true, clientVersion: manifest.extensionVersion,
        expectedPiVersion: manifest.piSdkVersion, expectedServerVersion: manifest.serverVersion,
        sbxExecutable: sbx, sshExecutable: ssh,
        ...(provider === 'external' ? { provider: { executable: process.execPath, args: [
          path.join(fixtures, 'packaged-sbx-command-provider.cjs'), externalKit, extraMixin, providerCalls
        ] } } : {}),
        timeouts: { command: createTimeout, startup: 120_000, handshake: 60_000 },
        onDiagnostic: value => diagnostics.push(value.includes(secret)),
        configureConnection(connection) {
          assert(setup, 'Install the offline provider before initializing the packaged server.');
          // Observe calls on the real message connection without replacing its streams.
          for (const method of ['sendRequest', 'sendNotification']) {
            const send = connection[method].bind(connection);
            connection[method] = (...args) => {
              outbound.push(JSON.stringify(args[1])?.includes(secret) === true);
              return send(...args);
            };
          }
        },
        async runCommand({ executable, args, cwd }, { timeoutMs, signal } = {}) {
          signal?.throwIfAborted();
          if (args[0] === '--no-input' && args[1] === 'create') {
            assert.deepEqual(args, expectedCreate, 'Packaged composition must use the expected kits, mounts, and session environment');
            assert.equal(executable, 'sbx');
            assert.equal(owned, false, 'Tauren must not recreate an existing test sandbox');
            assert(!(await listNames()).includes(name), `Test sandbox ${name} already exists. It will not be touched.`);
            signal?.throwIfAborted();
            // Both providers request the literal sbx command. Execute the real
            // CLI selected by the gate, including when SBX_PATH overrides PATH.
            try {
              const result = await runSbx(args, { cwd, timeoutMs });
              diagnostics.push(result.stderr.includes(secret));
              owned = true;
              creations++;
              return result;
            } catch (error) { failedCreate = true; throw error; }
          }
          const probing = executable === ssh && args.at(-1) === SBX_READINESS_COMMAND;
          assert(!probing || owned, `Refusing SSH to ${name} because this test did not create it.`);
          const result = await run(executable, args, { cwd, timeoutMs });
          diagnostics.push(result.stderr.includes(secret));
          if (probing) {
            // Lifecycle only probes SSH after its own unmodified workspace check.
            // Both clients share setup, and Pi discovers the fixture via agent settings.
            const node = result.stdout.trim();
            if (!path.posix.isAbsolute(node) || /[\r\n\0]/.test(node)) return result; // Let lifecycle reject the probe.
            setup ??= remote([node, '-e', setupAgent, offlineExtension]).catch(error => {
              setup = undefined;
              throw new Error('Could not stage the offline provider in the sandbox Pi agent settings', { cause: error });
            });
            await setup;
          }
          return result;
        }
      };
      function client({ sessionFile, ...overrides } = {}) {
        const instance = new SbxClient({ sessionFile, lifecycle: { ...lifecycle, ...overrides }, requestTimeoutMs: requestTimeout,
          showCredentialDocumentation: url => credentialLinks.push(url) });
        instance.onError(value => diagnostics.push(value.includes(secret)));
        clients.push(instance);
        return instance;
      }
      async function assertProviderCalls(count) {
        if (provider === 'external') {
          assert.equal(await fs.readFile(providerCalls, 'utf8'), `${workspace}\n`.repeat(count), 'Provider runs once per creation in the workspace');
        }
        assert.equal(creations, count);
      }
      async function removeSandbox() {
        if (!owned && !failedCreate) return;
        if (!owned) {
          // A failed create may have left a partial sandbox. Require the same
          // workspace evidence as production before removing such a sandbox.
          if (!(await listNames()).includes(name)) return;
          const { parseSandboxInspection } = require(path.join(extension, 'out/sbx/sbxControl.js'));
          const { stdout } = await runSbx(['inspect', name, '--json']);
          const inspected = parseSandboxInspection(stdout, name);
          assert((await fs.realpath(inspected.workspace)) === workspace, `Cannot establish ownership of ${name}. It was not removed.`);
        }
        await runSbx(['--no-input', 'rm', '--force', name]);
        owned = false;
        failedCreate = false;
        assert(!(await listNames()).includes(name), `Test sandbox ${name} still exists after removal`);
      }
      let failure;
      try {
        const first = client();
        const second = client();
        await concurrently(first.getState(), second.getState());
        await assertProviderCalls(1);
        const remoteHash = await remote(['node', '-e', 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))', `${serverDir}/dist/main.js`]);
        assert.equal(remoteHash.stdout, serverHash, 'The installed server must match the extracted Tauren mixin');
        if (provider === 'external') assert.equal(await remoteRead('/home/agent/.tauren-packaged-provider-test'), extraMarker);
        t.diagnostic(`${provider}: created one Pi sandbox for two concurrent clients and verified the packaged Tauren mixin.`);

        const toolEnds = [];
        const unsubscribe = first.onEvent(event => {
          if (event.type === 'tool_execution_end') toolEnds.push(event.toolName);
        });
        let results;
        try { results = await turn(first, 'tools-roundtrip'); }
        finally { unsubscribe(); }
        const tools = results.filter(message => message.role === 'toolResult');
        const expectedTools = ['write', 'read', 'edit', 'read', 'packaged_echo'];
        assert.deepEqual(tools.map(tool => tool.toolName), expectedTools);
        assert.deepEqual(toolEnds, expectedTools);
        assert(tools.every(tool => tool.isError === false), 'All offline tools must succeed');
        assert.match(JSON.stringify(tools[1].content), /before/);
        assert.match(JSON.stringify(tools[3].content), /after/);
        assert.match(JSON.stringify(tools[4].content), /packaged-peer-success/);
        const toolFile = path.join(workspace, 'packaged-roundtrip.txt');
        assert.equal(await remoteRead(toolFile), 'after\n');
        assert.equal(await fs.readFile(toolFile, 'utf8'), 'after\n');
        const secondHistory = await turn(second, 'source-check');
        assert.equal((await second.getLastAssistantText()).text, `packaged fixture: source=rpc;cwd=${workspace}`);
        const firstFile = (await first.getState()).sessionFile;
        const secondFile = (await second.getState()).sessionFile;
        assert.equal(path.dirname(firstFile), sessionDirectory);
        assert.equal(path.dirname(secondFile), sessionDirectory);
        assert.notEqual(firstFile, secondFile);
        const firstContents = await fs.readFile(firstFile, 'utf8');
        assert.match(firstContents, /tools-roundtrip/);
        assert.match(await fs.readFile(secondFile, 'utf8'), /source=rpc/);
        t.diagnostic(`${provider}: real tools ran over SSH, and independent Pi histories reached the same host session store.`);

        const callsBeforeCredentials = outbound.length;
        await first.loginWithApiKey(offlineModel.provider, secret);
        assert.equal(outbound.length, callsBeforeCredentials, 'Credential guidance must not send an RPC call');
        assert.deepEqual(credentialLinks, ['https://docs.docker.com/ai/sandboxes/credentials/']);

        await second.closeSession();
        const resumed = client({ sessionFile: secondFile });
        const runningPeer = client();
        const [runningHistory] = await concurrently(resumed.getMessages(), runningPeer.getState());
        assert.deepEqual(runningHistory.messages, secondHistory, 'A running sandbox must restore stored history');
        assert.deepEqual((await first.getMessages()).messages, results, 'Opening and closing other clients must not disturb the first client');
        await runningPeer.closeSession();
        await resumed.closeSession();
        await assertProviderCalls(1);

        const otherWorkspace = path.join(tmp, `${provider}-collision`);
        await fs.mkdir(otherWorkspace);
        await assert.rejects(client({ workspace: otherWorkspace }).getState(), error =>
          error.kind === 'incompatible' && /belongs to another workspace/.test(error.message));
        assert.deepEqual((await first.getMessages()).messages, results, 'Workspace collision must leave the existing sandbox untouched');

        const disconnected = waitForEvent(listener => first.onError(listener), message => /Sandbox disconnected/.test(message), 'real SSH disconnect');
        try {
          // Stopping the VM tears down the real transport without a client shutdown.
          await runSbx(['--no-input', 'stop', name], { timeoutMs: requestTimeout });
          await disconnected.promise;
        } finally { disconnected.dispose(); }
        await assert.rejects(first.prompt('must not replay'), /reconnect explicitly/i);
        const stoppedPeer = client({ sessionFile: secondFile });
        const [, stoppedHistory] = await concurrently(first.reconnect(), stoppedPeer.getMessages());
        assert.deepEqual((await first.getMessages()).messages, results);
        assert.deepEqual(stoppedHistory.messages, secondHistory);
        await assertProviderCalls(1);
        await concurrently(first.closeSession(), stoppedPeer.closeSession());
        t.diagnostic(`${provider}: running adoption, workspace collision, and concurrent SSH startup after a real stop preserved history without replay.`);

        await removeSandbox();
        assert.equal(await fs.readFile(firstFile, 'utf8'), firstContents, 'Removing the sandbox must leave host history intact');
        setup = undefined;
        const recreated = client({ sessionFile: firstFile });
        assert.deepEqual((await recreated.getMessages()).messages, results);
        assert.equal((await recreated.getState()).sessionFile, firstFile);
        await assertProviderCalls(2);
        await recreated.closeSession();
        t.diagnostic(`${provider}: explicitly recreated the sandbox and restored Pi history from its original session file.`);

        if (provider === 'default') {
          const metadata = `${serverDir}/package.json`;
          await remote(['node', '-e', 'const fs = require("node:fs"), file = process.argv[1]; const pkg = JSON.parse(fs.readFileSync(file)); pkg.version = "999.0.0"; fs.writeFileSync(file, JSON.stringify(pkg));', metadata]);
          await assert.rejects(client().getState(), error => error.kind === 'incompatible' && /server version mismatch/.test(error.message));
          const entry = `${serverDir}/dist/main.js`;
          await remote(['mv', entry, `${entry}.missing`]);
          await assert.rejects(client().getState(), error => error.kind === 'server' && /Sandbox server handshake failed/.test(error.message));
          await assertProviderCalls(2);
          t.diagnostic('default: rejected incompatible server metadata and a missing server entrypoint without recreating the sandbox.');
        }
        assert(!outbound.includes(true) && !diagnostics.includes(true) && !(await fs.readFile(firstFile, 'utf8')).includes(secret),
          'The synthetic credential must not appear in observed RPC calls, diagnostics, or persisted history');
      } catch (error) {
        failure = error;
        if (isSchemaBlocker(error)) {
          t.diagnostic(`The packaged SBX inspection boundary rejected ${name}; the remaining end-to-end checks were not run. Capture sanitized sbx --version, sbx ls --json, and sbx inspect NAME --json using a separate disposable Pi sandbox. This gate does not bypass workspace validation.`);
        }
      } finally {
        try { await concurrently(...clients.map(instance => instance.closeSession())); }
        catch (error) { failure = failure ? new AggregateError([failure, error], 'Scenario and client cleanup failed') : error; }
        try { await removeSandbox(); }
        catch (error) {
          const cleanup = new Error(`Cleanup could not safely remove test sandbox ${name}. Verify its ownership before removing it manually.`, { cause: error });
          failure = failure ? new AggregateError([failure, cleanup], 'Scenario and sandbox cleanup failed') : cleanup;
        }
      }
      if (failure) throw failure;
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

module.exports = { exercisePackagedSandbox };
