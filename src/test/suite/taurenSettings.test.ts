import * as assert from 'assert';
import * as vscode from 'vscode';
import path from 'node:path';
import { createConfiguredAgentClient } from '../../taurenChatViewProvider';
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
      assert.deepStrictEqual(getSbxSettings(), { storageRoot: '~/.tauren' });
    });
  });

  test('preserves provider executable and argument boundaries', async () => {
    const provider = { executable: '/some path/my-provider', args: ['--profile', 'dev & test', '', '$(literal)'] };
    await withGlobalSettings({ 'sbx.commandProvider': provider, 'sbx.storageRoot': '~/session data', 'sbx.sandboxName': 'test-1' }, () => {
      assert.deepStrictEqual(getSbxSettings(), { provider, storageRoot: '~/session data', sandboxName: 'test-1' });
    });
  });

  test('reports malformed SBX settings only when read for SBX', async () => {
    const malformed = [
      ['sbx.commandProvider', 'provider --profile dev'],
      ['sbx.commandProvider', {}],
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

async function withGlobalSettings(values: Record<string, unknown>, callback: () => void): Promise<void> {
  const configuration = vscode.workspace.getConfiguration('tauren');
  const previous = Object.keys(values).map((key) => [key, configuration.inspect(key)?.globalValue] as const);
  try {
    for (const [key, value] of Object.entries(values)) {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    }
    callback();
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
