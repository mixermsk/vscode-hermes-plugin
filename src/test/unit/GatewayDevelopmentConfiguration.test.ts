import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

suite('Gateway development configuration', () => {
  test('labels the Extension Development Host launch configuration for Gateway', () => {
    const launch = JSON.parse(readFileSync(join(process.cwd(), '.vscode', 'launch.json'), 'utf8')) as {
      configurations: Array<{ name?: string; env?: Record<string, unknown> }>;
    };

    assert.deepEqual(launch.configurations.map((configuration) => configuration.name), ['Run Hermes Gateway Extension']);
    assert.equal(launch.configurations[0]?.env?.ELECTRON_RUN_AS_NODE, null);
  });
});
