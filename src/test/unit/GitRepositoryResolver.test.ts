import * as assert from 'node:assert/strict';
import { GitRepositoryResolver, type GitCommandRunner } from '../../services/GitRepositoryResolver';

suite('GitRepositoryResolver', () => {
  test('omits branch metadata when Git is in detached HEAD state', async () => {
    const runner: GitCommandRunner = {
      async run(_command, args) {
        if (args.join(' ') === 'rev-parse --show-toplevel') {
          return '/work/project\n';
        }
        if (args.join(' ') === 'remote get-url origin') {
          return 'https://github.com/example/project.git\n';
        }
        if (args.join(' ') === 'branch --show-current') {
          return '\n';
        }

        throw new Error(`Unexpected git arguments: ${args.join(' ')}`);
      }
    };
    const result = await new GitRepositoryResolver(runner).resolve('/work/project');

    assert.deepEqual(result, {
      kind: 'repository',
      identity: {
        logicalId: 'origin:https://github.com/example/project',
        gitRoot: '/work/project',
        cwd: '/work/project',
        remoteOrigin: 'https://github.com/example/project'
      }
    });
  });

  test('retains the current worktree as the execution cwd', async () => {
    const runner: GitCommandRunner = {
      async run(_command, args, cwd) {
        assert.equal(cwd, '/work/project-feature');
        if (args.join(' ') === 'rev-parse --show-toplevel') {
          return '/work/project-feature\n';
        }
        if (args.join(' ') === 'remote get-url origin') {
          return 'git@github.com:example/project.git\n';
        }
        if (args.join(' ') === 'branch --show-current') {
          return 'feature/session-resume\n';
        }

        throw new Error(`Unexpected git arguments: ${args.join(' ')}`);
      }
    };
    const result = await new GitRepositoryResolver(runner).resolve('/work/project-feature');

    assert.equal(result.kind, 'repository');
    assert.equal(result.identity.logicalId, 'origin:git@github.com:example/project');
    assert.equal(result.identity.gitRoot, '/work/project-feature');
    assert.equal(result.identity.cwd, '/work/project-feature');
  });

  test('returns a typed result when the workspace is not a Git repository', async () => {
    const runner: GitCommandRunner = {
      async run() {
        throw new Error('fatal: not a git repository');
      }
    };
    const result = await new GitRepositoryResolver(runner).resolve('/work/plain-folder');

    assert.deepEqual(result, {
      kind: 'not-a-repository',
      cwd: '/work/plain-folder'
    });
  });

  test('falls back to the canonical Git root when origin is unavailable', async () => {
    const runner: GitCommandRunner = {
      async run(_command, args) {
        if (args.join(' ') === 'rev-parse --show-toplevel') {
          return '/work/project/../project\n';
        }
        if (args.join(' ') === 'remote get-url origin') {
          throw new Error('origin is not configured');
        }
        if (args.join(' ') === 'branch --show-current') {
          return 'main\n';
        }

        throw new Error(`Unexpected git arguments: ${args.join(' ')}`);
      }
    };
    const resolver = new GitRepositoryResolver(runner);

    const result = await resolver.resolve('/work/project');

    assert.deepEqual(result, {
      kind: 'repository',
      identity: {
        logicalId: 'path:/work/project',
        gitRoot: '/work/project',
        cwd: '/work/project',
        branch: 'main'
      }
    });
  });

  test('uses origin and Git root to identify a repository', async () => {
    const runner: GitCommandRunner = {
      async run(_command, args, cwd) {
        assert.equal(cwd, '/work/project');

        if (args.join(' ') === 'rev-parse --show-toplevel') {
          return '/work/project\n';
        }
        if (args.join(' ') === 'remote get-url origin') {
          return 'git@github.com:example/project.git\n';
        }
        if (args.join(' ') === 'branch --show-current') {
          return 'feature/session-resume\n';
        }

        throw new Error(`Unexpected git arguments: ${args.join(' ')}`);
      }
    };
    const resolver = new GitRepositoryResolver(runner);

    const result = await resolver.resolve('/work/project');

    assert.deepEqual(result, {
      kind: 'repository',
      identity: {
        logicalId: 'origin:git@github.com:example/project',
        gitRoot: '/work/project',
        cwd: '/work/project',
        remoteOrigin: 'git@github.com:example/project',
        branch: 'feature/session-resume'
      }
    });
  });
});
