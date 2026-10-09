import type {
  RequestPermissionRequest,
  RequestPermissionResponse
} from '@agentclientprotocol/sdk';

export interface PermissionPresenter {
  choose(request: RequestPermissionRequest): Promise<string | undefined>;
}

export class PermissionController {
  public constructor(private readonly presenter: PermissionPresenter) {}

  public async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    try {
      const optionId = await this.presenter.choose(request);
      if (optionId !== undefined && request.options.some((option) => option.optionId === optionId)) {
        return { outcome: { outcome: 'selected', optionId } };
      }
    } catch {
      // Permission must fail closed when the UI is unavailable or throws.
    }

    return { outcome: { outcome: 'cancelled' } };
  }
}
