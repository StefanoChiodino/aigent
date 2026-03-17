# Per-Model Max Tokens Settings

## Overview

The `model_max_tokens` setting provides a rich, interactive editor for configuring maximum token limits across all your models. Features a visual table with color-coded tiers and quick-action buttons.

## Configuration

### Via Settings UI

1. Open Settings → Model group
2. **Important**: First configure your Flash, Pro, and Ultra models in the Model section
3. Find "Per-model max tokens" - the editor will automatically display all configured models

### Table View

The editor displays models in a color-coded table:
- **Green tier** (Flash): Fast, low-cost tier (Haiku family)
- **Blue tier** (Pro): Balanced tier (Sonnet family)  
- **Purple tier** (Ultra): Most capable tier (Opus family)
- **Gray tier** (Custom): Any other models you've added

Each row shows:
- Model tier (color-coded with left border accent)
- Full model name
- Current max token limit (formatted with thousands separator)

### Quick Actions

Click quick buttons to set the first model to common values:
- **8K**: 8192 tokens
- **16K**: 16384 tokens (default)
- **32K**: 32000 tokens

### Edit Mode

Click "Edit JSON" to open a rich JSON editor with:
- Syntax highlighting
- Real-time validation
- Error messages for invalid values
- Multi-line formatting support
- Cancel/Done buttons

## Examples

### View configured models

After setting Flash, Pro, and Ultra models, the table automatically shows all three with their current token limits, color-coded by tier.

### Set different limits per tier

Click "Edit JSON" and enter:
```json
{
  "claude-haiku-4-5-20251001": 8192,
  "claude-sonnet-4-6": 16384,
  "claude-opus-4-6": 32000
}
```

### Use default for all models

Leave the JSON empty `{}` → system uses 16384 token default for all models

### Add custom model

Add any model to the JSON:
```json
{
  "claude-opus-4-6": 65536,
  "google/gemini-2.0-flash": 2048
}
```

Custom models appear in gray tier rows.

### Quick set common values

Use the quick buttons to instantly set the first model to 8K, 16K, or 32K without opening the editor.

## Technical Details

- Type: `model-tokens` (rich table editor)
- Storage: JSON object mapping model names to positive integers
- Validation: Real-time JSON parsing and numeric validation
- Auto-detection: Automatically categorizes models by tier based on name patterns
- Visual feedback: Color-coded tiers with visual separators
- Default: `{}` (empty object uses 16384 token default)
