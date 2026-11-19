import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Hermes Gateway extension', () => {
  test('registers chat commands when activated', async () => {
    const extension = vscode.extensions.getExtension('mixermsk.hermes-gateway');

    assert.ok(extension, 'Hermes Gateway extension should be discoverable');
    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('hermesGateway.openChat'));
    assert.ok(commands.includes('hermesGateway.pickSession'));
  }).timeout(10_000);
});
