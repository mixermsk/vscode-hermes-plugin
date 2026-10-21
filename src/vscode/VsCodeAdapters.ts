import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { AgentLaunchSpec } from '../adapters/AgentAdapter';
import { AcpConnection } from '../acp/AcpConnection';
import type { AcpClientCallbacks } from '../acp/AcpClient';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { GitCommandRunner } from '../services/GitRepositoryResolver';
import type { AcpControllerFactory } from '../services/HermesSessionService';
import type { KeyValueStore } from '../services/SessionRegistry';
import type { PermissionPresenter } from '../ui/PermissionController';

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

export class VsCodePermissionPresenter implements PermissionPresenter {
  public async choose(request: RequestPermissionRequest): Promise<string | undefined> {
    const selected = await vscode.window.showQuickPick(
      request.options.map((option) => ({
        label: option.name,
        description: option.kind,
        optionId: option.optionId
      })),
      {
        title: request.toolCall.title ?? 'Hermes requests permission',
        placeHolder: 'Choose how to handle this Hermes tool call',
        ignoreFocusOut: true
      }
    );
    return selected?.optionId;
  }
}

export class ChildProcessAcpControllerFactory implements AcpControllerFactory {
  public constructor(private readonly callbacks: AcpClientCallbacks) {}

  public async start(spec: AgentLaunchSpec) {
    const process = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...processEnv(), ...spec.environment },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    process.once('error', (error) => this.callbacks.onTransportError?.(error));
    process.once('exit', (code, signal) => {
      this.callbacks.onTransportError?.(new Error(
        `Hermes ACP process exited${code === null ? '' : ` with code ${code}`}${signal === null ? '' : ` (${signal})`}.`
      ));
    });
    const controller = AcpConnection.connect(process, this.callbacks);
    return { controller };
  }
}

function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}
