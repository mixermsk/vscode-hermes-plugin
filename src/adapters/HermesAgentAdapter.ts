import type { RepositoryIdentity } from '../domain/RepositoryIdentity';
import type { AgentAdapter, AgentLaunchSpec } from './AgentAdapter';

export type HermesLaunchConfiguration = Readonly<{
  executable?: string;
  arguments?: readonly string[];
  environment?: Readonly<Record<string, string>>;
}>;

export class HermesAgentAdapter implements AgentAdapter {
  public readonly id = 'hermes';
  public readonly displayName = 'Hermes Agent';

  public constructor(private readonly configuration: HermesLaunchConfiguration = {}) {}

  public buildLaunchSpec(repository: RepositoryIdentity): AgentLaunchSpec {
    return {
      command: this.configuration.executable ?? 'hermes',
      args: [...(this.configuration.arguments ?? ['acp'])],
      cwd: repository.cwd,
      environment: { ...(this.configuration.environment ?? {}) }
    };
  }
}
