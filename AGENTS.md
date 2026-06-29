# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## OpenCode Harness Provider SDKs

- When generating OpenCode provider config, prefer the provider's first-class AI SDK package when
  OpenCode supports it. For Groq, use `@ai-sdk/groq` instead of routing through
  `@ai-sdk/openai-compatible`.
- Before adding or changing a custom OpenCode provider, inspect the local OpenCode reference clone
  at `/home/eddy/Projects/opencode`, especially `packages/core/src/plugin/provider/` and
  `packages/core/src/v1/config/provider-options.ts`, to confirm which SDK package and option shape
  OpenCode expects.
- Prefer OpenCode's own SDK and provider-plugin integration path before building direct HTTP
  wrappers in T3 Code. T3 Code should generate OpenCode config, start/connect to the OpenCode
  server, and consume the OpenCode SDK/event stream unless there is a documented gap that requires
  a local shim.
- If OpenCode already ships or uses an SDK for a provider, thread provider options through that
  SDK/config shape instead of hand-rolling request translation. Keep any required "massaging" small,
  documented, and covered by tests around the generated config.
- Use `@ai-sdk/openai-compatible` only as a fallback for providers without a native OpenCode SDK
  plugin, and make that fallback explicit in code/tests.
- Keep provider research and implementation findings in `docs/providers/<provider>.md` when they
  affect future provider behavior, access checks, or account-limit handling.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
