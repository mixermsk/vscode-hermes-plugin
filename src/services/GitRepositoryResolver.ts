import * as path from 'node:path';
import type { RepositoryIdentity, RepositoryResolution } from '../domain/RepositoryIdentity';

export interface GitCommandRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<string>;
}

export class GitRepositoryResolver {
  public constructor(private readonly runner: GitCommandRunner) {}

  public async resolve(cwd: string): Promise<RepositoryResolution> {
    const normalizedCwd = path.resolve(cwd);
    let gitRoot: string;

    try {
      gitRoot = path.resolve((await this.runner.run('git', ['rev-parse', '--show-toplevel'], normalizedCwd)).trim());
    } catch {
      return { kind: 'not-a-repository', cwd: normalizedCwd };
    }

    const remoteOrigin = await this.readOptional(['remote', 'get-url', 'origin'], normalizedCwd);
    const branch = await this.readOptional(['branch', '--show-current'], normalizedCwd);
    const normalizedRemoteOrigin = remoteOrigin === undefined ? undefined : normalizeRemoteOrigin(remoteOrigin);
    const identity: RepositoryIdentity = {
      logicalId: normalizedRemoteOrigin === undefined ? `path:${gitRoot}` : `origin:${normalizedRemoteOrigin}`,
      gitRoot,
      cwd: normalizedCwd,
      ...(normalizedRemoteOrigin === undefined ? {} : { remoteOrigin: normalizedRemoteOrigin }),
      ...(branch === undefined ? {} : { branch })
    };

    return { kind: 'repository', identity };
  }

  private async readOptional(args: readonly string[], cwd: string): Promise<string | undefined> {
    try {
      const value = (await this.runner.run('git', args, cwd)).trim();
      return value === '' ? undefined : value;
    } catch {
      return undefined;
    }
  }
}

function normalizeRemoteOrigin(origin: string): string {
  const trimmedOrigin = origin.trim();
  return trimmedOrigin.endsWith('.git') ? trimmedOrigin.slice(0, -'.git'.length) : trimmedOrigin;
}
