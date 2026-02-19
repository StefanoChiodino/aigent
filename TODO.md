~~BUG: reasoning and thinking level should shift to the left hand instead of the top bar~~ DONE

~~BUG: we have some mounts by default, but I can't ever see any on the left hand side. I can see new ones tho!~~ DONE — implicit docker-compose.yml mounts now included in sidebar

## Token Optimization / Cost Savings

### High impact
- [x] Split system prompt caching — split into [cached base instructions] + [uncached workspace context] so the stable block stays cached. Provider interface now accepts string[], buildSystemPrompt puts cache_control only on first block
- [x] Dynamic tool output truncation — scales to remaining context budget (available = contextWindow - currentUsage - responseBuffer; if result > available/2, truncate to available/3; floor at 10K chars)
- [x] Sub-agent model routing — spawn_agent/dispatch_task tool descriptions now guide the agent to use Haiku for simple read-only tasks. Model parameter already supported
- [x] Per-message thinking override (Ctrl+Enter = boost) — send with high/max thinking for one message only, default stays at current level. Avoids /effort round-trips. Needs: web UI keydown handler, protocol field { type: 'message', content, thinkingOverride? }, server-side one-shot override in agent.ts

### Medium impact
- [x] Cache hit monitoring — llm-proxy.ts now logs cacheHitRate% (cacheRead / (cacheRead + input)) on every response
- [x] Thinking heuristics — auto-lowers thinking on trivial messages (≤10 words, no complex keywords → low; ≤30 words → one level down). Restores after first iteration
- [x] Workspace config file caching — readCached() in workspace.ts checks mtime before re-reading. Config and memory files skip disk reads when unchanged

### Low impact / quick wins
- [x] Workspace memory index compression — older file previews truncated to 50 chars, capped to last 30 days, omits excess
- [x] Compaction prompt optimization — compact.ts prompt tightened from 7 verbose lines to 1 concise line (~100 tokens saved per compaction)
- [x] Image deduplication — tracks SHA-256 hashes of image data, replaces duplicates with text placeholder
- [x] Tool metadata stripping during compaction — strips bulky fields (content, file_content, data, base64) from tool inputs, tighter truncation (150 chars input, 300 chars results)

### Others

~~paste images/screenshots~~

~~attachments~~



~~background tasks should be visible on the web UI sidebar (running/completed). Currently only visible as yellow completion messages in chat.~~ DONE — Tasks section in sidebar shows running (pulsing), completed (checkmark), failed (X) with descriptions

~~implement model picker in the ui left bar. How can we handle models? E.g. for anthropic, can we query which are available? Same as reasoning, it should have a default but store the last used~~ DONE — sidebar picker with chevron button; list fetched from Anthropic API at startup (via listModels() on Provider), falls back to hardcoded defaults; last used persists via autosave

on web, asking for permission should be a bit more obvious, maybe need an audio clue as well, maybe even a web notification

implement local STT with nvidia parakeet

implement local tts using microsoft TTS

When mounting, should I not specify what folder to mount into the guest? Maybe that's just not useful and we can keep it being a 1:1?

~~reasoning and effort should persist between reloads. The env vars should just be defaults~~ DONE — thinking level + savedEffortLevel now persisted in .autosave.json and restored on server restart

System messages could be collapsed when coming out in a row. As in, should look distinct, but present in the same yellow box to avoid taking too much space

BUG: after cancelling a task the blinking loading character doesn't go away from old tasks
model parameter for dispatch_task not being respected — all background agents report as Claude 3.5 Sonnet regardless of specified model

How can I deal with the fact that not all models support reasoning and uh it seems to me that it allows me to turn it on for haiku which doesn't support reasoning, I believe.