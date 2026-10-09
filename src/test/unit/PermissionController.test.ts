import * as assert from 'node:assert/strict';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { PermissionController, type PermissionPresenter } from '../../ui/PermissionController';

const request: RequestPermissionRequest = {
  sessionId: 'session-1',
  toolCall: { toolCallId: 'tool-1', title: 'Run tests' },
  options: [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
  ]
};

suite('PermissionController', () => {
  test('cancels when the presenter is dismissed', async () => {
    const presenter: PermissionPresenter = {
      async choose() {
        return undefined;
      }
    };

    assert.deepEqual(await new PermissionController(presenter).requestPermission(request), {
      outcome: { outcome: 'cancelled' }
    });
  });

  test('cancels when the presenter returns an unknown option', async () => {
    const presenter: PermissionPresenter = {
      async choose() {
        return 'allow-everything';
      }
    };

    assert.deepEqual(await new PermissionController(presenter).requestPermission(request), {
      outcome: { outcome: 'cancelled' }
    });
  });

  test('cancels when the presenter fails', async () => {
    const presenter: PermissionPresenter = {
      async choose() {
        throw new Error('webview disposed');
      }
    };

    assert.deepEqual(await new PermissionController(presenter).requestPermission(request), {
      outcome: { outcome: 'cancelled' }
    });
  });

  test('returns the option selected by the user', async () => {
    const presenter: PermissionPresenter = {
      async choose() {
        return 'allow-once';
      }
    };

    const result = await new PermissionController(presenter).requestPermission(request);

    assert.deepEqual(result, {
      outcome: { outcome: 'selected', optionId: 'allow-once' }
    });
  });
});
