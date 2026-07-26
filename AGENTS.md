# Claude Desk Repository Guide

## Product scope

Claude Desk is a Windows-first Electron interface for the locally installed Claude CLI. It organizes workspaces as projects, supports multiple conversations per project, and can discover and resume the CLI's existing sessions. Keep the application local-first: do not add a hosted backend, collect telemetry, or store Claude credentials in this repository.

## Repository layout

- `electron/main.ts`: Electron lifecycle, native dialogs and shell integration, Claude CLI process management, model discovery, and CLI session parsing.
- `electron/preload.ts`: the narrow IPC bridge exposed to the renderer.
- `src/`: React renderer, UI components, shared types, and local persistence.
- `tests/workflow.mjs`: end-to-end behavior tests using a fake Claude CLI.
- `tests/visual-smoke.mjs`: desktop and compact-layout visual checks.
- `dist/`, `dist-electron/`, `release/`, and `artifacts/`: generated output; never edit or commit these directories.

## Development commands

Use Node.js 22 or later and install dependencies from the lockfile.

```powershell
npm ci
npm run dev
npm run typecheck
npm test
npm run dist
```

`npm test` is the required pre-merge check. It performs type checking, builds both processes, runs the workflow test, and runs the visual smoke test.

## Architecture rules

- Keep Node.js and operating-system access in the Electron main process. The renderer must use the typed API exposed by `electron/preload.ts` and declared in `src/global.d.ts`.
- When adding IPC, update the main handler, preload bridge, global declaration, and shared request/response types together. Validate renderer-provided paths and values in the main process.
- Treat `%USERPROFILE%\.claude\projects` session JSONL files as Claude-owned, read-only data. Imported histories must retain their original session IDs so the CLI can resume them.
- Do not persist imported message bodies in `localStorage`; only persist the metadata needed to rediscover them. Preserve storage migrations and tolerate malformed or older saved data.
- Keep streaming events associated with their run ID. A stopped or failed process must leave the conversation in a usable state and must not leak listeners or child processes.
- Preserve the existing model-role mapping behavior. Model roles such as Sonnet, Opus, Fable, and Haiku may resolve to the same configured model and must still remain distinct choices in the UI.

## UI expectations

- A project represents a real workspace directory and can contain multiple conversations.
- Project aliases and conversation titles remain editable. When a project alias differs from the directory name, display both.
- Existing Claude CLI sessions, thinking blocks, tool activity, permission mode, and model information must remain visible and resumable.
- Sending a message should keep the newest output in view unless the user has deliberately scrolled away from the bottom.
- Match the existing restrained desktop-tool design. Reuse Lucide icons, existing components, spacing, colors, and interaction patterns instead of introducing a second visual language.
- Verify that controls and text do not overlap at both desktop and compact window sizes.

## Code and test conventions

- TypeScript is strict. Prefer explicit domain types over `any`, and keep renderer state updates immutable.
- Follow the existing formatting: two-space indentation, double quotes, semicolons, and small focused functions.
- Keep edits scoped to the requested behavior. Do not rewrite unrelated code or generated files.
- Update `tests/workflow.mjs` for behavior changes and `tests/visual-smoke.mjs` for layout or interaction changes. Add regression assertions for bugs.
- Tests must not depend on a developer's real Claude login or mutate real Claude history.

## Releases

The GitHub Actions workflow builds Windows artifacts on pushes and pull requests. To publish a release, update the version in `package.json` and `package-lock.json`, commit it, then push a matching tag such as `v0.2.0`. The tag and package version must match exactly.
