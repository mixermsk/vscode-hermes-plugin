import * as assert from 'node:assert/strict';
import { HermesAgentAdapter } from '../../adapters/HermesAgentAdapter';

const repository = {
  logicalId: 'origin:example/project',
  gitRoot: '/work/project',
  cwd: '/work/project'
};

suite('HermesAgentAdapter', () => {
  test('preserves explicitly configured executable, arguments and environment', () => {
    const adapter = new HermesAgentAdapter({
      executable: '/opt/hermes/bin/hermes',
      arguments: ['acp', '--accept-hooks'],
      environment: { HERMES_HOME: '/work/.hermes' }
    });

    assert.deepEqual(adapter.buildLaunchSpec(repository), {
      command: '/opt/hermes/bin/hermes',
      args: ['acp', '--accept-hooks'],
      cwd: '/work/project',
      environment: { HERMES_HOME: '/work/.hermes' }
    });
  });

  test('builds the default hermes acp launch specification for the repository cwd', () => {
    const adapter = new HermesAgentAdapter();

    assert.deepEqual(adapter.buildLaunchSpec(repository), {
      command: 'hermes',
      args: ['acp'],
      cwd: '/work/project',
      environment: {}
    });
  });
});
