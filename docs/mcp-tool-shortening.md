# MCP Tool Name Shortening — Investigation

> **Status:** Investigated, closed as won't-fix (2026-02-24).
> **TODO item:** "MCP tool name shortening — consider shorter/hashed prefix to reduce per-request token overhead."

## Summary

After thorough investigation, MCP tool name shortening provides negligible token savings (<0.3% of context window), is already mitigated by prompt caching, and carries real risk of degrading LLM tool-use accuracy. Not worth implementing.

## Current Implementation

MCP tools are registered in `src/mcp.ts` with a prefixed naming convention:

- **Tool name:** `mcp_<servername>_<toolname>` (e.g., `mcp_github_create_issue`)
- **Description:** `[MCP:servername] <original description>`
- **Mapping:** `toolToServer` map routes prefixed names back to the originating server
- **Call routing:** `callTool()` strips the prefix before forwarding to the MCP server

## Token Cost Analysis

### Per-tool overhead from naming

| Component | Chars | Approx. tokens |
|-----------|-------|----------------|
| Name prefix `mcp_github_` | 11 | ~3 |
| Description prefix `[MCP:github] ` | 14 | ~3-4 |
| **Total per tool** | 25 | ~6-7 |

### Scaling

| Scenario | Tools | Prefix overhead | % of 200K context |
|----------|-------|-----------------|--------------------|
| 1 server, 10 tools | 10 | ~65 tokens | 0.03% |
| 3 servers, 30 tools | 30 | ~195 tokens | 0.10% |
| 5 servers, 100 tools | 100 | ~650 tokens | 0.33% |

For comparison, tool **input schemas** (the actual bulk) cost ~100-200 tokens per tool, totaling 10,000-20,000 tokens for 100 tools. The name prefix is a rounding error.

### Prompt caching mitigates per-request cost

`src/provider.ts` applies `cache_control: ephemeral` to the last tool definition. This means all tool definitions are prompt-cached after the first API call, served at 1/10th the input token price on subsequent requests. The "per-request overhead" mentioned in the TODO is already handled.

## LLM Behavioral Risks

### Models use tool names as semantic signals

Tool names like `mcp_github_create_issue` provide context that helps the model select the right tool. Shortened names like `mcp_gh_create_issue` carry less semantic information, potentially reducing tool-use accuracy.

### Name hallucination (the Spring AI problem)

Spring AI found that when they truncated tool names, LLMs would "correct" them back to guessed full forms, causing callback lookup failures. While aliases (not truncation) are less prone to this, the risk exists if the model infers the full name from the description.

### Models are NOT pre-trained on specific MCP names

Tool use works from definitions provided in the current request context. The model matches `tool_use` calls to whatever names are in the definitions — like function parameters. There's no built-in dictionary of MCP tool names. The risk is semantic signal loss, not training data mismatch.

## Industry Approaches (for reference)

| Project | Format | Shortening | Issues |
|---------|--------|-----------|--------|
| Claude Code | `mcp__server__tool` | None (user renames server) | [#2485](https://github.com/anthropics/claude-code/issues/2485), [#23149](https://github.com/anthropics/claude-code/issues/23149) |
| Docker MCP Gateway | `server__tool` | Strip prefix before forwarding | Clean gateway pattern |
| Spring AI | `spring_ai_CLIENT_tool` | Truncation | LLM hallucination of full names |
| LibreChat | `tool_mcp_server` | None | 64-char limit errors |
| Roo-Code | Various | Fuzzy matching | Avoids strict name matching |

## API Constraints

Anthropic API validates tool names: `^[a-zA-Z0-9_-]{1,128}$`
- Max 128 characters (raised from 64 in 2025)
- No dots, slashes, or special characters
- This limit is the only practical reason to shorten names (very long server + tool names can exceed it)

## Conclusion

The opt-in `alias` field in `mcp.json` remains a reasonable future addition for users hitting the 128-char API limit, but is not worth implementing proactively. The token savings from name/description shortening are negligible compared to schema costs and are already mitigated by prompt caching.

Higher-impact token optimizations:
- **Tool description trimming** (existing TODO) — verbose descriptions waste 10-50x more tokens than name prefixes
- **Schema pruning** — removing unused optional parameters
- **On-demand tool loading** — only send tools relevant to the current task
- **Tool consolidation** — combine similar tools into parameterized versions
