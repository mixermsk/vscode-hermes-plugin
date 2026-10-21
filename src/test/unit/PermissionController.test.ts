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

  test('auto-accepts a non-sensitive edit wholly inside the enabled workspace', async () => {
    let prompted = false;
    const controller = new PermissionController({ async choose() { prompted = true; return undefined; } });
    controller.setWorkspaceEditAutoApproval('/work/project');

    const result = await controller.requestPermission({
      ...request,
      toolCall: { toolCallId: 'edit-1', kind: 'edit', content: [{ type: 'diff', path: '/work/project/src/app.ts', oldText: '', newText: 'export {};' }] }
    });

    assert.deepEqual(result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    assert.equal(prompted, false);
  });

  test('does not auto-accept edits outside the workspace or sensitive paths', async () => {
    let prompts = 0;
    const controller = new PermissionController({ async choose() { prompts += 1; return undefined; } });
    controller.setWorkspaceEditAutoApproval('/work/project');

    for (const path of ['/work/other/app.ts', '/work/project/.env', '/work/project/.git/config']) {
      await controller.requestPermission({
        ...request,
        toolCall: { toolCallId: path, kind: 'edit', content: [{ type: 'diff', path, oldText: '', newText: 'x' }] }
      });
    }

    assert.equal(prompts, 3);
  });
});
