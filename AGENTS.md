# aigent — Project Instructions

## General workflow

Stick to this general plan for any non-trivial change:
1. Investigate, explore, discover
2. Write new docs, or update existing ones
3. Create a plan for your changes for me to review
4. Consider updating @README.md, demo website, e2e and unit tests

## What This Is

A self-authoring AI agent that runs in a sandboxed Docker container with a gatekeeper on the host enforcing least-privilege access. Web UI is the current interface.

For architecture details see `docs/architecture.md`. For roadmap and current state see `docs/PLAN.md`.

## Key Files

| Area | Files |
|------|-------|
| Entry points | `src/gatekeeper.tsx` (host), `src/worker.ts` (sandbox), `src/index.tsx` (legacy) |
| Core agent | `src/agent.ts`, `src/server.ts`, `src/client.ts` |
| Tools | `src/tools.ts`, `src/safety.ts` |
| LLM | `src/provider.ts`, `src/llm-proxy.ts`, `src/socket-provider.ts` |
| UI | `src/ui/App.tsx`, `src/ui/ChatView.tsx`, `src/ui/InputBar.tsx` |
| Web UI | `web/index.html`, `web/src/app.ts`, `src/web-bridge.ts` |
| Memory | `workspace/config/` (AGENTS.md, SOUL.md, etc.), `workspace/memory/` |
| Docs | `docs/PLAN.md` (roadmap), `docs/architecture.md`, `docs/tui-architecture.md` |
| Infra | `Dockerfile`, `docker-compose.yml`, `Makefile`, `package.json` |

## Development Rules

1. **Investigate first, then plan.** For non-trivial changes: explore the codebase, update or write docs, then create a plan for review. Consider updating README.md, the demo website, and tests.
2. **Check TODO.md before starting work.** Don't build something that already exists. Don't start something that isn't prioritized unless the user asks.
3. **Update TODO.md when you finish something.** Check off completed items. Add new items you discover. This is how continuity works across sessions.
4. **Update docs/PLAN.md for architectural changes.** Move features from "Next Up" to "Done". Add new items you discover.
5. **No `console.log` while TUI is active** — it breaks Ink rendering. Log to `/tmp/aigent-server.log`.
6. **Run `make check` before considering code changes done.** This runs typecheck, unit tests, web component tests, and web build. All must pass. Do not skip this — do not commit if it fails.
7. **TypeScript strict mode, ESM, Node 22+.** No CommonJS. No `any` unless absolutely necessary.
8. **Don't over-engineer.** Simple and working beats clever and abstract.
9. **Self-edits are real.** Changes to source persist on the host filesystem and survive container restarts.
10. **Rebuild web UI after changing `web/src/` or `web/style.css`.** Run `rm -rf web/dist && npx vite build --outDir dist web/`. The test server and prod server both serve from `web/dist/`. Playwright e2e tests will fail on stale builds.
11. **Commit early, commit small.** Make atomic commits after each logical change — don't batch multiple unrelated changes. Write clear commit messages that explain *what* changed and *why*. This makes `git revert` trivial when something breaks.
12. **When fixing a bug, write a test first.** Reproduce the failure with a test, then fix the code. This prevents regressions from recurring.

## TODO.md

`TODO.md` in the project root tracks immediate work items. **This is the async handoff mechanism between sessions.** When you start a session:

1. Read TODO.md
2. Check if anything is stale or already done
3. Ask the user what to work on (don't just pick something)
4. Update it as you go
