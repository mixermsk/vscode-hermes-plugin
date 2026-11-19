import * as assert from 'node:assert/strict';
import { canAutoApproveFileEdit } from '../../services/ApprovalPolicy';

suite('ApprovalPolicy', () => {
  test('allows a session-scoped file edit approval', () => {
    assert.equal(canAutoApproveFileEdit({
      requestId: 'approval-1',
      toolName: 'patch',
      choices: ['once', 'session', 'deny']
    }), true);
  });

  test('does not auto-approve terminal commands or non-session choices', () => {
    assert.equal(canAutoApproveFileEdit({
      requestId: 'approval-2',
      toolName: 'terminal',
      choices: ['once', 'session', 'deny']
    }), false);
    assert.equal(canAutoApproveFileEdit({
      requestId: 'approval-3',
      toolName: 'write_file',
      choices: ['once', 'deny']
    }), false);
  });
});
