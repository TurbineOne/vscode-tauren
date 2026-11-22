import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { normalizeSandboxName, resolveSandboxPaths } from '../../sbx/configuration';

suite('SBX configuration', () => {
  test('normalizes basenames into bounded lowercase ASCII names', () => {
    assert.strictEqual(normalizeSandboxName('/projects/My App___V2!'), 'my-app-v2');
    assert.strictEqual(normalizeSandboxName('/projects/CAFÉ'), 'caf');
    assert.strictEqual(normalizeSandboxName('/projects/Project/'), 'project');
    assert.strictEqual(normalizeSandboxName(`/projects/${'A'.repeat(80)}`), 'a'.repeat(63));
    for (const workspace of ['/', '/projects/!!!', '/projects/日本語']) {
      assert.throws(() => normalizeSandboxName(workspace), /empty sandbox name/);
    }
  });

  test('basename collisions intentionally share identity, with strict explicit overrides', () => {
    assert.strictEqual(normalizeSandboxName('/one/My App'), normalizeSandboxName('/two/My App'));
    assert.strictEqual(normalizeSandboxName('/one/My App', 'project-2'), 'project-2');
    assert.strictEqual(normalizeSandboxName('/one/My App', 'Upper_App.v2'), 'Upper_App.v2');
    assert.strictEqual(normalizeSandboxName('/', 'explicit'), 'explicit');
    for (const override of ['', 'with spaces', '-start', '_start', '.start', 'bad.sbx', '../escape', 'é', 'a'.repeat(64), 'a\0', 'valid\n']) {
      assert.throws(() => normalizeSandboxName('/valid', override), /overrides are not normalized/);
    }
  });

  suite('POSIX host resolution', function () {
    let root: string;
    let workspace: string;
    let storageRoot: string;

    setup(async function () {
      if (process.platform === 'win32') {
        this.skip();
      }
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tauren-sbx-')));
      workspace = path.join(root, 'My Project');
      storageRoot = path.join(root, 'storage');
      await fs.mkdir(workspace);
    });

    teardown(async () => {
      if (root) {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    test('defaults to home/.tauren and never creates directories', async () => {
      const result = await resolveSandboxPaths({ workspace, homeDirectory: root });
      assert.deepStrictEqual(result, {
        workspace,
        storageRoot: path.join(root, '.tauren'),
        sandboxName: 'my-project',
        sessionDirectory: path.join(root, '.tauren', 'my-project', 'sessions')
      });
      await assert.rejects(fs.stat(result.storageRoot), { code: 'ENOENT' });
      assert.strictEqual((await resolveSandboxPaths({ workspace, storageRoot: '~', homeDirectory: root })).storageRoot, root);
      assert.strictEqual((await resolveSandboxPaths({ workspace, storageRoot: '~/nested', homeDirectory: root })).storageRoot, path.join(root, 'nested'));
    });

    test('resolves workspace aliases and nonexistent storage through a real parent', async () => {
      const alias = path.join(root, 'alias');
      await fs.symlink(workspace, alias);
      const parent = path.join(root, 'real-parent');
      await fs.mkdir(parent);
      const parentAlias = path.join(root, 'parent-alias');
      await fs.symlink(parent, parentAlias);
      const result = await resolveSandboxPaths({ workspace: alias, storageRoot: path.join(parentAlias, 'missing', 'deeper') });
      assert.strictEqual(result.workspace, workspace);
      assert.strictEqual(result.sandboxName, 'my-project');
      assert.strictEqual(result.storageRoot, path.join(parent, 'missing', 'deeper'));
      await assert.rejects(fs.stat(result.storageRoot), { code: 'ENOENT' });
    });

    test('preserves spaces and shell metacharacters literally', async () => {
      const special = path.join(root, 'space ; $(touch nope) & [x]');
      await fs.mkdir(special);
      const result = await resolveSandboxPaths({ workspace: special, storageRoot: `${storageRoot} ; $HOME`, sandboxName: 'explicit-1' });
      assert.strictEqual(result.workspace, special);
      assert.strictEqual(result.storageRoot, `${storageRoot} ; $HOME`);
      assert.strictEqual(result.sessionDirectory, path.join(`${storageRoot} ; $HOME`, 'explicit-1', 'sessions'));
      await assert.rejects(fs.stat(result.storageRoot), { code: 'ENOENT' });
    });

    test('rejects invalid host paths and ambiguous mount delimiters', async () => {
      for (const invalid of ['', 'relative', '~someone/store', '/tmp/a\0b', '/tmp/a:b', 'C:\\store', 'C:/store', '\\\\server\\share']) {
        await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: invalid }));
      }
      for (const invalid of ['', 'relative', '~/workspace', '/tmp/a\0b', '/tmp/a:b', 'C:\\workspace', '\\\\server\\share']) {
        await assert.rejects(resolveSandboxPaths({ workspace: invalid, storageRoot }));
      }
      await assert.rejects(resolveSandboxPaths({ workspace, homeDirectory: 'relative' }), /absolute POSIX/);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: '~', homeDirectory: '' }), /nonempty/);
    });

    test('requires an existing directory workspace and directory storage ancestors', async () => {
      await assert.rejects(resolveSandboxPaths({ workspace: path.join(root, 'absent'), storageRoot }));
      const file = path.join(root, 'file');
      await fs.writeFile(file, 'not a directory');
      await assert.rejects(resolveSandboxPaths({ workspace: file, storageRoot }), /existing directory/);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: file }), /directory/);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: path.join(file, 'child') }));
      const dangling = path.join(root, 'dangling');
      await fs.symlink(path.join(root, 'missing'), dangling);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: dangling }), /symlink/);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: path.join(dangling, 'child') }), /symlink/);
    });

    test('rejects descendant sessions without creating storage', async () => {
      const inside = path.join(workspace, 'storage');
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: inside }), /outside the workspace/);
      await assert.rejects(fs.stat(inside), { code: 'ENOENT' });
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot: workspace }), /outside the workspace/);
    });

    test('rejects equality and symlink escapes at storage, name, and sessions levels', async () => {
      await fs.symlink(workspace, storageRoot);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot }), /outside the workspace/);
      await fs.unlink(storageRoot);
      await fs.mkdir(storageRoot);
      const named = path.join(storageRoot, 'my-project');
      await fs.symlink(workspace, named);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot }), /outside the workspace/);
      await fs.unlink(named);
      await fs.mkdir(named);
      const sessions = path.join(named, 'sessions');
      await fs.symlink(workspace, sessions);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot }), /outside the workspace/);
      await fs.unlink(sessions);
      const child = path.join(workspace, 'child');
      await fs.mkdir(child);
      await fs.symlink(child, sessions);
      await assert.rejects(resolveSandboxPaths({ workspace, storageRoot }), /outside the workspace/);
    });

    test('allows sibling prefixes and reverse containment', async () => {
      const sibling = await resolveSandboxPaths({ workspace, storageRoot: `${workspace}-storage` });
      assert.strictEqual(sibling.storageRoot, `${workspace}-storage`);
      const sessions = path.join(storageRoot, 'shared', 'sessions');
      const nestedWorkspace = path.join(sessions, 'project');
      await fs.mkdir(nestedWorkspace, { recursive: true });
      const reverse = await resolveSandboxPaths({ workspace: nestedWorkspace, storageRoot, sandboxName: 'shared' });
      assert.strictEqual(reverse.sessionDirectory, sessions);
    });

    test('checks effective canonical sessions rather than rejecting storage alone', async () => {
      const inside = path.join(workspace, 'storage');
      await fs.mkdir(inside);
      await fs.mkdir(storageRoot);
      await fs.symlink(storageRoot, path.join(inside, 'my-project'));
      const result = await resolveSandboxPaths({ workspace, storageRoot: inside });
      assert.strictEqual(result.sessionDirectory, path.join(storageRoot, 'sessions'));
    });
  });
});
