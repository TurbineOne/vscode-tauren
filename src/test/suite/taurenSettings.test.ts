import * as assert from 'assert';
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { createConfiguredAgentClient } from '../../taurenChatViewProvider';
import { resolveSbxWorkspace } from '../../sbx/extensionClient';
import { SbxClient } from '../../sbx/sbxClient';
import { PiSdkClient } from '../../sdk/piSdkClient';
import { KwardClient } from '../../kward/kwardClient';
import { createCancellingExtensionUi } from '../../extensionUi/types';
import { affectsAnyTaurenExtensionSetting, affectsAnyTaurenSetting, getBackendSetting, getSbxSettings, getTaurenSettingValues } from '../../settings/taurenSettings';
import { settingDefinitions } from '../../settings/settingsRegistry';

suite('Tauren settings', () => {
  test('selects a distinct client per conversation without starting a backend', async () => {
    const root = path.resolve(__dirname, '../../..');
    const dependencies = {
      extensionUi: createCancellingExtensionUi(() => {}), showNotification: () => {},
      getRejectEditWriteOutsideWorkspace: () => false, onExtensionLoadError: () => {},
      sbx: { extensionDirectory: root, workspace: root, onDiagnostic: () => {} }
    };
    for (const [backend, Client] of [['pi', PiSdkClient], ['kward', KwardClient], ['sbx', SbxClient]] as const) {
      await withGlobalSettings({ backend }, () => {
        const first = createConfiguredAgentClient({}, dependencies);
        const second = createConfiguredAgentClient({}, dependencies);
        try {
          assert.ok(first instanceof Client);
          assert.ok(second instanceof Client);
          assert.notStrictEqual(first, second);
          assert.strictEqual(first.isRunning(), false);
        } finally { first.dispose(); second.dispose(); }
      });
    }
  });

  test('uses the SBX defaults without an explicit provider or name', async () => {
    await withGlobalSettings({ backend: 'sbx', 'sbx.commandProvider': undefined, 'sbx.storageRoot': undefined, 'sbx.sandboxName': '' }, () => {
      assert.strictEqual(getBackendSetting(), 'sbx');
      const declaredDefault = vscode.workspace.getConfiguration('tauren').inspect('sbx.commandProvider')?.defaultValue;
      assert.ok(declaredDefault);
      assert.deepStrictEqual(getSbxSettings(), { provider: declaredDefault, storageRoot: '~/.tauren' });
    });
  });

  test('preserves provider executable and argument boundaries', async () => {
    const provider = { executable: '/some path/my-provider', args: ['--profile', 'dev & test', '', '$(literal)'] };
    await withGlobalSettings({ 'sbx.commandProvider': provider, 'sbx.storageRoot': '~/session data', 'sbx.sandboxName': 'test-1' }, () => {
      assert.deepStrictEqual(getSbxSettings(), { provider, storageRoot: '~/session data', sandboxName: 'test-1' });
    });
  });

  test('resolves SBX workspace session store and sandbox name from the configured command provider', async () => {
    const extensionRoot = path.resolve(__dirname, '../../..');
    const tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tauren-sbx-settings-')));
    try {
      const workspace = path.join(tempRoot, 'My Workspace');
      const providerAgents = path.join(tempRoot, 'pi-sbx', 'agents');
      const providerSessions = path.join(tempRoot, 'pi-sbx', 'sessions');
      const providerKit = path.join(tempRoot, 'pi-sbx', 'kit');
      await Promise.all([workspace, providerAgents, providerSessions, providerKit].map(dir => fs.mkdir(dir, { recursive: true })));

      const providerSpec = {
        version: 1,
        command: ['sbx', 'create'],
        agent: '@tauren/bundled-pi-kit',
        workspaces: [workspace, providerAgents, providerSessions],
        options: {
          kit: [providerKit],
          name: 'Custom_From.Provider',
          env: {
            PI_CODING_AGENT_DIR: providerAgents,
            PI_CODING_AGENT_SESSION_DIR: providerSessions
          }
        }
      };
      const provider = {
        executable: process.execPath,
        args: ['-e', `process.stderr.write('staging ready\\n'); process.stdout.write(${JSON.stringify(`${JSON.stringify(providerSpec)}\n`)});`]
      };
      const diagnostics: string[] = [];

      await withGlobalSettings({
        backend: 'sbx',
        'sbx.commandProvider': provider,
        'sbx.storageRoot': path.join(tempRoot, 'unused-tauren-store'),
        'sbx.sandboxName': ''
      }, async () => {
        const resolved = await resolveSbxWorkspace(workspace, extensionRoot, text => diagnostics.push(text));
        assert.strictEqual(resolved.workspace, workspace);
        assert.strictEqual(resolved.sandboxName, 'Custom_From.Provider');
        assert.strictEqual(resolved.sessionDirectory, providerSessions);
        assert.deepStrictEqual(resolved.env, {
          PI_CODING_AGENT_DIR: providerAgents,
          PI_CODING_AGENT_SESSION_DIR: providerSessions
        });
        assert.deepStrictEqual(diagnostics, ['staging ready\n']);
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('reports malformed SBX settings only when read for SBX', async () => {
    const malformed = [
      ['sbx.commandProvider', 'provider --profile dev'],
      ['sbx.commandProvider', {}],
      ['sbx.commandProvider', { executable: 'provider' }],
      ['sbx.commandProvider', { executable: 'provider', args: [1] }],
      ['sbx.storageRoot', false],
      ['sbx.sandboxName', ['test']]
    ] as const;
    for (const [key, value] of malformed) {
      await withGlobalSettings({ backend: 'kward', [key]: value }, () => {
        assert.strictEqual(getBackendSetting(), 'kward');
        assert.doesNotThrow(() => getTaurenSettingValues());
        assert.throws(() => getSbxSettings(), (error) => error instanceof Error && error.message.startsWith(`tauren.${key} `));
      });
    }
  });

  test('detects every Tauren-owned setting change from the registry', () => {
    for (const setting of settingDefinitions) {
      if (setting.owner !== 'tauren') {
        continue;
      }

      assert.strictEqual(
        affectsAnyTaurenSetting(createConfigurationChangeEvent(setting.id)),
        true,
        `${setting.id} should trigger Tauren state refresh`
      );
    }
  });

  test('does not treat Pi-owned settings as Tauren-owned setting changes', () => {
    for (const setting of settingDefinitions) {
      if (setting.owner !== 'pi') {
        continue;
      }

      assert.strictEqual(
        affectsAnyTaurenSetting(createConfigurationChangeEvent(setting.id)),
        false,
        `${setting.id} should not trigger Tauren state refresh`
      );
    }
  });

  test('detects only Tauren extension setting changes for extension settings', () => {
    assert.strictEqual(
      affectsAnyTaurenExtensionSetting(createConfigurationChangeEvent('tauren.extensions.statusBarEnabled')),
      true
    );
    assert.strictEqual(
      affectsAnyTaurenExtensionSetting(createConfigurationChangeEvent('tauren.readyScript')),
      false
    );
  });
});

async function withGlobalSettings(values: Record<string, unknown>, callback: () => void | Promise<void>): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('tauren');
  const previous = Object.keys(values).map((key) => [key, configuration.inspect(key)?.globalValue] as const);
  try {
    for (const [key, value] of Object.entries(values)) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await callback();
  } finally {
    for (const [key, value] of previous) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
  }
}

function createConfigurationChangeEvent(affectedSetting: string): vscode.ConfigurationChangeEvent {
  return {
    affectsConfiguration: (section: string) => section === affectedSetting
  } as vscode.ConfigurationChangeEvent;
}
