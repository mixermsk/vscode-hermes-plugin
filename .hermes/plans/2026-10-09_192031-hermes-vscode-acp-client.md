# Hermes-only VS Code ACP Client Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Build a standalone VS Code extension that connects specifically to `hermes acp`, automatically continues the newest session associated with the opened Git repository, and establishes a clean foundation for selecting other repository sessions later.

**Architecture:** The extension owns the VS Code UI, lifecycle and persistence; a narrow `AgentAdapter` boundary owns agent-specific launch/auth/defaults. The first implementation has one `HermesAgentAdapter`, launches `hermes acp` over stdio, and uses the ACP SDK for transport. Session records are stored locally and indexed by stable repository identity, not by a branch name; branch metadata is retained only for display and later filtering.

**Tech Stack:** TypeScript, VS Code Extension API, `@agentclientprotocol/sdk`, Node.js child processes, VS Code `ExtensionContext.globalState` (initial persistence), VS Code test runner, ESLint.

---

## Scope and acceptance criteria

### Required in v0.1

1. The extension launches only Hermes via a configurable `hermes` executable plus a default `acp` argument.
2. It uses the opened workspace folder / Git worktree root as Hermes's CWD.
3. It computes a stable repository identity:
   - preferred: normalized `remote.origin.url` plus repository root;
   - fallback: canonical filesystem path to the Git root when no origin exists;
   - explicit worktree roots remain distinct execution CWDs but can share a logical Git remote identity for discovery.
4. On opening a repository, it locates the newest known Hermes session for that repository and offers/attempts to continue it; a failed resume must never silently create a new session.
5. If no usable recorded session exists, it starts a new ACP session.
6. It renders streaming user/agent text, status/progress, errors, cancellation, and permission requests.
7. It stores enough metadata after each new/resumed session to later list and switch sessions within the same repository.
8. Default permissions are interactive; no global auto-approve setting in v0.1.
9. ACP traffic and agent stderr are available in named VS Code Output channels with secrets redacted.

### Explicitly deferred

- Support for non-Hermes agents; only the adapter abstraction and test seams are built now.
- Session-picker UI and branch filters (the persistence model supports them now; the command/UI arrives in v0.2).
- Generic terminal/file-system ACP bridges unless the Hermes compatibility probe proves they are required.
- Multi-root workspaces, remote VS Code extension hosts, account setup UI, agent registry, attachment UX, and generic ACP v2 support.

### Key product decision

“Latest session for this repo” means the record with the greatest `lastActiveAt` under the repository identity, regardless of the Git branch captured at creation. This lets a user resume work after branch switches; later UI may display/filter by `branchAtLastSeen`, but branch is not part of the lookup key.

---

## Proposed file layout

```text
package.json
src/
  extension.ts
  adapters/
    AgentAdapter.ts
    HermesAgentAdapter.ts
  acp/
    AcpConnection.ts
    AcpClient.ts
    SessionUpdateRouter.ts
  domain/
    RepositoryIdentity.ts
    SessionRecord.ts
  services/
    GitRepositoryResolver.ts
    SessionRegistry.ts
    SessionLifecycle.ts
    RedactingLogger.ts
  ui/
    ChatViewProvider.ts
    PermissionController.ts
  test/
    unit/
      GitRepositoryResolver.test.ts
      SessionRegistry.test.ts
      SessionLifecycle.test.ts
      HermesAgentAdapter.test.ts
    integration/
      fake-acp-agent.mjs
      extension.test.ts
```

`AgentAdapter` is deliberately small: launch configuration, human-readable identity, and agent-specific capability quirks. ACP framing, persistent session records, UI, permission policy, and repository lookup must not depend on the adapter implementation.

---

## Development sequence

### Task 1: Create an empty, reproducible VS Code extension scaffold

**Objective:** Establish the build, lint, test and Extension Development Host baseline without inheriting code from the abandoned extension.

**Files:**
- Create: `package.json`, `tsconfig.json`, `eslint.config.mjs`, `webpack.config.js`
- Create: `src/extension.ts`
- Create: `src/test/integration/extension.test.ts`
- Create: `.vscode/launch.json`, `.vscode/tasks.json`
- Create: `README.md`, `.gitignore`

**Steps:**
1. Configure TypeScript, VS Code engine, `@types/vscode`, linting, test runner and production packaging.
2. Register one `hermesAcp.openChat` command and one contributed sidebar webview placeholder.
3. Add an extension-host smoke test that activates the extension and asserts the command is registered.
4. Run `npm run lint`, `npm run compile`, and `npm test` in the Extension Development Host test harness.

**Expected validation:** a fresh clone can run `npm install`, `npm run compile`, `npm test`, then F5 to open an Extension Development Host.

---

### Task 2: Model stable repository identity before any ACP work

**Objective:** Make session association correct across VS Code restarts and future branch switching.

**Files:**
- Create: `src/domain/RepositoryIdentity.ts`
- Create: `src/services/GitRepositoryResolver.ts`
- Create: `src/test/unit/GitRepositoryResolver.test.ts`

**Steps:**
1. Define an immutable `RepositoryIdentity`:
   ```ts
   type RepositoryIdentity = {
     logicalId: string;
     gitRoot: string;
     cwd: string;
     remoteOrigin?: string;
     branch?: string;
   };
   ```
2. Implement Git discovery through a narrow injectable command runner. Resolve `git rev-parse --show-toplevel`, `git remote get-url origin`, and `git branch --show-current`.
3. Normalize only presentation-safe identity components: trim whitespace, normalize local paths, remove a trailing `.git` from remote URLs, but do not rewrite arbitrary remote URLs.
4. Generate `logicalId` from `origin:<normalized-origin>` where available; otherwise `path:<canonical-git-root>`.
5. Write failing unit tests for: normal origin, no-origin repo, detached HEAD, worktree path, command failure and no workspace folder.
6. Run only the new unit test first; then add the minimal implementation and run the full unit suite.

**Acceptance criteria:** changing branches never changes `logicalId`; a repository without `origin` still gets a deterministic local identity; a Git error produces a typed “not a repository” result rather than a guessed key.

---

### Task 3: Add versioned persistent session registry

**Objective:** Persist session metadata locally, indexed by repository, without pretending this is an authoritative copy of Hermes history.

**Files:**
- Create: `src/domain/SessionRecord.ts`
- Create: `src/services/SessionRegistry.ts`
- Create: `src/test/unit/SessionRegistry.test.ts`

**Data model:**
```ts
type SessionRecord = {
  schemaVersion: 1;
  agentKind: 'hermes';
  sessionId: string;
  repositoryId: string;
  gitRoot: string;
  cwd: string;
  remoteOrigin?: string;
  branchAtLastSeen?: string;
  createdAt: string;
  lastActiveAt: string;
  title?: string;
  resumeState: 'unknown' | 'resumable' | 'resume-failed';
};
```

**Steps:**
1. Store records under one namespaced `globalState` key, with explicit schema versioning and a bounded retention policy (for example, newest 50 sessions per repository).
2. Implement `upsert`, `getMostRecent(repositoryId)`, `list(repositoryId)`, `markResumeFailed`, and `touch`.
3. Deduplicate by `(agentKind, sessionId)`; never create a duplicate merely because the branch changed.
4. Test ordering, deduplication, bounded retention, schema migration/default handling, and failed-resume marking.

**Acceptance criteria:** after a session is first recorded, `getMostRecent` returns the correct ID after extension reload; unrelated repositories cannot leak into its result.

---

### Task 4: Define the adapter seam and Hermes launch contract

**Objective:** Keep Hermes-specific behavior isolated while avoiding speculative multi-agent features.

**Files:**
- Create: `src/adapters/AgentAdapter.ts`
- Create: `src/adapters/HermesAgentAdapter.ts`
- Create: `src/test/unit/HermesAgentAdapter.test.ts`
- Modify: `package.json`

**Steps:**
1. Define the adapter API around `id`, `displayName`, `buildLaunchSpec(repository)`, and optional compatibility metadata. Do not include an agent registry.
2. Implement `HermesAgentAdapter` with settings:
   - `hermesAcp.executable` default `hermes`;
   - `hermesAcp.arguments` default `["acp"]`;
   - `hermesAcp.environment` as a validated allowlist/map supplied by the user.
3. The launch specification must set `cwd` to the current Git root/worktree root and pipe stdin, stdout and stderr.
4. Validate missing executable, spawn error and immediate non-zero process exit as user-visible typed errors.
5. Unit-test launch arguments, CWD, environment merge and error mapping.

**Acceptance criteria:** no code outside `HermesAgentAdapter` knows the `hermes acp` command line; adding another agent later requires a new adapter rather than conditionals scattered through the UI.

---

### Task 5: Build ACP connection and compatibility probe

**Objective:** Establish a single, testable stdio connection and discover which ACP capabilities Hermes exposes before implementing client-side bridges.

**Files:**
- Create: `src/acp/AcpConnection.ts`
- Create: `src/acp/AcpClient.ts`
- Create: `src/test/integration/fake-acp-agent.mjs`
- Create: `src/test/unit/AcpConnection.test.ts`

**Steps:**
1. Wrap ACP SDK initialization in `AcpConnection`; expose `initialize`, `newSession`, `resumeSession`, `sendPrompt`, `cancel`, `dispose` and negotiated capabilities.
2. Implement the ACP client callbacks behind a dedicated `AcpClient` class. Initially support only session updates and permission requests. Unsupported callbacks must return explicit protocol errors, never silently succeed.
3. Create a deterministic fake stdio ACP agent fixture that can advertise capabilities, issue a prompt stream, accept cancellation, and simulate resume success/failure.
4. Add a developer-only command or test-only trace that logs the exact initialize response and negotiated protocol version from `hermes acp`.
5. Run `hermes acp --check` manually before the first live test. Then perform a live smoke test against Hermes in an isolated throwaway workspace, without sending secrets or destructive prompts.

**Decision gate:** based on the observed Hermes handshake and a real prompt, decide whether v0.1 requires client-side filesystem, terminal or auth callbacks. Add only required bridges in the next task. Keep the connection interface protocol-version-neutral so ACP v2 can be added later behind a capability adapter.

---

### Task 6: Implement safe permissions and only the needed ACP client callbacks

**Objective:** Map Hermes ACP permission requests to a deliberate VS Code approval UX.

**Files:**
- Create: `src/ui/PermissionController.ts`
- Modify: `src/acp/AcpClient.ts`
- Create: `src/test/unit/PermissionController.test.ts`
- Conditionally create: `src/acp/FileSystemBridge.ts`, `src/acp/TerminalBridge.ts`

**Steps:**
1. Render every permission request with the exact action, human-readable description and agent-provided options.
2. Default to deny/cancel if the view is disposed, the editor is shutting down or the request times out.
3. Do not add “always allow” in v0.1. A later per-workspace policy must be explicit and separately designed.
4. If the Task 5 probe requires filesystem/terminal callbacks, implement only the relevant methods with workspace-root path validation and focused tests. Do not create a generic shell execution abstraction pre-emptively.
5. Test approval, rejection, cancellation/disposal, malformed request content and workspace boundary enforcement.

**Acceptance criteria:** a permission cannot be implicitly granted because VS Code loses focus or the chat webview closes.

---

### Task 7: Implement session lifecycle: resume latest first, create only deliberately

**Objective:** Meet the central behaviour: continue the latest session attached to this repository.

**Files:**
- Create: `src/services/SessionLifecycle.ts`
- Create: `src/test/unit/SessionLifecycle.test.ts`
- Modify: `src/services/SessionRegistry.ts`, `src/acp/AcpConnection.ts`, `src/extension.ts`

**Steps:**
1. On extension activation or first chat open, resolve the repository identity before starting Hermes.
2. Look up `SessionRegistry.getMostRecent(repository.logicalId)`.
3. If a record exists, start Hermes and call ACP `session/resume(record.sessionId)`.
4. On success, `touch` the record with the current CWD/branch and continue with that session.
5. On known “not found”, invalid-session or resume-rejected errors, mark the stored record `resume-failed` and show a non-modal choice:
   - **Start new Hermes session**;
   - **Retry resume**;
   - **Open diagnostics**.
   Do not automatically create a new session.
6. If there is no record, create a session and immediately persist it before accepting the first user prompt.
7. Update `lastActiveAt` after an accepted prompt and after a completed foreground turn, not only at creation.
8. Unit-test no-record, resume success, resume failure, user chooses new session, repeated activation, and repository isolation.

**Acceptance criteria:** reopening VS Code on the same repository reaches the last successful Hermes session; an invalid stale record results in an explainable recovery choice, not lost context hidden behind a new session.

---

### Task 8: Build the minimal production chat view

**Objective:** Supply an ergonomic but intentionally narrow sidebar chat.

**Files:**
- Create: `src/ui/ChatViewProvider.ts`
- Modify: `src/acp/SessionUpdateRouter.ts`, `src/extension.ts`, `package.json`
- Create: `src/test/unit/ChatViewProvider.test.ts`

**Steps:**
1. Contribute an Activity Bar container or sidebar view named “Hermes”.
2. Build a nonce-protected webview with strict CSP; escape all dynamic content before rendering.
3. Render user prompts, assistant markdown, progress/status and tool/permission events. Keep tool event rendering structured; never inject untrusted HTML from an agent.
4. Add Send, Cancel, Restart Hermes connection and Open Diagnostics controls.
5. Preserve only UI draft and scroll state in `workspaceState`; ACP session identity remains in the central registry.
6. Ensure a disconnected/failed-resume state has an actionable retry/new-session UI and cannot appear as an empty successful chat.
7. Test webview message validation and state transitions independently from a real webview wherever possible.

**Acceptance criteria:** a user can open the sidebar, see whether a session was resumed or newly created, send a prompt, watch streamed output, grant/deny a permission and cancel a turn.

---

### Task 9: Add observability, failure recovery and settings documentation

**Objective:** Make inevitable integration failures diagnosable without exposing credentials or protocol payloads accidentally.

**Files:**
- Create: `src/services/RedactingLogger.ts`
- Modify: `src/acp/AcpConnection.ts`, `src/adapters/HermesAgentAdapter.ts`, `src/extension.ts`, `package.json`, `README.md`
- Create: `src/test/unit/RedactingLogger.test.ts`

**Steps:**
1. Create `Hermes ACP` and `Hermes ACP Traffic` output channels.
2. Make protocol traffic logging opt-in by setting, default off; redact authorization values, known secret-shaped keys and configured environment values before output.
3. Capture stderr separately, label process exits with PID/exit code/signal and distinguish launch/initialize/resume/prompt failures.
4. Document prerequisite commands: `hermes acp --check`, `hermes acp --setup`, and extension settings.
5. Document the exact semantics of local session metadata: it is an index for resume, not an export of the Hermes conversation.
6. Test redaction with representative tokens and environment values.

**Acceptance criteria:** a user can attach diagnostics to a bug report without copying model credentials or access tokens.

---

### Task 10: Verify against real Hermes and package a private preview

**Objective:** Prove the extension works outside unit tests before treating it as a usable replacement.

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Create: `scripts/manual-smoke-check.md`

**Steps:**
1. Run all gates: `npm run lint`, `npm run compile`, `npm test`, packaging command, then install the generated VSIX in a clean VS Code profile.
2. In a disposable Git repository, create a new Hermes session, send a non-destructive prompt, reload VS Code, and verify the extension resumes the same ACP session ID.
3. Switch to a different branch in that repository, reload, and verify the same logical repository identity selects the same latest record while retaining the branch label as metadata.
4. Simulate an invalid session record and verify the UI offers retry/new session/diagnostics rather than silently replacing it.
5. Exercise permission deny and cancel flows.
6. Record observed Hermes ACP protocol version and capabilities in the README compatibility section.

**Acceptance criteria:** all automated checks pass and the manual smoke checklist demonstrates new-session creation, restart/resume, stale-session recovery, streaming, cancellation and permission denial.

---

## v0.2: Session switching within one repository

This work is intentionally designed now but implemented only after v0.1 is stable.

1. Expose `SessionRegistry.list(repositoryId)` as a repository-local “Sessions” tree or quick-pick.
2. Show `title`, first prompt/title fallback, `lastActiveAt`, `branchAtLastSeen`, status and short session ID.
3. Selecting a record calls `session/resume`; do not assume `session/load` is required until Hermes capabilities are verified.
4. If a visual transcript is required after switching, use `session/load` only when Hermes advertises it, and show explicit loading state while replaying updates.
5. Offer “Start new session for this repository” separately from selection.
6. Add a safe “forget local record” action that removes only the extension’s local index and never deletes Hermes’s source session.
7. Add tests for ordering, selection, stale entries, same repository/different branch display, and no cross-repository records.

---

## Risks and decisions to verify early

| Risk / unknown | Mitigation / decision |
|---|---|
| Hermes ACP capabilities and protocol version may differ from generic ACP clients. | Run `hermes acp --check`, inspect the initial handshake and complete a real smoke prompt before adding filesystem, terminal or auth bridges. |
| `session/resume` may not replay visible history by itself. | Treat resume of agent context and replay of chat UI as separate concerns; verify Hermes behaviour. If no replay exists, show a truthful “continued session” boundary and add `session/load` only if advertised. |
| Repository identity across linked worktrees is product-sensitive. | Use origin URL as logical identity and retain actual worktree CWD. Before v0.2, validate whether resuming a session from a different worktree is safe for the user's workflow; if not, key by `(logicalId, gitRoot)` instead. |
| Remote URLs can contain credentials. | Strip/redact userinfo before persistence and logging; store a privacy-safe normalized identity, not raw credentials. |
| ACP v2 is evolving and differs materially from v1. | Keep version negotiation in `AcpConnection`; do not couple UI to v1 filesystem/terminal/session-mode types. |
| `globalState` is suitable for an initial small index but not unlimited history. | Enforce retention from day one; migrate to SQLite only if richer search/history makes it necessary. |

## Commit checkpoints

Do not create commits automatically. After user approval, use these reviewable checkpoints:

1. `chore: scaffold hermes vscode extension`
2. `feat: persist repository-scoped session records`
3. `feat: launch hermes over acp stdio`
4. `feat: resume latest repository session`
5. `feat: add hermes chat sidebar`
6. `feat: add diagnostics and package preview`

## Final verification checklist

- [ ] No non-Hermes agent command is launched by default.
- [ ] The latest session lookup is repository-scoped and branch-independent.
- [ ] A failed resume never silently creates a new session.
- [ ] New sessions are persisted before their first prompt.
- [ ] Session IDs and remote URLs are never logged with secrets.
- [ ] Permission failure defaults safely to denial/cancellation.
- [ ] Unit, extension-host and real-Hermes smoke checks have all run.
- [ ] The documented v0.2 switching path uses persisted repository-local records and does not require redesigning v0.1.
