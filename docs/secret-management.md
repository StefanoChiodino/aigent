# Secret Management Research

## How OpenClaw Handles API Keys

OpenClaw uses a layered env var loading strategy (highest priority → lowest):

1. **Process environment** — whatever the Gateway process inherits from its parent shell/daemon
2. **`.env` in CWD** — dotenv in current working directory (non-overriding)
3. **`~/.openclaw/.env`** — global dotenv in state directory (non-overriding)
4. **Config `env` block** — inline in `~/.openclaw/openclaw.json` (applied only if missing)
5. **Shell env import** — optional: runs login shell and imports only missing expected keys (`env.shellEnv.enabled` or `OPENCLAW_LOAD_SHELL_ENV=1`)

### Config env block example
```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

### Env var substitution in config
Config string values support `${VAR_NAME}` syntax:
```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

### Auth for Anthropic specifically
- **Recommended:** API key via env var `ANTHROPIC_API_KEY`
- Onboarding wizard (`openclaw onboard`) writes key to `~/.openclaw/.env`
- For Claude subscription auth: `claude setup-token` → stored in `auth-profiles.json`
- `openclaw models status` and `openclaw doctor` verify auth is working

### Path overrides
- `OPENCLAW_HOME` — overrides home dir for all internal paths
- `OPENCLAW_STATE_DIR` — overrides state directory (default `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` — overrides config file path

### Key takeaway
All plaintext on disk — no OS keychain, no encryption at rest. Security comes from:
- File permissions (state dir is user-owned)
- Separation from source control (`.env` in state dir, not in repo)
- The Gateway process is the only thing that reads the keys; the agent sandbox never sees them directly

## aigent v0 Approach

For v0, we follow OpenClaw's pattern:
- **Project-level `.env`** for API keys (loaded by dotenv at startup)
- Docker compose passes `ANTHROPIC_API_KEY` from host env into container
- `.env` excluded from git via `.gitignore`
- No secrets in committed files

### OAT (Setup-Token) Support

aigent supports both standard API keys (`sk-ant-api03-...`) and subscription/setup-tokens (`sk-ant-oat01-...`).

When an OAT token is detected, aigent switches to **Claude Code compatible mode**:
- Uses `Authorization: Bearer` instead of `x-api-key` header
- Sends Claude Code identity headers (`claude-code-20250219`, `oauth-2025-04-20`)
- Sets `user-agent` to `claude-cli/<version> (external, cli)`
- Prefixes system prompt with Claude Code identity
- Maps tool names to Claude Code canonical names (Read, Write, Bash, etc.)

This is the same approach used by `@mariozechner/pi-ai` (the library underlying OpenClaw).

See: `src/auth.ts` for the implementation.

Source: https://docs.openclaw.ai/help/environment, https://docs.openclaw.ai/gateway/authentication
