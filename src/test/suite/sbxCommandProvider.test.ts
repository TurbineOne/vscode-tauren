import * as assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildSbxCreateArgv,
  defaultCommandProvider,
  parseCommandProviderResponse,
  runCommandProvider,
  validateCommandProviderSpec,
  type CommandProviderConfiguration,
  type PiSbxCommandSpecV1,
  type ProviderExecutionOptions
} from '../../sbx/commandProvider';

function validSpec(overrides: Partial<PiSbxCommandSpecV1> = {}): PiSbxCommandSpecV1 {
  return {
    version: 1,
    command: ['sbx', 'create'],
    agent: '/home/alice/.pi-sbx/cache/base-kits/76e9e67a28516823282169237f390ccc2a54f76b466b719da55567f3fa08f897',
    workspaces: [
      '/home/alice/src/my-project',
      '/home/alice/.pi-sbx/sandboxes/my-project/agents',
      '/home/alice/.pi-sbx/sandboxes/my-project/sessions',
      '/home/alice/skills/custom-skill:ro'
    ],
    options: {
      kit: ['/home/alice/.pi-sbx/kit'],
      name: 'my-project',
      env: {
        PI_CODING_AGENT_DIR: '/home/alice/.pi-sbx/sandboxes/my-project/agents',
        PI_CODING_AGENT_SESSION_DIR: '/home/alice/.pi-sbx/sandboxes/my-project/sessions'
      }
    },
    ...overrides
  };
}

suite('sbx command provider', () => {
  suite('response parsing and argv construction', () => {
    test('parses a pi-sbx command Version 1 JSON object and constructs the exact sbx create argv', () => {
      const spec = validSpec();
      const parsed = parseCommandProviderResponse(` \n${JSON.stringify(spec)}\n`);
      assert.deepStrictEqual(parsed, spec);
      assert.deepStrictEqual(buildSbxCreateArgv(parsed), [
        'sbx',
        'create',
        spec.agent,
        ...spec.workspaces,
        '--kit',
        '/home/alice/.pi-sbx/kit',
        '--name',
        'my-project',
        '--env',
        'PI_CODING_AGENT_DIR=/home/alice/.pi-sbx/sandboxes/my-project/agents',
        '--env',
        'PI_CODING_AGENT_SESSION_DIR=/home/alice/.pi-sbx/sandboxes/my-project/sessions'
      ]);
    });

    test('serializes boolean, string, number, array, and map options while omitting false, null, and undefined', () => {
      const spec = validSpec({
        agent: '/kits/kit with spaces;$(touch sentinel);雪',
        workspaces: ['/workspace'],
        options: {
          kit: ['/kits/one', '/kits/two'],
          name: 'my-project',
          env: { MODE: 'two words', EMPTY: '' },
          'no-input': true,
          clone: false,
          omittedNull: null,
          omittedUndefined: undefined,
          cpus: 4,
          memory: '4g',
          publish: ['8080:80', '9090:90']
        }
      });
      assert.deepStrictEqual(buildSbxCreateArgv(spec), [
        'sbx',
        'create',
        '/kits/kit with spaces;$(touch sentinel);雪',
        '/workspace',
        '--kit', '/kits/one',
        '--kit', '/kits/two',
        '--name', 'my-project',
        '--env', 'MODE=two words',
        '--env', 'EMPTY=',
        '--no-input',
        '--cpus', '4',
        '--memory', '4g',
        '--publish', '8080:80',
        '--publish', '9090:90'
      ]);
    });

    test('defensively clones arrays and nested option maps', () => {
      const input = validSpec();
      const parsed = validateCommandProviderSpec(input);
      parsed.command.push('mutated');
      parsed.workspaces.push('/mutated');
      parsed.options.kit!.push('/mutated');
      parsed.options.env!.MUTATED = '1';
      assert.strictEqual(input.command.length, 2);
      assert.strictEqual(input.workspaces.length, 4);
      assert.deepStrictEqual(input.options.kit, ['/home/alice/.pi-sbx/kit']);
      assert.strictEqual(Object.hasOwn(input.options.env!, 'MUTATED'), false);
    });

    for (const [name, stdout] of [
      ['empty output', ''],
      ['malformed JSON', '{'],
      ['a leading banner', `provider ready\n${JSON.stringify(validSpec())}`],
      ['a trailing banner', `${JSON.stringify(validSpec())}\nfinished`],
      ['multiple objects', `${JSON.stringify(validSpec())}\n{}`]
    ]) {
      test(`rejects ${name}`, () => {
        assert.throws(() => parseCommandProviderResponse(stdout), /must print one JSON object/);
      });
    }

    for (const value of [null, true, 1, 'response', []]) {
      test(`rejects non-object response ${JSON.stringify(value)}`, () => {
        assert.throws(() => parseCommandProviderResponse(JSON.stringify(value)), /Invalid sandbox command provider response/);
      });
    }

    for (const version of [undefined, 0, 2, '1', null]) {
      test(`rejects unsupported version ${String(version)}`, () => {
        assert.throws(() => parseCommandProviderResponse(JSON.stringify({ ...validSpec(), version })), /Unsupported.*version/);
        assert.throws(() => buildSbxCreateArgv({ ...validSpec(), version: version as 1 }), /Unsupported.*version/);
      });
    }

    for (const [name, value] of [
      ['legacy flat argv shape', { version: 1, argv: ['sbx', 'create'] }],
      ['extra top-level fields', { ...validSpec(), secret: 'not allowed' }],
      ['missing options', { version: 1, command: ['sbx', 'create'], agent: '/kit', workspaces: [] }],
      ['single-token command', { ...validSpec(), command: ['sbx'] }],
      ['empty command token', { ...validSpec(), command: ['sbx', ''] }],
      ['NUL command token', { ...validSpec(), command: ['sbx', 'create\0bad'] }],
      ['empty agent', { ...validSpec(), agent: '' }],
      ['NUL agent', { ...validSpec(), agent: '/kit\0bad' }],
      ['non-array workspaces', { ...validSpec(), workspaces: '/workspace' }],
      ['empty workspace entry', { ...validSpec(), workspaces: [''] }],
      ['NUL workspace entry', { ...validSpec(), workspaces: ['/ws\0bad'] }],
      ['array options', { ...validSpec(), options: [] }],
      ['leading-dash option key', { ...validSpec(), options: { '--kit': ['/kit'] } }],
      ['short-dash option key', { ...validSpec(), options: { '-e': { A: '1' } } }],
      ['string options.kit', { ...validSpec(), options: { kit: '/kit' } }],
      ['empty options.kit entry', { ...validSpec(), options: { kit: [''] } }],
      ['empty options.name', { ...validSpec(), options: { name: '' } }],
      ['array options.env', { ...validSpec(), options: { env: ['A=1'] } }],
      ['env key with equals', { ...validSpec(), options: { env: { 'A=B': '1' } } }],
      ['NUL env value', { ...validSpec(), options: { env: { A: 'bad\0val' } } }],
      ['nested object option value', { ...validSpec(), options: { custom: { nested: { bad: '1' } } } }]
    ] as const) {
      test(`rejects ${name}`, () => {
        assert.throws(() => parseCommandProviderResponse(JSON.stringify(value)));
      });
    }

    test('rejects non-finite numeric options from programmatic callers', () => {
      assert.throws(() => validateCommandProviderSpec({ ...validSpec(), options: { cpus: Number.NaN } }), /numeric option/);
      assert.throws(() => validateCommandProviderSpec({ ...validSpec(), options: { cpus: Number.POSITIVE_INFINITY } }), /numeric option/);
    });
  });

  suite('default provider', () => {
    test('returns the packaged kit as a Version 1 spec without spawning sbx', () => {
      const kit = '/extension with spaces/kit;$(not-a-command)';
      const result = defaultCommandProvider(kit);
      assert.deepStrictEqual(result, {
        version: 1,
        command: ['sbx', 'create'],
        agent: kit,
        workspaces: [],
        options: { 'no-input': true }
      });
      result.command.push('changed');
      assert.deepStrictEqual(defaultCommandProvider(kit).command, ['sbx', 'create']);
    });

    for (const kit of ['', 'relative/kit', '/kit\0bad']) {
      test(`rejects invalid kit path ${JSON.stringify(kit)}`, () => {
        assert.throws(() => defaultCommandProvider(kit), /path must be absolute/);
      });
    }
  });

  suite('real provider processes', function () {
    this.timeout(10_000);
    let workspace: string;

    setup(async () => {
      workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tauren provider test ')));
    });

    teardown(async () => {
      await rm(workspace, { recursive: true, force: true });
    });

    async function provider(source: string): Promise<CommandProviderConfiguration> {
      const script = path.join(workspace, 'provider script with spaces.cjs');
      await writeFile(script, source);
      return { executable: process.execPath, args: [script] };
    }

    function options(overrides: Partial<ProviderExecutionOptions> = {}): ProviderExecutionOptions {
      return { workspace, workspaceTrusted: true, timeoutMs: 3_000, ...overrides };
    }

    test('executes executable and args literally, preserves cwd, and never invokes a shell', async () => {
      const sentinel = path.join(workspace, 'shell-sentinel');
      const configuration = await provider(`
        process.stdout.write(JSON.stringify({
          version: 1,
          command: ['sbx', 'create'],
          agent: '/kit',
          workspaces: [process.cwd()],
          options: { kit: process.argv.slice(2).filter(Boolean) }
        }));
      `);
      const args = ['argument with spaces', '', `; touch "${sentinel}"`, `$(touch "${sentinel}")`, '`touch shell-sentinel`', 'a&b|c>d', '*', '$HOME', '"quoted"'];
      configuration.args.push(...args);
      const result = await runCommandProvider(configuration, options());
      assert.deepStrictEqual(result, {
        response: {
          version: 1,
          command: ['sbx', 'create'],
          agent: '/kit',
          workspaces: [workspace],
          options: { kit: args.filter(Boolean) }
        },
        stderr: ''
      });
      await assert.rejects(access(sentinel), { code: 'ENOENT' });
    });

    test('allows an empty configured argument without dropping it', async () => {
      const configuration = await provider(`
        process.stdout.write(JSON.stringify({
          version: 1,
          command: ['sbx', 'create'],
          agent: '/kit',
          workspaces: [],
          options: { label: JSON.stringify(process.argv.slice(2)) }
        }));
      `);
      configuration.args.push('', 'two words');
      const result = await runCommandProvider(configuration, options());
      assert.strictEqual(result.response.options.label, JSON.stringify(['', 'two words']));
    });

    test('rejects untrusted workspaces before executing the provider', async () => {
      const sentinel = path.join(workspace, 'executed');
      const configuration = await provider(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
      await assert.rejects(runCommandProvider(configuration, options({ workspaceTrusted: false })), /Trust this workspace/);
      await assert.rejects(access(sentinel), { code: 'ENOENT' });
    });

    test('reports a missing executable without exposing its path', async () => {
      await assert.rejects(runCommandProvider({ executable: path.join(workspace, 'missing-secret-command'), args: [] }, options()), {
        message: 'Could not start sandbox command provider'
      });
    });

    test('sanitizes nonzero exit diagnostics from both streams', async () => {
      const configuration = await provider(`
        require('node:fs').writeSync(1, 'stdout-secret-token');
        require('node:fs').writeSync(2, 'stderr-secret-token');
        process.exitCode = 17;
      `);
      await assert.rejects(runCommandProvider(configuration, options()), { message: 'Sandbox command provider failed (17)' });
    });

    test('parses only stdout and returns successful stderr separately', async () => {
      const expected = validSpec();
      const configuration = await provider(`
        process.stderr.write('diagnostic banner\\n');
        process.stdout.write(JSON.stringify(${JSON.stringify(expected)}) + '\\n');
      `);
      assert.deepStrictEqual(await runCommandProvider(configuration, options()), {
        response: expected,
        stderr: 'diagnostic banner\n'
      });
    });

    test('does not treat valid JSON on stderr as the response', async () => {
      const configuration = await provider(`process.stderr.write(JSON.stringify(${JSON.stringify(validSpec())}));`);
      await assert.rejects(runCommandProvider(configuration, options()), /must print one JSON object/);
    });

    test('rejects malformed successful stdout without leaking its contents', async () => {
      const configuration = await provider(`process.stdout.write('secret-token banner');`);
      await assert.rejects(runCommandProvider(configuration, options()), { message: 'Sandbox command provider must print one JSON object' });
    });

    test('terminates a provider that exceeds its timeout', async () => {
      const configuration = await provider('setInterval(() => {}, 1000);');
      await assert.rejects(runCommandProvider(configuration, options({ timeoutMs: 100 })), { message: 'Sandbox command provider timed out' });
    });

    for (const stream of ['stdout', 'stderr']) {
      test(`caps ${stream} output and sanitizes the failure`, async () => {
        const configuration = await provider(`process.${stream}.write('secret-token'.repeat(1000)); setInterval(() => {}, 1000);`);
        await assert.rejects(runCommandProvider(configuration, options({ maxOutputBytes: 64 })), {
          message: 'Sandbox command provider output limit exceeded'
        });
      });
    }

    test('applies the output cap across both streams rather than independently', async () => {
      const configuration = await provider(`
        require('node:fs').writeSync(1, 'a'.repeat(40));
        require('node:fs').writeSync(2, 'b'.repeat(40));
      `);
      await assert.rejects(runCommandProvider(configuration, options({ maxOutputBytes: 64 })), /output limit exceeded/);
    });

    test('counts UTF-8 bytes and accepts output exactly at the limit', async () => {
      const expected = validSpec({ agent: '/kit/雪', workspaces: [] });
      const stdout = JSON.stringify(expected);
      const configuration = await provider(`process.stdout.write(${JSON.stringify(stdout)});`);
      assert.deepStrictEqual((await runCommandProvider(configuration, options({ maxOutputBytes: Buffer.byteLength(stdout) }))).response, expected);
      await assert.rejects(runCommandProvider(configuration, options({ maxOutputBytes: stdout.length })), /output limit exceeded/);
    });

    test('rejects a pre-aborted signal without executing the provider', async () => {
      const sentinel = path.join(workspace, 'executed');
      const configuration = await provider(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');`);
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(runCommandProvider(configuration, options({ signal: controller.signal })), /cancelled/);
      await assert.rejects(access(sentinel), { code: 'ENOENT' });
    });

    test('aborts a running provider after it signals readiness', async () => {
      const controller = new AbortController();
      const ready = 'provider-ready';
      const configuration = await provider(`
        setInterval(() => {}, 1000);
        require('node:fs').writeFileSync(${JSON.stringify(path.join(workspace, ready))}, 'ready');
      `);
      const watcher = watch(workspace, (_event, filename) => {
        if (filename?.toString() === ready) { controller.abort(); }
      });
      try {
        await assert.rejects(runCommandProvider(configuration, options({ signal: controller.signal })), {
          message: 'Sandbox command provider cancelled'
        });
        assert.strictEqual(controller.signal.aborted, true);
      } finally {
        watcher.close();
        controller.abort();
      }
    });
  });
});
