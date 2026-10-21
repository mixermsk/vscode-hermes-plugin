import type {
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk';
import { relative, resolve, sep } from 'node:path';

export interface PermissionPresenter {
  choose(request: RequestPermissionRequest): Promise<string | undefined>;
}

export class PermissionController {
  private workspaceRoot: string | undefined;

  public constructor(private readonly presenter: PermissionPresenter) {}

  public setWorkspaceEditAutoApproval(workspaceRoot: string | undefined): void {
    this.workspaceRoot = workspaceRoot === undefined ? undefined : resolve(workspaceRoot);
  }

  public async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    try {
      const optionId = this.autoApproveWorkspaceEdit(request) ?? await this.presenter.choose(request);
      if (optionId !== undefined && request.options.some((option) => option.optionId === optionId)) {
        return { outcome: { outcome: 'selected', optionId } };
      }
    } catch {
      // Permission must fail closed when the UI is unavailable or throws.
    }

    return { outcome: { outcome: 'cancelled' } };
  }

  private autoApproveWorkspaceEdit(request: RequestPermissionRequest): string | undefined {
    if (this.workspaceRoot === undefined || request.toolCall.kind !== 'edit' || !Array.isArray(request.toolCall.content)) {
      return undefined;
    }
    const paths = request.toolCall.content.flatMap((content) => content.type === 'diff' && typeof content.path === 'string' ? [content.path] : []);
    if (paths.length === 0 || paths.length !== request.toolCall.content.length || paths.some((path) => !isWorkspaceEditPath(path, this.workspaceRoot!))) {
      return undefined;
    }
    return request.options.find((option) => option.kind === 'allow_once')?.optionId;
  }
}

function isWorkspaceEditPath(path: string, workspaceRoot: string): boolean {
  const target = resolve(workspaceRoot, path);
  const relativePath = relative(workspaceRoot, target);
  const parts = target.split(sep).map((part) => part.toLowerCase());
  const name = target.split(sep).at(-1)?.toLowerCase();
  return relativePath !== '' && !relativePath.startsWith(`..${sep}`) && relativePath !== '..'
    && !parts.includes('.git') && !parts.includes('.ssh')
    && !['.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519'].includes(name ?? '');
}
