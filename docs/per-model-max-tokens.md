# Per-Model Max Tokens Implementation

## Overview

This document tracks the implementation of per-model max tokens configuration, allowing different LLM models to have their own token limits.

## Architecture

### Core Components

1. **AgentOptions Interface** ([`src/agent.ts:112-124`](src/agent.ts:112))
   - Added `modelMaxTokens?: Record<string, number>` to map model names to max token limits

2. **Agent Class** ([`src/agent.ts:149-1176`](src/agent.ts:149))
   - Added `modelMaxTokens` property
   - Added `getEffectiveMaxTokens(model: string)` method (lines 754-757)
   - Constructor uses `getEffectiveMaxTokens` to determine initial maxTokens

3. **Settings Schema** ([`web/src/lib/settings-schema.ts:56-688`](web/src/lib/settings-schema.ts:56))
   - Added `model_max_tokens` setting (lines 167-175)
   - Type: `text` with JSON object format
   - Default: `{}`

4. **Settings Store** ([`web/src/stores/settings.ts:1-151`](web/src/stores/settings.ts:1))
   - `buildSettingsPayload` handles `model_max_tokens` key (lines 82-89)
   - Parses JSON and sends as object to server

5. **Server Integration** ([`src/server.ts:1748-1847`](src/server.ts:1748))
   - Currently needs update to read `model_max_tokens` from settings
   - Pass `modelMaxTokens` to Agent constructor

## Implementation Status

### Completed ✅

1. **Design per-model max tokens architecture** - Done
2. **Add model_max_tokens setting to settings-schema.ts** - Done (lines 167-175)
3. **Update buildSettingsPayload in settings.ts to handle modelMaxTokens** - Done (lines 82-89)
4. **Update AgentOptions interface in agent.ts to include modelMaxTokens** - Done (line 123)
5. **Add getEffectiveMaxTokens method to Agent class** - Done (lines 754-757)

### Pending ⏳

6. **Update all maxTokens usages in agent.ts to use getEffectiveMaxTokens**
   - Need to find all places where `this.maxTokens` is used and replace with `getEffectiveMaxTokens(model)`
   - Currently only line 190 uses it in constructor

7. **Update server.ts to read and pass modelMaxTokens to Agent**
   - Need to read `model_max_tokens` from settings
   - Pass to Agent constructor in `initAgent()` function

8. **Add per-model token limits UI to SettingsModal.tsx**
   - Currently uses text input for JSON
   - Could add better UI for managing per-model settings

9. **Add unit tests for getEffectiveMaxTokens**
   - Test cases for:
     - Model-specific max tokens
     - Fallback to default max tokens
     - Empty modelMaxTokens map

10. **Add unit tests for settings payload building**
    - Test `buildSettingsPayload` with `model_max_tokens` key

11. **Run make check to verify all tests pass**
    - Type check
    - Unit tests
    - Web component tests
    - Web build

## TODO List

- [ ] Update all maxTokens usages in agent.ts to use getEffectiveMaxTokens
- [ ] Update server.ts to read and pass modelMaxTokens to Agent
- [ ] Add per-model token limits UI to SettingsModal.tsx
- [ ] Add unit tests for getEffectiveMaxTokens
- [ ] Add unit tests for settings payload building
- [ ] Run make check to verify all tests pass

## Files Modified

- `src/agent.ts` - AgentOptions interface, getEffectiveMaxTokens method
- `web/src/lib/settings-schema.ts` - model_max_tokens setting definition
- `web/src/stores/settings.ts` - buildSettingsPayload handling

## Next Steps

1. Find all usages of `this.maxTokens` in agent.ts
2. Replace with calls to `getEffectiveMaxTokens(this.model)`
3. Update server.ts to read settings and pass to Agent
4. Write comprehensive unit tests
5. Run make check
