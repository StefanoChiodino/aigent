# Contributing to Aigent

Welcome! This document outlines how to contribute, the security model, and how to extend the platform.

## The "Agentic" Workflow

The most productive way to contribute to Aigent is to use Aigent itself to write the code. Since Aigent mounts its own source code (`/app/src`) into the sandbox, it can act as its own development environment.

1. Run `make start` to launch the gatekeeper, sandbox, and web UI.
2. Open the web UI.
3. Ask the agent to implement a feature or fix a bug (e.g., "Read `src/tools.ts` and add a new tool that does X").
4. The agent will read the code, write the new tool, register it, and compile.
5. The gatekeeper will detect the changes, run `tsc --noEmit` to ensure type safety, and automatically restart the sandbox if successful.
6. You can now test the new feature immediately in the same conversation.
7. When satisfied, review the diff on your host machine and commit it.

## Code Style and Expectations

- **No dependencies if possible:** We prefer zero-dependency tools. If you need a utility, try to implement it using Node's standard library (`node:fs`, `node:child_process`, etc.).
- **TypeScript:** Use strict typing. The build will fail if `tsc --noEmit` returns errors.
- **Error handling:** Tools must never throw uncaught exceptions that crash the agent loop. Catch all errors and return them as string responses so the LLM knows what went wrong.

## Threat Model & Security Baseline

Aigent is designed as a powerful "hackable lab" for developers. It is *not* a locked-down, multi-tenant SaaS application. However, because the agent executes arbitrary shell commands and writes files, it requires a robust security baseline to prevent accidental or malicious damage to the host system.

### What the sandbox CAN do by default
- Execute shell commands inside the Docker container (`/workspace`, `/tmp`, `/app`).
- Read and write files within `/workspace` and `/tmp`.
- Read its own source code in `/app/src`.
- Propose config/code edits via `request_config_write` or `apply_patch` (requires user approval).
- Fetch external HTTP/HTTPS URLs (excluding local network / metadata endpoints).

### What the sandbox CANNOT do by default
- Access the host filesystem outside of explicitly mounted directories.
- Access host environment variables (API keys are stripped before execution).
- Request URLs on private IP ranges (e.g., `127.0.0.1`, `169.254.169.254`) to prevent SSRF.
- Run dangerous commands without prompting the user (e.g., `rm -rf /`, `mkfs`).

### Host Access via Gatekeeper
The Gatekeeper runs on the host machine and brokers privileged operations:
- **Mounts:** The agent requests a mount via `request_mount`. The Gatekeeper prompts the user. If approved, the container is restarted with the new mount.
- **Config Edits:** Changes to core files (e.g., `SOUL.md`, `safety.ts`) require human review via `request_config_write`.
- **Host Capabilities:** Interactions with the host OS (clipboard, audio, notifications) are mediated via the `host` tool and require an active `aigent-host` daemon.

### Adding New Tools safely
If you are adding a new built-in tool that interacts with the network or filesystem, you must integrate it with `src/safety.ts`:
- Use `validateWritePath` before writing files.
- Use `validateFetchUrl` before making network requests.
- Use `sanitizedEnv` when spawning child processes.

## Extending via MCP (Model Context Protocol)

If you want to add functionality that requires complex dependencies or interacts with external services, prefer creating an MCP server rather than adding a built-in tool.

1. Configure your MCP servers in `/workspace/mcp.json`.
2. Aigent will automatically discover the tools and namespace them as `mcp_{serverName}_{toolName}`.
3. The agent interacts with these tools just like built-in ones.

This keeps the core repository lightweight while allowing infinite extensibility.