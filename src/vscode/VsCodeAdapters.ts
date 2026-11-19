import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { GitCommandRunner } from '../services/GitRepositoryResolver';
import type { KeyValueStore } from '../services/SessionRegistry';

const execFileAsync = promisify(execFile);

export class NodeGitCommandRunner implements GitCommandRunner {
  public async run(command: string, args: readonly string[], cwd: string): Promise<string> {
    const result = await execFileAsync(command, [...args], { cwd, encoding: 'utf8' });
    return result.stdout;
  }
}

export class VsCodeKeyValueStore implements KeyValueStore {
  public constructor(private readonly store: vscode.Memento) {}

  public get<T>(key: string, defaultValue?: T): T | undefined {
    return defaultValue === undefined ? this.store.get<T>(key) : this.store.get<T>(key, defaultValue);
  }

  public async update(key: string, value: unknown): Promise<void> {
    await this.store.update(key, value);
  }
}