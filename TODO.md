~~BUG: reasoning and thinking level should shift to the left hand instead of the top bar~~ DONE

BUG: we have some mounts by default, but I can't ever see any on the left hand side. I can see new ones tho!

When mounting, should I not specify what folder to mount into the guest? Maybe that's just not useful and we can keep it being a 1:1?


## Token Optimization / Cost Savings

### High impact
- [ ] Split system prompt caching — workspace context reloads every turn via reloadSystemPrompt(), busting the cache on the stable base prompt. Split into [cached base instructions] + [cached tools] + [uncached workspace context] so the big static block stays cached ($0.50-1.00/session saved)
- [ ] Dynamic tool output truncation — currently hard-coded 50KB cap (agent.ts:243). Scale truncation to remaining context budget instead (available = 200K - current_usage - response_buffer; if result > available/2, truncate to available/3) ($1-3/session saved)
- [ ] Sub-agent model routing — route simple read-only background tasks (spawn_agent/dispatch_task) to Haiku instead of Opus. Opt-in, not default ($2-5/background task saved)
- [ ] Per-message thinking override (Ctrl+Enter = boost) — send with high/max thinking for one message only, default stays at current level. Avoids /effort round-trips. Needs: web UI keydown handler, protocol field { type: 'message', content, thinkingOverride? }, server-side one-shot override in agent.ts

### Medium impact
- [ ] Cache hit monitoring — log cache hit rates in llm-proxy.ts (cacheRead / (cacheRead + input)) to verify caching is actually working. Free observability
- [ ] Thinking heuristics — auto-lower thinking effort on trivial messages (short, no complex tool context). Could save $0.20-2.00/session on over-thinking
- [ ] Workspace config file caching — AGENTS.md, SOUL.md, USER.md rarely change. Add cache_control ephemeral on config sections, only reload if mtime changed ($0.30-0.75/session)

### Low impact / quick wins
- [ ] Workspace memory index compression — truncate older file previews to 50 chars, cap to last 30 days, drop preview text (agent can fetch if needed)
- [ ] Compaction prompt optimization — current compact.ts prompt is verbose (~7 lines). Tighten to save ~100 tokens per compaction
- [ ] Image deduplication — track image hashes, skip re-sending identical screenshots
- [ ] Tool metadata stripping during compaction — strip non-essential fields from tool inputs/results before abbreviation

### Others

paste images/screenshots


attachments

BUG: after cancelling a task the blinking loading character doesn't go away from old tasks

on web, asking for permission should be a bit more obvious, maybe need an audio clue as well, maybe even a web notification

implement local audio with nvidia parakeet

implement local tts using microsoft TTS
