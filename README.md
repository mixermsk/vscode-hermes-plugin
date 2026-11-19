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
