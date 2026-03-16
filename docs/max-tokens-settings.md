# Per-Model Max Tokens Settings

## Overview

The `model_max_tokens` setting allows you to configure maximum token limits for each model tier (Flash, Pro, Ultra) through a user-friendly interface instead of editing raw JSON.

## Configuration

### Via Settings UI

1. Open Settings → Model group
2. Find "Per-model max tokens"
3. Set token limits for each tier:
   - **Flash tier**: Fast, low-cost tier (Haiku family)
   - **Pro tier**: Balanced tier (Sonnet family)
   - **Ultra tier**: Most capable tier (Opus family)

### Via Settings JSON

```json
{
  "model_max_tokens": {
    "claude-opus-4-6": 32000,
    "claude-sonnet-4-6": 16384,
    "claude-haiku-4-5-20251001": 8192
  }
}
```

## How It Works

The UI automatically maps tier inputs to the actual model names configured in:
- `AIGENT_FLASH_MODEL` → Flash tier
- `AIGENT_PRO_MODEL` → Pro tier
- `AIGENT_ULTRA_MODEL` → Ultra tier

When you enter a value in a tier input, the system:
1. Reads the current model configuration
2. Maps the tier to the correct model name
3. Updates the underlying JSON setting

## Examples

### Set different limits per tier

Flash: 8192 tokens (fast, cheap)
Pro: 16384 tokens (balanced)
Ultra: 32000 tokens (maximum capacity)

### Use default for all tiers

Leave all inputs blank → uses default 16384 tokens for all models

### Override single tier

Set only Ultra tier to 65536 tokens → Flash and Pro use defaults, Ultra gets custom limit

## Technical Details

- Type: `model-tokens` (new setting type)
- Storage: JSON object mapping model names to positive integers
- Validation: Ensures all values are positive numbers
- Default: `{}` (empty object uses 16384 token default)
