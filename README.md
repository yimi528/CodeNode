# CodeNode

[English](README.md) · [简体中文](README.zh-CN.md)

CodeNode is a desktop workbench for working with a coding agent in a local repository. Ask a question in chat, inspect the files and tool calls behind the answer, then use the canvas to organise follow-up tasks. A `.cnode` project saves the workspace alongside your source files.

![Agent conversation beside the project canvas](docs/screenshots/agent-chat.png)

## Run from source

Install Node.js 22.12 or newer on a machine with a desktop environment, then run the following commands.

```sh
git clone https://github.com/yimi528/CodeNode.git
cd CodeNode
npm ci
npm run dev
```

This starts Vite and the Electron window. Open a project from the project sidebar or create one for an existing source directory. In the conversation panel, select a model and connect its provider. For a first task, try “Find the application entry point and show me the files involved in startup.”

## Working in a project

| When you want to… | Use |
| --- | --- |
| Understand or edit code | Chat renders Markdown, including tables and code blocks. Review tool requests in the conversation and inspect the resulting file changes. |
| Turn a plan into tasks | Use the workflow canvas to arrange nodes and dependencies. Open the goal overview to create a draft, inspect a task or review work that needs your input. [Canvas and goals](docs/canvas-and-goals.md) |
| Resume interrupted work | Inspect the run record and checkpoints before continuing. The recovery view distinguishes completed writes from actions that still need review. [Run recovery](docs/run-recovery.md) |
| Change the agent running a task | Choose the built-in backend or connect an external agent through ACP. [Backends](docs/backends.md) |

## Development

`npm run build` checks renderer types and builds the UI. `npm run check:js` checks the Electron process and scripts. Run `npm test` for the core regression suite or `npm run test:list` to find a specific check.

Changes land on `main`. Name working branches `<type>-YYYYMMDD-<topic>`, for example `feat-20261127-merge-desktop-workbench`. See the [contribution guide](CONTRIBUTING.md) for setup and verification, and the [documentation index](docs/README.md) for architecture, evaluations and development history.

## License

[Apache License 2.0](LICENSE)
