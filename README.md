# Hermes Gateway for VS Code

A standalone VS Code extension that connects [Hermes Agent](https://hermes-agent.nousresearch.com/) to VS Code through the local Hermes Gateway.

## Current status

The extension opens a **Hermes** chat view in VS Code's right-hand Secondary Side Bar through the `Hermes Gateway: Open Chat` command. It attaches to the local Gateway, creates or resumes a repository-scoped session, streams parent responses, displays delegated task lifecycle rows, and presents Gateway approval choices in VS Code.

When connected, **Automatically approve file edits for this Gateway session** enables automatic selection of Gateway's `session` choice only for `patch` and `write_file` approvals. It never auto-approves terminal commands or approvals without a session-scoped choice, and it resets when the Gateway session changes or disconnects.

The extension does not launch or support ACP.

## Development

Requirements:

- Node.js 22+
- Visual Studio Code 1.85+
- A running local Hermes Gateway

```sh
npm install
npm run compile
npm run lint
npm test
```

Press F5 in VS Code to launch an Extension Development Host.

## Build and install (permanent, no F5)

`npm run vsix` builds a production bundle and packages it into `hermes-gateway-0.0.1.vsix`. Install that file once and the extension loads on every VS Code start — no Extension Development Host needed.

```sh
npm run vsix
```

Install the produced `.vsix` either way:

- **GUI:** Extensions view (`Cmd+Shift+X`) → `...` → `Install from VSIX...` → pick `hermes-gateway-0.0.1.vsix`.
- **CLI:** `code --install-extension hermes-gateway-0.0.1.vsix`. If `code` is not on PATH, use the full path: `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension hermes-gateway-0.0.1.vsix`.

Reload the window (`Cmd+Shift+P` → `Reload Window`); the **Hermes** view then appears automatically in the Secondary Side Bar.

To update after code changes, rebuild and reinstall — the new `.vsix` overwrites the installed one — then reload:

```sh
npm run vsix
code --install-extension hermes-gateway-0.0.1.vsix
```

`*.vsix` and `dist/` are git-ignored, so local builds never enter version control.
