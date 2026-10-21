# Hermes ACP for VS Code

A standalone VS Code extension that will connect [Hermes Agent](https://hermes-agent.nousresearch.com/) to VS Code through the Agent Client Protocol (ACP).

## Current status

The extension opens a **Hermes** chat view in VS Code's right-hand Secondary Side Bar through the `Hermes ACP: Open Chat` command. It launches Hermes and creates or resumes ACP sessions for the opened repository.

## Development

Requirements:

- Node.js 22+
- Visual Studio Code 1.85+

```sh
npm install
npm run compile
npm run lint
npm test
```

Press F5 in VS Code to launch an Extension Development Host.

## Planned behaviour

The extension will start `hermes acp`, persist a repository-scoped local index of ACP sessions, resume the latest session for the opened repository, and later provide a repository-local session selector.
