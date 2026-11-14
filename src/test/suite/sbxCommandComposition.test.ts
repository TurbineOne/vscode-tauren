import * as assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { composeSandboxCommand, type SandboxCommandConfiguration } from '../../sbx/commandComposition';
import { defaultCommandProvider, type CommandProviderResult } from '../../sbx/commandProvider';

suite('sbx command composition', () => {
  let root: string;
  let config: SandboxCommandConfiguration;
  let kit: string;
  let extra: string;
  let other: string;

  setup(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tauren composition test ')));
    config = {
      sandboxName: 'tauren-test-1',
      workspace: path.join(root, 'primary workspace'),
      sessionDirectory: path.join(root, 'session store'),
      serverMixinDirectory: path.join(root, 'server mixin')
    };
    kit = path.join(root, 'default kit');
    extra = path.join(root, 'additional workspace');
    other = path.join(root, 'other workspace');
    await Promise.all([config.workspace, config.sessionDirectory, config.serverMixinDirectory, kit, extra, other]
      .map(directory => mkdir(directory, { recursive: true })));
  });

  teardown(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  function response(...argv: string[]): CommandProviderResult { return { version: 1, argv }; }
  function compose(...argv: string[]) { return composeSandboxCommand(response(...argv), config); }
  function ownedArgs(): string[] {
    return ['--name', config.sandboxName, '--kit', config.serverMixinDirectory,
      '--env', `PI_CODING_AGENT_SESSION_DIR=${config.sessionDirectory}`];
  }

  test('composes the default provider path with the primary workspace before store and provider mounts', async () => {
    const provider = defaultCommandProvider(kit);
    const original = [...provider.argv];
    assert.deepStrictEqual(await composeSandboxCommand(provider, config), {
      executable: 'sbx',
      args: ['--no-input', 'create', ...ownedArgs(), kit, config.workspace, config.sessionDirectory]
    });
    assert.deepStrictEqual(provider.argv, original, 'composition must not mutate provider argv');
  });

  test('preserves option/value pairs and order even when options follow positionals', async () => {
    assert.deepStrictEqual(await compose('sbx', 'create', kit, extra, '--env', 'MODE=two words',
      '--publish', '8080:80', '--cpus', '2', '--clone', '--memory', '4G', '--no-input'), {
      executable: 'sbx',
      args: ['--no-input', 'create', '--env', 'MODE=two words', '--publish', '8080:80',
        '--cpus', '2', '--clone', '--memory', '4G', ...ownedArgs(), kit,
        config.workspace, config.sessionDirectory, extra]
    });
  });

  for (const detach of ['-d', '--detach']) {
    test(`composes detached run with ${detach} and an absolute sbx executable without executing it`, async () => {
      // The executable intentionally does not exist. Composition is async for filesystem
      // canonicalization only: it returns data and must never spawn SBX.
      const executable = path.join(root, 'not installed', 'sbx');
      assert.deepStrictEqual(await compose(executable, '--no-input', 'run', kit, detach, '-p', '8081:81', '-m', '512m'), {
        executable,
        args: ['--no-input', 'run', detach, '-p', '8081:81', '-m', '512m', ...ownedArgs(),
          kit, config.workspace, config.sessionDirectory]
      });
    });
  }

  test('composes a third-party main kit, repeatable mixins, env, publishes and literal mount forms', async () => {
    const mixin = path.join(root, 'third party mixin');
    await mkdir(mixin);
    const mounts = [`${extra}:ro`, `${other}:/opt/provider-data:ro`];
    assert.deepStrictEqual(await compose('sbx', 'run', 'vendor/kit:stable', mounts[0],
      '--kit', 'vendor/feature', '-d', '--kit', mixin, mounts[1], '-e', 'MODE=dev',
      '--env', 'LABEL=a=b', '-p', '8080:80', '--publish', '9090:90'), {
      executable: 'sbx',
      args: ['--no-input', 'run', '--kit', 'vendor/feature', '-d', '--kit', mixin,
        '-e', 'MODE=dev', '--env', 'LABEL=a=b', '-p', '8080:80', '--publish', '9090:90',
        ...ownedArgs(), 'vendor/kit:stable', config.workspace, config.sessionDirectory, ...mounts]
    });
    assert.deepStrictEqual(await compose('sbx', 'create', kit, `${extra}:/opt/provider-data`), {
      executable: 'sbx', args: ['--no-input', 'create', ...ownedArgs(), kit,
        config.workspace, config.sessionDirectory, `${extra}:/opt/provider-data`]
    });
  });

  test('accepts the same name once without inserting a second name', async () => {
    assert.deepStrictEqual(await compose('sbx', 'create', kit, '--name', config.sandboxName), {
      executable: 'sbx',
      args: ['--no-input', 'create', '--name', config.sandboxName, '--kit', config.serverMixinDirectory,
        '--env', `PI_CODING_AGENT_SESSION_DIR=${config.sessionDirectory}`, kit,
        config.workspace, config.sessionDirectory]
    });
  });

  test('rejects a conflicting name', async () => {
    await assert.rejects(compose('sbx', 'create', kit, '--name', 'someone-else'), /name conflicts/);
  });

  for (const [label, command, options] of [
    ['name', 'create', ['--name', 'tauren-test-1', '--name', 'tauren-test-1']],
    ['detach aliases', 'run', ['-d', '--detach']],
    ['memory aliases', 'create', ['-m', '1g', '--memory', '2g']],
    ['clone', 'create', ['--clone', '--clone']],
    ['CPU count', 'create', ['--cpus', '1', '--cpus', '2']],
    ['no-input', 'create', ['--no-input', '--no-input']]
  ] as const) {
    test(`rejects repeated ${label}`, async () => {
      await assert.rejects(compose('sbx', command, kit, ...options), /Repeated/);
    });
  }

  test('rejects no-input repeated across the subcommand boundary', async () => {
    await assert.rejects(compose('sbx', '--no-input', 'create', kit, '--no-input'), /Repeated --no-input/);
  });

  test('rejects duplicate environment assignments across aliases', async () => {
    await assert.rejects(compose('sbx', 'create', kit, '-e', 'MODE=dev', '--env', 'MODE=prod'), /Repeated provider environment/);
  });

  test('rejects Tauren-owned environment whether explicit or inherited', async () => {
    for (const value of ['PI_CODING_AGENT_SESSION_DIR', 'PI_CODING_AGENT_SESSION_DIR=/other']) {
      await assert.rejects(compose('sbx', 'create', kit, '--env', value), /omit Tauren session environment/);
    }
  });

  test('rejects owned mixins and duplicate provider mixins through canonical symlink paths', async () => {
    const alias = path.join(root, 'server alias');
    const kitAlias = path.join(root, 'kit alias');
    await Promise.all([symlink(config.serverMixinDirectory, alias), symlink(kit, kitAlias)]);
    for (const value of [config.serverMixinDirectory, alias]) {
      await assert.rejects(compose('sbx', 'create', kit, '--kit', value), /omit Tauren server mixin/);
      await assert.rejects(compose('sbx', 'create', value), /cannot be the main sandbox kit/);
    }
    await assert.rejects(compose('sbx', 'create', kit, '--kit', kit, '--kit', kitAlias), /Repeated provider mixin/);
    await assert.rejects(compose('sbx', 'create', kit, '--kit', 'vendor/extra', '--kit', 'vendor/extra'), /Repeated provider mixin/);
  });

  test('rejects owned mount sources including symlinks, alternate targets and broader host mounts', async () => {
    const alias = path.join(root, 'workspace alias');
    const storeAlias = path.join(root, 'store alias');
    await Promise.all([symlink(config.workspace, alias), symlink(config.sessionDirectory, storeAlias)]);
    for (const mount of [config.workspace, config.sessionDirectory, alias, storeAlias,
      `${alias}:/opt/disguised:ro`, `${storeAlias}:/opt/store`, root]) {
      await assert.rejects(compose('sbx', 'create', kit, mount), /conflicts with Tauren-owned/);
    }
  });

  test('rejects provider targets equal to, containing, or nested under either owned mount', async () => {
    for (const target of [config.workspace, config.sessionDirectory, root, '/',
      path.join(config.workspace, 'nested'), path.join(config.sessionDirectory, 'nested')]) {
      await assert.rejects(compose('sbx', 'create', kit, `${extra}:${target}:ro`), /conflicts with Tauren-owned/);
    }
  });

  test('rejects repeated canonical mount sources and normalized mount targets', async () => {
    const alias = path.join(root, 'extra alias');
    await symlink(extra, alias);
    await assert.rejects(compose('sbx', 'create', kit, `${extra}:/opt/one`, `${alias}:/opt/two`), /Repeated additional workspace/);
    await assert.rejects(compose('sbx', 'create', kit, `${extra}:/opt/data`, `${other}:/opt/unused/../data`), /Repeated additional workspace/);
  });

  test('rejects overlapping targets between additional provider mounts', async () => {
    await assert.rejects(compose('sbx', 'create', kit, `${extra}:/opt/data`, `${other}:/opt/data/nested`), /workspace/);
  });

  test('canonicalizes owned paths through symlinks and resolves not-yet-created session parents', async () => {
    const alias = path.join(root, 'root alias');
    await symlink(root, alias);
    const sessionDirectory = path.join(alias, 'future', 'sessions');
    const result = await composeSandboxCommand(response('sbx', 'create', kit), {
      ...config, workspace: path.join(alias, 'primary workspace'), sessionDirectory
    });
    const canonicalSessions = path.join(root, 'future', 'sessions');
    assert.deepStrictEqual(result.args, ['--no-input', 'create', '--name', config.sandboxName,
      '--kit', config.serverMixinDirectory, '--env', `PI_CODING_AGENT_SESSION_DIR=${canonicalSessions}`,
      kit, config.workspace, canonicalSessions]);
    await assert.rejects(access(canonicalSessions), { code: 'ENOENT' });
  });

  test('rejects a session directory inside the workspace after canonicalization', async () => {
    const alias = path.join(root, 'workspace alias');
    await symlink(config.workspace, alias);
    await assert.rejects(composeSandboxCommand(response('sbx', 'create', kit), {
      ...config, sessionDirectory: path.join(alias, 'sessions')
    }), /Session directory must be outside workspace/);
  });

  for (const option of ['--unknown', '--shell', '--name=tauren-test-1', '--memory=1g', '-dp', '-m512m', '--']) {
    test(`rejects unsupported option syntax ${option}`, async () => {
      await assert.rejects(compose('sbx', 'create', kit, option), /Unsupported SBX provider option/);
    });
  }

  for (const argv of [
    ['sh', '-c', 'sbx create kit'], ['bash', '-lc', 'sbx create kit'],
    ['relative/sbx', 'create', 'kit'], ['/bin/not-sbx', 'create', 'kit'],
    ['sbx create kit', 'create', 'kit']
  ]) {
    test(`rejects shell/non-sbx executable ${JSON.stringify(argv[0])}`, async () => {
      await assert.rejects(compose(...argv), /Provider executable must be sbx/);
    });
  }

  for (const argv of [
    ['sbx', 'exec', 'kit'], ['sbx', '--detach', 'run', 'kit'], ['sbx', 'create -d', 'kit']
  ]) {
    test(`rejects unsupported command placement ${JSON.stringify(argv)}`, async () => {
      await assert.rejects(compose(...argv), /Provider must describe sbx create or sbx run -d/);
    });
  }

  test('rejects string-form commands instead of parsing shell syntax', async () => {
    const malformed = { version: 1, argv: 'sbx create kit' } as unknown as CommandProviderResult;
    await assert.rejects(composeSandboxCommand(malformed, config), /argv must be an array/);
  });

  test('rejects run without detach and detach on create', async () => {
    await assert.rejects(compose('sbx', 'run', kit), /run must specify -d or --detach/);
    await assert.rejects(compose('sbx', 'create', '-d', kit), /detach applies only to sbx run/);
  });

  test('requires a positional main kit, not just a mixin option', async () => {
    for (const argv of [['sbx', 'create'], ['sbx', 'create', '--kit', kit], ['sbx', 'run', '-d']]) {
      await assert.rejects(compose(...argv), /must supply a main sandbox kit/);
    }
  });

  for (const name of ['', '-leading', 'Uppercase', 'under_score', 'two words', 'a/b', 'x'.repeat(64), 'a;touch bad', 'a\0b']) {
    test(`rejects invalid sandbox name ${JSON.stringify(name)}`, async () => {
      await assert.rejects(composeSandboxCommand(response('sbx', 'create', kit), { ...config, sandboxName: name }), /Invalid sandbox name/);
    });
  }

  test('accepts the one-character and 63-character sandbox name boundaries', async () => {
    for (const sandboxName of ['a', 'a'.repeat(63)]) {
      const result = await composeSandboxCommand(response('sbx', 'create', kit), { ...config, sandboxName });
      assert.strictEqual(result.args[result.args.indexOf('--name') + 1], sandboxName);
    }
  });

  for (const option of ['--name', '--kit', '--env', '-e', '--publish', '-p', '--cpus', '--memory', '-m']) {
    test(`rejects missing or flag-shaped value for ${option}`, async () => {
      await assert.rejects(compose('sbx', 'create', kit, option), /Missing value/);
      await assert.rejects(compose('sbx', 'create', kit, option, '--clone'), /Missing value/);
    });
  }

  for (const value of ['MODE', '=value', 'BAD-NAME=value', '1MODE=value']) {
    test(`rejects non-explicit or invalid environment assignment ${value}`, async () => {
      await assert.rejects(compose('sbx', 'create', kit, '--env', value), /requires explicit KEY=VALUE/);
    });
  }

  for (const key of ['API_KEY', 'access_token', 'MY_SECRET', 'PASSWORD', 'credential_file']) {
    test(`rejects credential environment key ${key}`, async () => {
      await assert.rejects(compose('sbx', 'create', kit, '-e', `${key}=sensitive`), /must not supply credential environment/);
    });
  }

  test('rejects invalid CPU counts and memory sizes', async () => {
    for (const value of ['1.5', 'many', '+2']) {
      await assert.rejects(compose('sbx', 'create', kit, '--cpus', value), /Invalid CPU count/);
    }
    for (const value of ['1.5g', '1gb', 'lots']) {
      await assert.rejects(compose('sbx', 'create', kit, '-m', value), /Invalid memory size/);
    }
  });

  test('rejects malformed or nonabsolute additional workspace forms', async () => {
    for (const mount of [`${extra}:`, `${extra}::ro`, `${extra}:/opt/data:rw`, `${extra}:ro:ro`, `${extra}:/opt/data:ro:extra`]) {
      await assert.rejects(compose('sbx', 'create', kit, mount), /Invalid additional workspace/);
    }
    for (const mount of ['relative/workspace', `${extra}:relative-target`]) {
      await assert.rejects(compose('sbx', 'create', kit, mount), /absolute POSIX paths without colons/);
    }
  });

  test('rejects invalid controlled paths', async () => {
    for (const field of ['workspace', 'sessionDirectory', 'serverMixinDirectory'] as const) {
      for (const value of ['relative/path', '/path:with-colon', '/path\0bad']) {
        await assert.rejects(composeSandboxCommand(response('sbx', 'create', kit), {
          ...config, [field]: value
        }), /absolute POSIX paths without colons/);
      }
    }
  });

  test('keeps spaces and shell metacharacters literal without shell expansion or side effects', async () => {
    const sentinel = path.join(root, 'shell-sentinel');
    const literal = `two words; $(touch "${sentinel}") & | > * $HOME \`touch shell-sentinel\``;
    const mount = path.join(root, 'data ; $(not-executed) & space');
    await mkdir(mount);
    assert.deepStrictEqual(await compose('sbx', 'create', literal, '--env', `LABEL=${literal}`, mount), {
      executable: 'sbx',
      args: ['--no-input', 'create', '--env', `LABEL=${literal}`, ...ownedArgs(), literal,
        config.workspace, config.sessionDirectory, mount]
    });
    await assert.rejects(access(sentinel), { code: 'ENOENT' });
    await assert.rejects(access(path.join(config.workspace, 'shell-sentinel')), { code: 'ENOENT' });
  });
});
