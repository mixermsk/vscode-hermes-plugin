import type { GatewayApproval } from '../gateway/HermesGatewayClient';

const FILE_EDIT_TOOLS = new Set(['patch', 'write_file']);

export function canAutoApproveFileEdit(approval: GatewayApproval): boolean {
  return approval.toolName !== undefined
    && FILE_EDIT_TOOLS.has(approval.toolName)
    && approval.choices.includes('session');
}
