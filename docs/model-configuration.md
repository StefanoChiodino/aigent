# Model Fine-Tuned Parameters

Comprehensive configuration options for controlling model behavior.

## Quick Start

1. Open Settings (gear icon in sidebar)
2. Scroll to "Model" section
3. Adjust parameters as needed
4. Click Save

## Generation Parameters

### Temperature (`model_temperature`)

**Range:** 0.0 to 2.0  
**Default:** 0.7  
**Type:** Number

Controls randomness in responses.

| Value | Behavior | Use Case |
|-------|----------|----------|
| 0.0 | Deterministic (lowest quality) | Repetitive tasks |
| 0.3-0.5 | Focused | Coding, technical writing |
| 0.7-0.9 | Balanced | Most tasks (recommended) |
| 1.0-1.5 | Creative | Writing, brainstorming |
| 1.5-2.0 | Maximum randomness | Not recommended |

**Recommended:** 0.7 for most tasks.

### Top P (`model_top_p`)

**Range:** 0.0 to 1.0  
**Default:** 0.95  
**Type:** Number

Nucleus sampling threshold. The model considers tokens with cumulative probability up to `top_p`.

- Lower values (0.7-0.9): More focused, predictable outputs
- Higher values (0.95-1.0): More diverse, creative outputs

**Recommended:** 0.95 for balanced results.

### Top K (`model_top_k`)

**Range:** 0 to 500  
**Default:** 0 (disabled)  
**Type:** Number

Limit sampling to top K tokens per token generation.

- 0: Disabled (no limit)
- 10-40: Very focused
- 40-80: Focused (recommended)
- 80-200: Balanced
- 200-500: Diverse

**Recommended:** 40-80 for focused generation.

### Presence Penalty (`model_presence_penalty`)

**Range:** -2.0 to 2.0  
**Default:** 0.0  
**Type:** Number

Discourages repeating topics throughout the response.

- Positive (0.0-2.0): Discourages repeating topics
- Zero (0.0): No effect (default)
- Negative (-2.0 to 0.0): Encourages repeating topics

**Recommended:** 0.0-0.5 for most tasks.

### Frequency Penalty (`model_frequency_penalty`)

**Range:** -2.0 to 2.0  
**Default:** 0.0  
**Type:** Number

Discourages repeating tokens throughout the response.

- Positive (0.0-2.0): Discourages repeating tokens
- Zero (0.0): No effect (default)
- Negative (-2.0 to 0.0): Encourages repeating tokens

**Recommended:** 0.0-0.5 for most tasks.

### Repetition Penalty (`model_repetition_penalty`)

**Range:** 0.5 to 2.0  
**Default:** 1.1  
**Type:** Number

Penalty for repeated tokens.

- >1.0: Reduces repetition
- 1.0: No effect (neutral)
- <1.0: Encourages repetition

**Recommended:** 1.1 for most tasks.

## Stop Sequences (`model_stop_sequences`)

**Type:** Text (multi-line)

Custom sequences that stop generation. One sequence per line.

**Example:**
```
###
Human:
Q:
Assistant:
```

Use when you need specific output formatting.

## Behavior Controls

### Max Tool Calls Per Turn (`model_max_tool_calls`)

**Range:** 0 to 100  
**Default:** 0 (unlimited)  
**Type:** Number

Maximum number of tool calls allowed in a single turn.

- 0: Unlimited
- 5-10: Simple tasks
- 10-20: Complex tasks (recommended)
- 20-50: Very complex tasks

**Recommended:** 10-20 for complex tasks.

### Allow Parallel Tool Use (`model_allow_parallel_tool_use`)

**Type:** Toggle  
**Default:** true

Enable when the model supports calling multiple tools in a single turn.

- true: Model can call multiple tools (faster)
- false: Model calls tools sequentially (slower)

**Recommended:** true for most models.

### Max Tokens Per Turn (`model_max_tokens`)

**Range:** 100 to 131072  
**Default:** 16384  
**Type:** Number (per-model)

Maximum tokens allowed per turn. Set individually for each model tier.

- 8192: Short responses
- 16384: Medium responses (default)
- 32768: Long responses
- 65536: Very long responses
- 131072: Maximum (if supported)

**Recommended:** Set per model based on use case.

## Caching

### System Prompt Caching (`model_use_system_prompt_caching`)

**Type:** Toggle  
**Default:** true

Enable prompt caching for system messages. Reduces cost for repeated prompts.

- true: Cache system prompt (reduces cost)
- false: No caching (default cost)

**Recommended:** true for most use cases.

**Note:** Only works with supported providers (Anthropic, some OpenAI-compatible).

### Response Caching (`model_use_response_caching`)

**Type:** Toggle  
**Default:** false

Enable response caching for identical requests. Reduces cost for repeated queries.

- true: Cache responses (reduces cost for repeated queries)
- false: No caching (default cost)

**Recommended:** false unless you need to cache identical queries.

**Note:** Only works with Anthropic.

## Vision & Documents

### Image Input Quality (`model_image_input_quality`)

**Type:** Select  
**Options:**
- Low: Cheaper, faster
- High: Better quality (default)

Control image compression for vision models.

- Low: Compress images (cheaper, faster, lower quality)
- High: No compression (more expensive, slower, better quality)

**Recommended:** High for important images, Low for quick checks.

### Max Images Per Message (`model_image_input_max_images`)

**Range:** 0 to 20  
**Default:** 5  
**Type:** Number

Maximum number of images allowed in a single user message.

- 0: Unlimited
- 1-3: Single image focus
- 3-10: Multi-image analysis (recommended)
- 10-20: Batch processing

**Recommended:** 5 for most use cases.

### Max PDF Pages Per Message (`model_document_input_max_pages`)

**Range:** 0 to 1000  
**Default:** 20  
**Type:** Number

Maximum number of PDF pages to process in a single message.

- 0: Process all pages (unlimited)
- 1-10: Single document pages
- 10-50: Medium documents (recommended)
- 50-200: Long documents
- 200-1000: Very long documents

**Recommended:** 20 for most use cases.

## Advanced

### Stream Timeout (`AIGENT_STREAM_TIMEOUT`)

**Range:** 1000 to 600000 ms  
**Default:** 120000 ms (120 seconds)  
**Type:** Number

Maximum time to wait for a stream to complete before aborting.

- 1000-30000 ms: Fast timeout (1-30 seconds)
- 30000-120000 ms: Medium timeout (30-120 seconds)
- 120000-300000 ms: Slow timeout (2-5 minutes)
- 300000-600000 ms: Very slow timeout (5-10 minutes)

**Recommended:** 120000 ms (120 seconds) for most tasks.

### Max Reasoning Tokens (`AIGENT_MAX_REASONING_TOKENS`)

**Range:** 100 to 32768  
**Default:** 8192  
**Type:** Number

Maximum reasoning tokens before aborting. Prevents infinite thinking loops.

- 100-1000: Very short reasoning
- 1000-4096: Short reasoning
- 4096-8192: Medium reasoning (default)
- 8192-16384: Long reasoning
- 16384-32768: Very long reasoning

**Recommended:** 8192 (50% of maxTokens) for most tasks.

### Per-Model Fine-Tuned Parameters (`model_per_model_config`)

**Type:** Text (JSON)

Fine-tuned parameters for each model. JSON object mapping model IDs to custom settings.

**Example:**
```json
{
  "claude-opus-4-6": {
    "temperature": 0.3,
    "max_tokens": 32000,
    "presencePenalty": 0.5,
    "frequencyPenalty": 0.5
  },
  "claude-haiku-4-5": {
    "temperature": 0.7,
    "max_tokens": 8192,
    "presencePenalty": 0.0,
    "frequencyPenalty": 0.0
  },
  "claude-sonnet-4-6": {
    "temperature": 0.5,
    "max_tokens": 16384,
    "presencePenalty": 0.3,
    "frequencyPenalty": 0.3
  }
}
```

**Use Cases:**
- Different models for different tasks
- Fine-tune per model tier (Flash/Pro/Ultra)
- Custom parameters per model

**Recommended:** Set per model based on use case.

## Model Tiers

### Flash Model (`AIGENT_FLASH_MODEL`)

Fast, low-cost tier. Used for:
- Simple search
- Summarization
- Classification
- Quick tasks

**Recommended:** Haiku family (`claude-haiku-4-5-*`).

### Pro Model (`AIGENT_PRO_MODEL`)

Balanced tier. Used for:
- Analysis
- Code changes
- Moderate reasoning
- Standard tasks

**Recommended:** Sonnet family (`claude-sonnet-4-*`).

### Ultra Model (`AIGENT_ULTRA_MODEL`)

Most capable tier. Used for:
- Complex reasoning
- Architecture
- Deep analysis
- Critical tasks

**Recommended:** Opus family (`claude-opus-4-*`).

## Thinking Level (`AIGENT_THINKING`)

**Type:** Select  
**Options:** Off, Low, Medium, High, Max  
**Default:** High

Reasoning level at startup.

- Off: No reasoning (fastest)
- Low: Minimal reasoning
- Medium: Moderate reasoning
- High: Full reasoning (default)
- Max: Extended reasoning (slowest)

**Recommended:** High for most tasks.

## Recommended Configurations

### Coding Tasks

```json
{
  "model_temperature": 0.3,
  "model_top_p": 0.9,
  "model_top_k": 40,
  "model_presence_penalty": 0.5,
  "model_frequency_penalty": 0.5,
  "model_max_tool_calls": 10,
  "model_allow_parallel_tool_use": true
}
```

### Creative Writing

```json
{
  "model_temperature": 0.9,
  "model_top_p": 0.95,
  "model_top_k": 80,
  "model_presence_penalty": 0.0,
  "model_frequency_penalty": 0.0
}
```

### Research & Analysis

```json
{
  "model_temperature": 0.5,
  "model_top_p": 0.95,
  "model_top_k": 60,
  "model_presence_penalty": 0.3,
  "model_frequency_penalty": 0.3,
  "model_max_tokens": 32768
}
```

### Quick Tasks

```json
{
  "model_temperature": 0.7,
  "model_top_p": 0.95,
  "model_top_k": 40,
  "AIGENT_THINKING": "low"
}
```

## Validation

All settings are validated before use:

- **Number inputs:** Range, step, type
- **Text inputs:** Valid JSON, non-empty arrays
- **Select inputs:** Valid option value

Invalid values are rejected and defaults are used instead.

## Error Handling

If a provider rejects a parameter:

1. Log warning
2. Retry without offending parameter
3. Continue with remaining parameters

## Backward Compatibility

All new settings are optional with sensible defaults. Existing behavior is unchanged if settings are not configured.

## Further Reading

- [Anthropic API Documentation](https://docs.anthropic.com/en/api/messages)
- [OpenAI API Documentation](https://platform.openai.com/docs/api-reference/chat)
- [Provider Abstraction Layer](src/provider.ts)
