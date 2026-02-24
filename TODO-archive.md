# aigent — TODO Archive

Completed items moved here to keep `TODO.md` focused on active work.

---

## Security & Safety

- [x] **Safety unit tests** — 92 tests covering all functions in `src/safety.ts`; `make test` target added; pre-commit hook via `.pre-commit-config.yaml` runs typecheck + tests on every commit.
  - **Known gaps documented in tests:**
    - `mkfs *` deny glob doesn't match `mkfs.ext4 /dev/sdb` (minimatch treats `*` as not matching spaces/dots)
    - `validateReadonlyCommand` curl-pipe-to-bash bypass: splits on `|` before checking blocklist patterns

- [x] **`fetch` permission tiers**
  - Domain-based allow/prompt/deny model mirroring `ExecPermissions`. `FetchPermissions` + `checkFetchPermission()` in `src/safety.ts`; `requestFetchApproval()` in `src/server.ts`; gatekeeper handlers + `/approve-fetch` / `/deny-fetch` in `src/gatekeeper.tsx`; web UI approval modal with 🌐 icon; `--always` flag persists hostname to `settings.json` `fetch_permissions` key. 12 new unit tests.

## UI / UX

- [x] **Persist conversation in browser storage** — messages saved to `aigent_chat_history` in localStorage; restored on page load before WS connects; cleared on `/reset`.
- [x] Messages disappear on hard browser reload — fixed by localStorage persistence.

## Implemented Features (from original archive)

- Streaming responses (Anthropic/OpenAI)
- Extended thinking heuristics
- Context compaction
- Multi-provider support
- Self-modification with `tsc --noEmit` gate
- Conversation state auto-save
- Background/sync sub-agents
- 19 Core Tools (`exec`, `read_file`, `fetch`, `patch`, etc.)
- Persistent workspace memory system
- Docker sandbox with `cap_drop ALL`
- Web UI with Push-to-talk, TTS, STT, and Screen capture
- Full MCP client support
- Formal Threat Model documentation (`docs/threat-model.md`)
- Adversarial Red Team analysis (`docs/red-team.md`)
