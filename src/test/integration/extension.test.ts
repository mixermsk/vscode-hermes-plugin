import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Hermes ACP extension', () => {
  test('registers the Open Chat command when activated', async () => {
    const extension = vscode.extensions.getExtension('mixermsk.hermes-acp');

    assert.ok(extension, 'Hermes ACP extension should be discoverable');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('hermesAcp.openChat'));
  });
});
