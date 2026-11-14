import * as assert from 'node:assert/strict';
import { watch } from 'node:fs';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultCommandProvider,
  parseCommandProviderResponse,
  runCommandProvider,
  type CommandProviderConfiguration,
  type ProviderExecutionOptions
} from '../../sbx/commandProvider';

suite('sbx command provider', () => {
  suite('response parsing', () => {
    test('accepts one versioned JSON object with surrounding whitespace and literal arguments', () => {
      const argv = ['sbx', 'create', 'kit with spaces', '$(touch sentinel); & | >', '雪'];
      assert.deepStrictEqual(parseCommandProviderResponse(` \n${JSON.stringify({ version: 1, argv })}\n`), { version: 1, argv });
    });

    for (const [name, stdout] of [
      ['empty output', ''],
      ['malformed JSON', '{'],
      ['a leading banner', 'provider ready\n{"version":1,"argv":["sbx","create"]}'],
      ['a trailing banner', '{"version":1,"argv":["sbx","create"]}\nfinished'],
      ['multiple objects', '{"version":1,"argv":["sbx","create"]}\n{}']
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
        assert.throws(() => parseCommandProviderResponse(JSON.stringify({ version, argv: ['sbx', 'create'] })), /Unsupported.*version/);
      });
    }

    for (const [name, value] of [
      ['extra fields', { version: 1, argv: ['sbx', 'create'], secret: 'not allowed' }],
      ['missing argv', { version: 1 }],
      ['string argv', { version: 1, argv: 'sbx create' }],
      ['empty argv', { version: 1, argv: [] }],
      ['one argument', { version: 1, argv: ['sbx'] }],
      ['empty argument', { version: 1, argv: ['sbx', ''] }],
      ['NUL argument', { version: 1, argv: ['sbx', 'a\0b'] }],
      ...[1, null, false, {}, []].map(value => [`non-string argument ${JSON.stringify(value)}`, { version: 1, argv: ['sbx', value] }])
    ] as const) {
      test(`rejects ${name}`, () => {
        assert.throws(() => parseCommandProviderResponse(JSON.stringify(value)), /argv must be an array of nonempty strings/);
      });
    }
  });

  suite('default provider', () => {
    test('returns the packaged kit as one literal argument without spawning sbx', () => {
      const kit = '/extension with spaces/kit;$(not-a-command)';
      const result = defaultCommandProvider(kit);
      assert.deepStrictEqual(result, { version: 1, argv: ['sbx', '--no-input', 'create', kit] });
      result.argv.push('changed');
      assert.deepStrictEqual(defaultCommandProvider(kit).argv, ['sbx', '--no-input', 'create', kit]);
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
        process.stdout.write(JSON.stringify({ version: 1, argv: ['sbx', process.cwd(), ...process.argv.slice(2)] }));
      `);
      const args = ['argument with spaces', '', `; touch "${sentinel}"`, `$(touch "${sentinel}")`, '`touch shell-sentinel`', 'a&b|c>d', '*', '$HOME', '"quoted"'];
      // Empty configured arguments are legal, but response argv entries must be nonempty.
      configuration.args.push(...args.filter(arg => arg !== ''));
      const result = await runCommandProvider(configuration, options());
      assert.deepStrictEqual(result, {
        response: { version: 1, argv: ['sbx', workspace, ...args.filter(arg => arg !== '')] }, stderr: ''
      });
      await assert.rejects(access(sentinel), { code: 'ENOENT' });
    });

    test('allows an empty configured argument without dropping it', async () => {
      const configuration = await provider(`process.stdout.write(JSON.stringify({ version: 1, argv: ['sbx', JSON.stringify(process.argv.slice(2))] }));`);
      configuration.args.push('', 'two words');
      const result = await runCommandProvider(configuration, options());
      assert.strictEqual(result.response.argv[1], JSON.stringify(['', 'two words']));
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
      const configuration = await provider(`
        process.stderr.write('diagnostic banner\\n');
        process.stdout.write(JSON.stringify({ version: 1, argv: ['sbx', 'create'] }));
      `);
      assert.deepStrictEqual(await runCommandProvider(configuration, options()), {
        response: { version: 1, argv: ['sbx', 'create'] }, stderr: 'diagnostic banner\n'
      });
    });

    test('does not treat valid JSON on stderr as the response', async () => {
      const configuration = await provider(`process.stderr.write(JSON.stringify({ version: 1, argv: ['sbx', 'create'] }));`);
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
      const stdout = JSON.stringify({ version: 1, argv: ['sbx', '雪'] });
      const configuration = await provider(`process.stdout.write(${JSON.stringify(stdout)});`);
      assert.deepStrictEqual((await runCommandProvider(configuration, options({ maxOutputBytes: Buffer.byteLength(stdout) }))).response, {
        version: 1, argv: ['sbx', '雪']
      });
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
