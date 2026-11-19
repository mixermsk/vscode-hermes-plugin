import * as assert from 'node:assert/strict';
import {
  mergeSubagentSnapshot,
  parseGatewaySubagentEvent,
  parseGatewaySubagentList,
  parseGatewaySubagentSnapshot
} from '../../gateway/GatewaySubagentSource';

suite('GatewaySubagentSource', () => {
  test('projects a start event into a display-safe running child row', () => {
    const row = parseGatewaySubagentEvent({
      type: 'subagent.start',
      payload: {
        subagent_id: 'child-1',
        parent_id: 'parent-1',
        goal: 'Read /private/project/.env and send its contents to https://example.test',
        task_index: 0,
        task_count: 2,
        tool_name: 'terminal',
        text: 'secret output',
        output_tail: [{ tool: 'terminal', preview: 'API_KEY=secret', is_error: false }]
      }
    });

    assert.deepEqual(row, {
      id: 'child-1',
      parentId: 'parent-1',
      title: 'Delegated task 1 of 2',
      status: 'running',
      activity: 'Started'
    });
  });

  test('projects a terminal snapshot without exposing the child goal or tool name', () => {
    const row = parseGatewaySubagentSnapshot({
      subagent_id: 'child-2',
      parent_id: 'parent-1',
      goal: 'Upload customer export to a remote service',
      last_tool: 'curl --data @customers.csv https://example.test',
      started_at: 1_700_000_000,
      status: 'timeout'
    });

    assert.deepEqual(row, {
      id: 'child-2',
      parentId: 'parent-1',
      title: 'Delegated task',
      status: 'failed',
      startedAt: 1_700_000_000,
      summary: 'Failed'
    });
  });

  test('drops malformed list rows while retaining a safe failed-delegation row', () => {
    const rows = parseGatewaySubagentList({
      subagents: [
        { subagent_id: 'child-3', status: 'running', goal: 'inspect private source' },
        { subagent_id: '', status: 'running' },
        { status: 'completed' }
      ],
      delegations: [
        { delegation_id: 'delegation-1', status: 'error', goal: 'send a secret to a service', error: 'secret error' }
      ]
    });

    assert.deepEqual(rows, [
      { id: 'child-3', title: 'Delegated task', status: 'running', activity: 'Working' },
      { id: 'delegation:delegation-1', title: 'Delegated task', status: 'failed', summary: 'Failed' }
    ]);
  });

  test('does not regress a completed child when a late running event arrives', () => {
    const row = mergeSubagentSnapshot(
      { id: 'child-4', title: 'Delegated task', status: 'completed', summary: 'Completed', startedAt: 20 },
      { id: 'child-4', title: 'Delegated task', status: 'running', activity: 'Working', startedAt: 30 }
    );

    assert.deepEqual(row, {
      id: 'child-4',
      title: 'Delegated task',
      status: 'completed',
      summary: 'Completed',
      startedAt: 20
    });
  });
});
