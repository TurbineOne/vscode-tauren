import * as assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeSandboxCommand, type SandboxCommandConfiguration } from '../../sbx/commandComposition';
import { defaultCommandProvider, runCommandProvider, type PiSbxCommandSpecV1 } from '../../sbx/commandProvider';

suite('sbx command composition', () => {
  let root: string;
  let workspace: string;
  let storageRoot: string;
  let serverMixinDirectory: string;
  let kit: string;
  let extra: string;
  let other: string;
  let config: SandboxCommandConfiguration;

  setup(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tauren composition test ')));
    workspace = path.join(root, 'My Project');
    storageRoot = path.join(root, 'tauren-store');
    serverMixinDirectory = path.join(root, 'server mixin');
    kit = path.join(root, 'default kit');
    extra = path.join(root, 'additional workspace');
    other = path.join(root, 'other workspace');
    await Promise.all([workspace, serverMixinDirectory, kit, extra, other]
      .map(directory => mkdir(directory, { recursive: true })));
    config = {
      workspace,
      storageRoot,
      serverMixinDirectory
    };
  });

  teardown(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function spec(overrides: Partial<PiSbxCommandSpecV1> = {}): PiSbxCommandSpecV1 {
    return {
      version: 1,
      command: ['sbx', 'create'],
      agent: kit,
      workspaces: [],
      options: {},
      ...overrides
    };
  }

  test('uses pi-sbx command values including options.name, PI_CODING_AGENT_SESSION_DIR, and PI_CODING_AGENT_DIR instead of Tauren defaults', async () => {
    const providerState = path.join(root, 'pi-sbx-state', 'Custom_Sandbox.1');
    const providerAgents = path.join(providerState, 'agents');
    const providerSessions = path.join(providerState, 'sessions');
    const skillDir = path.join(root, 'skills', 'custom-skill');
    const providerMixin = path.join(root, 'pi-sbx-kit');
    await Promise.all([providerAgents, providerSessions, skillDir, providerMixin].map(dir => mkdir(dir, { recursive: true })));

    const providerResponse: PiSbxCommandSpecV1 = {
      version: 1,
      command: ['sbx', 'create'],
      agent: kit,
      workspaces: [
        workspace,
        providerAgents,
        providerSessions,
        `${skillDir}:ro`
      ],
      options: {
        kit: [providerMixin],
        name: 'Custom_Sandbox.1',
        env: {
          PI_CODING_AGENT_DIR: providerAgents,
          PI_CODING_AGENT_SESSION_DIR: providerSessions
        }
      }
    };

    const composed = await composeSandboxCommand(providerResponse, config);
    assert.strictEqual(composed.sandboxName, 'Custom_Sandbox.1');
    assert.strictEqual(composed.workspace, workspace);
    assert.strictEqual(composed.sessionDirectory, providerSessions);
    assert.deepStrictEqual(composed.env, {
      PI_CODING_AGENT_DIR: providerAgents,
      PI_CODING_AGENT_SESSION_DIR: providerSessions
    });
    assert.strictEqual(composed.executable, 'sbx');
    assert.deepStrictEqual(composed.args, [
      'create',
      kit,
      workspace,
      providerAgents,
      providerSessions,
      `${skillDir}:ro`,
      '--kit', providerMixin,
      '--kit', serverMixinDirectory,
      '--name', 'Custom_Sandbox.1',
      '--env', `PI_CODING_AGENT_DIR=${providerAgents}`,
      '--env', `PI_CODING_AGENT_SESSION_DIR=${providerSessions}`,
      '--no-input'
    ]);
    await assert.rejects(access(storageRoot), { code: 'ENOENT' });
  });

  test('composes the built-in default provider using Tauren defaults when provider omits name, workspaces, and session env', async () => {
    const provider = defaultCommandProvider(kit);
    const expectedSessionDir = path.join(storageRoot, 'my-project', 'sessions');
    const composed = await composeSandboxCommand(provider, config);
    assert.strictEqual(composed.sandboxName, 'my-project');
    assert.strictEqual(composed.sessionDirectory, expectedSessionDir);
    assert.deepStrictEqual(composed.env, {
      PI_CODING_AGENT_SESSION_DIR: expectedSessionDir
    });
    assert.strictEqual(composed.executable, 'sbx');
    assert.deepStrictEqual(composed.args, [
      'create',
      kit,
      workspace,
      expectedSessionDir,
      '--kit', serverMixinDirectory,
      '--name', 'my-project',
      '--env', `PI_CODING_AGENT_SESSION_DIR=${expectedSessionDir}`,
      '--no-input'
    ]);
  });

  test('the default settings command produces the same creation command as the built-in provider', async () => {
    const manifest = require('../../../package.json');
    const provider = manifest.contributes.configuration.properties['tauren.sbx.commandProvider'].default;
    const { response } = await runCommandProvider(provider, { workspace, workspaceTrusted: true });
    assert.deepStrictEqual(
      await composeSandboxCommand(response, { ...config, sandboxKitDirectory: kit }),
      await composeSandboxCommand(defaultCommandProvider(kit), config)
    );
  });

  test('inserts the provider-defined session directory mount when omitted from workspaces', async () => {
    const customSessions = path.join(root, 'custom-sessions');
    const composed = await composeSandboxCommand(spec({
      workspaces: [workspace, `${extra}:ro`],
      options: {
        name: 'provider-named',
        env: { PI_CODING_AGENT_SESSION_DIR: customSessions }
      }
    }), config);
    assert.strictEqual(composed.sandboxName, 'provider-named');
    assert.strictEqual(composed.sessionDirectory, customSessions);
    assert.deepStrictEqual(composed.spec.workspaces, [workspace, customSessions, `${extra}:ro`]);
  });

  test('derives Tauren fallback session path from provider options.name when PI_CODING_AGENT_SESSION_DIR is omitted', async () => {
    const composed = await composeSandboxCommand(spec({
      options: { name: 'Provider_Box' }
    }), config);
    const expectedSessions = path.join(storageRoot, 'Provider_Box', 'sessions');
    assert.strictEqual(composed.sandboxName, 'Provider_Box');
    assert.strictEqual(composed.sessionDirectory, expectedSessions);
  });

  test('explicit Tauren sandboxName override replaces provider options.name while honoring provider PI_CODING_AGENT_SESSION_DIR', async () => {
    const providerSessions = path.join(root, 'staged-sessions');
    const composed = await composeSandboxCommand(spec({
      workspaces: [workspace, providerSessions],
      options: {
        name: 'provider-name',
        env: { PI_CODING_AGENT_SESSION_DIR: providerSessions }
      }
    }), { ...config, sandboxName: 'explicit-override' });
    assert.strictEqual(composed.sandboxName, 'explicit-override');
    assert.strictEqual(composed.sessionDirectory, providerSessions);
    assert.strictEqual(composed.spec.options.name, 'explicit-override');
  });

  test('preserves additional sbx create options and absolute sbx executable without invoking sbx', async () => {
    const executable = path.join(root, 'not installed', 'sbx');
    const mixin = path.join(root, 'third party mixin');
    await mkdir(mixin);
    const expectedSessions = path.join(storageRoot, 'my-project', 'sessions');
    const composed = await composeSandboxCommand(spec({
      command: [executable, 'create'],
      agent: 'vendor/kit:stable',
      workspaces: [workspace, `${extra}:ro`, `${other}:/opt/provider-data:ro`],
      options: {
        kit: ['vendor/feature', mixin],
        env: { MODE: 'two words', LABEL: 'a=b' },
        publish: ['8080:80', '9090:90'],
        cpus: 2,
        memory: '4G',
        clone: false
      }
    }), config);

    assert.strictEqual(composed.executable, executable);
    assert.deepStrictEqual(composed.args, [
      'create',
      'vendor/kit:stable',
      workspace,
      expectedSessions,
      `${extra}:ro`,
      `${other}:/opt/provider-data:ro`,
      '--publish', '8080:80',
      '--publish', '9090:90',
      '--cpus', '2',
      '--memory', '4G',
      '--kit', 'vendor/feature',
      '--kit', mixin,
      '--kit', serverMixinDirectory,
      '--name', 'my-project',
      '--env', 'MODE=two words',
      '--env', 'LABEL=a=b',
      '--env', `PI_CODING_AGENT_SESSION_DIR=${expectedSessions}`,
      '--no-input'
    ]);
  });

  test('rejects clone mode in options', async () => {
    await assert.rejects(
      composeSandboxCommand(spec({ options: { clone: true } }), config),
      /Remove --clone/
    );
  });

  test('rejects conflicting, read-only, or remapped primary workspace mounts', async () => {
    for (const badPrimary of [other, `${workspace}:ro`, `${workspace}:/opt/target`]) {
      await assert.rejects(
        composeSandboxCommand(spec({ workspaces: [badPrimary] }), config),
        /primary workspace/
      );
    }
  });

  test('rejects read-only, remapped, duplicate, or overlapping session directory mounts', async () => {
    const providerSessions = path.join(root, 'pi-sbx-state', 'sessions');
    const parent = path.join(root, 'pi-sbx-state');
    await mkdir(providerSessions, { recursive: true });
    for (const badMounts of [
      [workspace, `${providerSessions}:ro`],
      [workspace, `${providerSessions}:/opt/sessions`],
      [workspace, providerSessions, providerSessions],
      [workspace, parent]
    ]) {
      await assert.rejects(
        composeSandboxCommand(spec({
          workspaces: badMounts,
          options: { env: { PI_CODING_AGENT_SESSION_DIR: providerSessions } }
        }), config),
        /Session directory|Repeated|conflicts/
      );
    }
  });

  test('rejects owned mixins and duplicate provider mixins through canonical symlink paths', async () => {
    const alias = path.join(root, 'server alias');
    const kitAlias = path.join(root, 'kit alias');
    await Promise.all([symlink(serverMixinDirectory, alias), symlink(kit, kitAlias)]);
    for (const value of [serverMixinDirectory, alias]) {
      await assert.rejects(composeSandboxCommand(spec({ options: { kit: [value] } }), config), /omit Tauren server mixin/);
      await assert.rejects(composeSandboxCommand(spec({ agent: value }), config), /cannot be the main sandbox kit/);
    }
    await assert.rejects(composeSandboxCommand(spec({ options: { kit: [kit, kitAlias] } }), config), /Repeated provider mixin/);
    await assert.rejects(composeSandboxCommand(spec({ options: { kit: ['vendor/extra', 'vendor/extra'] } }), config), /Repeated provider mixin/);
  });

  test('rejects additional workspace mounts that overlap the primary workspace', async () => {
    const alias = path.join(root, 'workspace alias');
    await symlink(workspace, alias);
    for (const mount of [workspace, alias, `${alias}:/opt/disguised:ro`, root, `${extra}:${workspace}:ro`, `${extra}:/:ro`]) {
      await assert.rejects(
        composeSandboxCommand(spec({ workspaces: [workspace, mount] }), config),
        /conflicts with Tauren primary workspace/
      );
    }
  });

  test('rejects repeated canonical mount sources and overlapping additional mount targets', async () => {
    const alias = path.join(root, 'extra alias');
    await symlink(extra, alias);
    await assert.rejects(
      composeSandboxCommand(spec({ workspaces: [workspace, `${extra}:/opt/one`, `${alias}:/opt/two`] }), config),
      /Repeated additional workspace/
    );
    await assert.rejects(
      composeSandboxCommand(spec({ workspaces: [workspace, `${extra}:/opt/data`, `${other}:/opt/unused/../data`] }), config),
      /Repeated additional workspace/
    );
    await assert.rejects(
      composeSandboxCommand(spec({ workspaces: [workspace, `${extra}:/opt/data`, `${other}:/opt/data/nested`] }), config),
      /Overlapping additional workspace/
    );
  });

  test('canonicalizes owned and provider paths through symlinks without creating directories', async () => {
    const alias = path.join(root, 'root alias');
    await symlink(root, alias);
    const futureSessions = path.join(alias, 'future', 'sessions');
    const futureAgents = path.join(alias, 'future', 'agents');
    const composed = await composeSandboxCommand(spec({
      options: {
        env: {
          PI_CODING_AGENT_DIR: futureAgents,
          PI_CODING_AGENT_SESSION_DIR: futureSessions
        }
      }
    }), {
      ...config,
      workspace: path.join(alias, 'My Project')
    });
    const canonicalSessions = path.join(root, 'future', 'sessions');
    const canonicalAgents = path.join(root, 'future', 'agents');
    assert.strictEqual(composed.workspace, workspace);
    assert.strictEqual(composed.sessionDirectory, canonicalSessions);
    assert.strictEqual(composed.env.PI_CODING_AGENT_DIR, canonicalAgents);
    await assert.rejects(access(canonicalSessions), { code: 'ENOENT' });
  });

  test('rejects a provider or fallback session directory inside the workspace after canonicalization', async () => {
    const alias = path.join(root, 'workspace alias');
    await symlink(workspace, alias);
    await assert.rejects(composeSandboxCommand(spec({
      options: { env: { PI_CODING_AGENT_SESSION_DIR: path.join(alias, 'sessions') } }
    }), config), /Session directory must be outside workspace/);
    await assert.rejects(composeSandboxCommand(spec(), {
      ...config,
      sessionDirectory: path.join(alias, 'sessions')
    }), /Session directory must be outside workspace/);
  });

  for (const command of [
    ['sh', 'create'],
    ['relative/sbx', 'create'],
    ['/bin/not-sbx', 'create']
  ]) {
    test(`rejects non-sbx executable ${JSON.stringify(command[0])}`, async () => {
      await assert.rejects(composeSandboxCommand(spec({ command }), config), /Provider executable must be sbx/);
    });
  }

  for (const command of [
    ['sbx', 'exec'],
    ['sbx', 'run'],
    ['sbx', 'create', 'extra']
  ]) {
    test(`rejects unsupported command ${JSON.stringify(command)}`, async () => {
      await assert.rejects(composeSandboxCommand(spec({ command }), config), /Provider command must describe sbx create/);
    });
  }

  for (const name of ['', '-leading', '.leading', '_leading', 'bad.sbx', 'two words', 'a/b', 'x'.repeat(64), 'a;touch bad', 'a\0b']) {
    test(`rejects invalid sandbox name ${JSON.stringify(name)}`, async () => {
      await assert.rejects(composeSandboxCommand(spec(), { ...config, sandboxName: name }), /Invalid sandbox name/);
      if (name && !name.includes('\0')) {
        await assert.rejects(composeSandboxCommand(spec({ options: { name } }), config), /Invalid sandbox name/);
      }
    });
  }

  test('accepts one-character, 63-character, and pi-sbx character-class sandbox names', async () => {
    for (const sandboxName of ['a', 'a'.repeat(63), 'My_Repo-1.2']) {
      const result = await composeSandboxCommand(spec({ options: { name: sandboxName } }), config);
      assert.strictEqual(result.sandboxName, sandboxName);
      assert.strictEqual(result.args[result.args.indexOf('--name') + 1], sandboxName);
    }
  });

  for (const key of ['=value', 'BAD-NAME', '1MODE']) {
    test(`rejects invalid environment variable name ${key}`, async () => {
      await assert.rejects(
        composeSandboxCommand(spec({ options: { env: { [key]: 'value' } } }), config),
        /Invalid.*environment/
      );
    });
  }

  for (const key of ['API_KEY', 'access_token', 'MY_SECRET', 'PASSWORD', 'credential_file']) {
    test(`rejects credential environment key ${key}`, async () => {
      await assert.rejects(
        composeSandboxCommand(spec({ options: { env: { [key]: 'sensitive' } } }), config),
        /must not supply credential environment/
      );
    });
  }

  test('rejects malformed or nonabsolute additional workspace forms', async () => {
    for (const mount of [`${extra}:`, `${extra}::ro`, `${extra}:/opt/data:rw`, `${extra}:ro:ro`, `${extra}:/opt/data:ro:extra`]) {
      await assert.rejects(composeSandboxCommand(spec({ workspaces: [workspace, mount] }), config), /Invalid workspace mount/);
    }
    for (const mount of ['relative/workspace', `${extra}:relative-target`]) {
      await assert.rejects(composeSandboxCommand(spec({ workspaces: [workspace, mount] }), config), /absolute POSIX/);
    }
  });

  test('keeps spaces and shell metacharacters literal without shell expansion or side effects', async () => {
    const sentinel = path.join(root, 'shell-sentinel');
    const literal = `two words; $(touch "${sentinel}") & | > * $HOME \`touch shell-sentinel\``;
    const mount = path.join(root, 'data ; $(not-executed) & space');
    await mkdir(mount);
    const composed = await composeSandboxCommand(spec({
      agent: literal,
      workspaces: [workspace, mount],
      options: { env: { LABEL: literal } }
    }), config);
    assert.ok(composed.args.includes(literal));
    assert.ok(composed.args.includes(`LABEL=${literal}`));
    assert.ok(composed.args.includes(mount));
    await assert.rejects(access(sentinel), { code: 'ENOENT' });
    await assert.rejects(access(path.join(workspace, 'shell-sentinel')), { code: 'ENOENT' });
  });
});
