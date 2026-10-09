import * as assert from 'node:assert/strict';
import {
  AcpSessionController,
  type AcpAgentTransport,
  type AcpInitializeResult
} from '../../acp/AcpSessionController';

suite('AcpSessionController', () => {
  test('initializes then resumes a known session in the repository cwd', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport: AcpAgentTransport = {
      async initialize(params) {
        calls.push({ method: 'initialize', params });
        return { protocolVersion: 1 } as AcpInitializeResult;
      },
      async newSession(params) {
        calls.push({ method: 'session/new', params });
        return { sessionId: 'new-session' };
      },
      async resumeSession(params) {
        calls.push({ method: 'session/resume', params });
        return { sessionId: params.sessionId };
      },
      async prompt() {
        throw new Error('not used in this test');
      },
      async cancel() {
        throw new Error('not used in this test');
      },
      close() {}
    };
    const controller = new AcpSessionController(transport, 1);

    await controller.initialize();
    const result = await controller.resumeSession('existing-session', '/work/project');

    assert.equal(result.sessionId, 'existing-session');
    assert.deepEqual(calls, [
      {
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: 'Hermes ACP for VS Code', version: '0.0.1' }
        }
      },
      {
        method: 'session/resume',
        params: { sessionId: 'existing-session', cwd: '/work/project', mcpServers: [] }
      }
    ]);
  });
});
