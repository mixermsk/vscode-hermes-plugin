import type { RepositoryIdentity } from '../domain/RepositoryIdentity';

export type AgentLaunchSpec = Readonly<{
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
}>;

export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;
  buildLaunchSpec(repository: RepositoryIdentity): AgentLaunchSpec;
}
