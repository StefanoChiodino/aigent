# Design: Continuous Learning System

> How aigent gets better over time — not through a separate "self-improvement mode"
> but as a byproduct of doing real work.

## The Meta-Goal

aigent should become a better assistant the more you use it. Not by being told
what to improve, but by noticing patterns, learning from friction, and testing
its own capabilities. Three mechanisms work together to make this happen.

---

## The Three Pillars

### 1. Learning on the Job

The agent learns from every interaction — not just what happened, but what
worked, what didn't, and why. This is the foundation everything else builds on.

### 2. Self-Play

The agent tests itself by spinning up a second instance and using it as a user
would — through the browser. This exercises the full stack and reveals issues
that only surface in real use.

### 3. Benchmarks

Structured outcome tracking across both real usage and self-play. Not a
synthetic test suite — a living record of task outcomes that reveals trends
over time.

All three depend on the same data layer: **structured episode records.**

---

## Pillar 1: Learning on the Job

### The Problem

Today the agent logs what happened (daily markdown logs) but doesn't extract
lessons. The memory system is a filing cabinet, not a brain. When the agent
helps write a book, it doesn't learn anything it could apply to writing the
next book.

### Episode Logging

Every meaningful interaction becomes a **structured episode** — a record of
what was attempted, what happened, and what was learned.

```
Episode Record (conceptual schema):
  id:          unique identifier
  timestamp:   when the episode started
  domain:      "book-writing" | "agent-dev" | "debugging" | "web-design" | ...
  task:        short description of what was attempted
  tools_used:  which tools were invoked
  turns:       number of conversation turns
  outcome:     completed | partial | abandoned | failed
  friction:    what was hard, what went wrong, what the user corrected
  lessons:     extracted insights (reusable across future tasks)
  user_rating: optional 1-5 score from the user (null if not rated)
  tags:        freeform tags for retrieval
  cost:        token usage and dollar cost
```

Episodes are **domain-tagged** so that experience transfers within domains
without polluting others. Book-writing episodes inform future book-writing.
Agent-dev episodes inform future agent-dev. Cross-domain patterns (e.g.
"user prefers concise output") can still be extracted during reflection.

### Storage

**Phase 1:** NDJSON file (`workspace/episodes.ndjson`) — append-only, one
JSON object per line. Trivially parseable, greppable, no infrastructure.

**Phase 2:** SQLite (`workspace/episodes.db`) — when the NDJSON file grows
past ~10MB or query patterns need indexing. Migration is mechanical (read
lines, insert rows).

**Phase 3:** SQLite + embeddings — when episode count is high enough that
keyword search misses semantic matches. Local embeddings via Ollama
(`nomic-embed-text`) or SQLite-vec. Same database, new column.

### Episode Boundaries

When does one episode end and another begin?

- **Explicit:** User sends `/reset`, switches profile, or starts a new session
- **Implicit:** Topic shift detected (domain change in conversation), long
  idle gap (>30 min), or context compaction triggers
- **Agent-initiated:** The agent calls a `log_episode` tool to explicitly
  close an episode when a task is complete

The default is conservative: one episode per session, with the agent able to
split into multiple episodes if the session covers distinct tasks.

### Reflection Agent (implemented)

Runs at session boundaries (shutdown, `/reset`) after `distillToMemory()`.
Implementation: `src/reflection.ts` (~180 lines), 17 unit tests.

**How it works:**

1. Loads the last 50 episodes via `queryEpisodes()`
2. Skips if fewer than 5 episodes (not enough data for patterns)
3. Formats episodes into compact text blocks for the LLM
4. Single Haiku call (`claude-haiku-4-5-20251001`, ~$0.005/call) with:
   - Existing MEMORY.md and TODO.md as context (to avoid duplicate suggestions)
   - Structured JSON output: `{ patterns, memoryLessons, todoItems }`
5. Appends new lessons to MEMORY.md under `## Reflection Insights (auto-generated)`
6. Appends new items to TODO.md under `## Reflection-Suggested`
7. Logs reflection record to `workspace/reflections.ndjson`

**MEMORY.md conflict avoidance:** `distillToMemory()` rewrites the whole file
first, then reflection appends to a clearly marked section. Order matters —
distill runs first, reflection runs second.

**Pattern types mined:** recurring friction (2+ episodes), success patterns,
low-rated episodes, cost anomalies. The LLM is instructed to only report
patterns with evidence from multiple episodes.

**Future:** Autonomous code fixes (small, safe self-modifications) are not
yet implemented. Currently reflection only writes to MEMORY.md and TODO.md.

### Feedback Collection (implemented)

Three feedback channels feed into episode records:

1. **UI rating widget** — 5 small dots on each assistant message (1-5 scale),
   visible on hover, persistent via localStorage. Ratings are sent to the server
   and averaged into the episode's `userRating` at log time.
2. **Compaction-triggered episodes** — when context compacts (~80% window),
   an `auto-compact` episode is auto-logged capturing all ratings/friction
   accumulated so far. Counters reset for the new episode segment.
3. **Automated friction signals** — tool failures (`onToolComplete` with
   `ok: false`) and API errors are accumulated as `frictionSignals` strings
   and joined into the episode `friction` field.

Additionally, the system prompt instructs the agent to call `log_episode`
at natural conversation breaks and when it detects user frustration — the
LLM-driven channel requires no code machinery, just prompt guidance.

Feedback goes directly into the episode record's `user_rating` and `friction`
fields.

### What the Agent Cannot Evaluate (Human-in-the-Loop)

The agent perceives the UI through a11y trees and LLM-processed screenshots.
It cannot experience:

- **Visual aesthetics** — layout balance, color harmony, whitespace
- **Interaction feel** — latency, animation smoothness, tactile feedback
- **Audio quality** — TTS naturalness, STT accuracy from the user's perspective
- **Subjective usefulness** — "did this actually help?" vs "did this technically work?"

For these dimensions, the human stays in the loop via lightweight scoring.
The agent's self-assessment covers functional correctness; the user's score
covers experiential quality. Both feed the same episode record.

---

## Pillar 2: Self-Play

### The Concept

The agent spins up a second instance of itself, interacts with it through the
browser as a user would, gives it tasks, and evaluates the results. This is
dogfooding at the extreme — the agent is its own QA team.

### Why This Works for aigent Specifically

The infrastructure already exists:

- **Browser extension** drives the test instance's web UI (type prompts,
  wait for responses, take screenshots, inspect the DOM)
- **`AIGENT_WEB_PORT`** provides port isolation (supervisor on 3141,
  test instance on 3142)
- **Profiles** provide workspace isolation (test instance gets a clean
  workspace)
- **`dispatch_task`** lets the supervisor run evaluations asynchronously
- **Screenshots + a11y tree** let the supervisor inspect results

### Architecture

```
Supervisor (aigent instance, port 3141)
  │
  ├── Launches test instance on port 3142
  │     └── Clean workspace, isolated profile
  │
  ├── Opens browser to localhost:3142
  │     └── Uses browser extension for all interaction
  │
  ├── Loads task from task library
  │     ├── Sends task prompt via browser UI
  │     ├── Waits for completion (polls a11y tree / spinner)
  │     └── Collects results (screenshots, file inspection, test output)
  │
  ├── Evaluates results against criteria
  │     ├── Automated checks (tests pass, files exist, code compiles)
  │     └── LLM-based scoring (quality, completeness, efficiency)
  │
  ├── Logs structured episode with scores
  │
  └── Tears down test instance, moves to next task
```

### Task Library

Tasks are stored as structured records in `workspace/benchmark/tasks/`:

```
Task Record:
  id:          unique identifier
  name:        "Find seeded bugs in a Node project"
  prompt:      the exact text sent to the test instance
  setup:       script to prepare the test environment (seed files, plant bugs, etc.)
  teardown:    script to clean up after evaluation
  eval_type:   automated | llm-scored | human-scored | mixed
  eval_criteria:
    - { check: "file_exists", path: "bug-report.md" }
    - { check: "contains", file: "bug-report.md", text: "null reference" }
    - { check: "test_passes", command: "npm test" }
    - { check: "llm_score", prompt: "Rate the quality of this bug report 1-10", min: 6 }
  tags:        [debugging, code-analysis]
  difficulty:  easy | medium | hard
```

### Task Categories

| Category | Example Tasks | Evaluation |
|---|---|---|
| **Bug finding** | Seed N bugs in a codebase, verify agent finds them | Automated: count found / total |
| **Code generation** | "Build a REST API with these endpoints" | Automated: tests pass + LLM code review |
| **File organization** | Scatter files, ask agent to organize | Automated: check structure |
| **Writing** | "Summarize this document" / "Draft an email" | LLM-scored: coherence, completeness |
| **Debugging** | Break a test, ask agent to fix | Automated: test passes after fix |
| **Research** | "Find all uses of function X and explain the pattern" | LLM-scored: accuracy, completeness |
| **UI changes** | "Add a dark mode toggle" | Mixed: tests + human screenshot review |

### What Self-Play Cannot Test

The agent interacting with itself through screenshots and a11y trees cannot
evaluate the same things a human can't evaluate through those channels:

- Visual polish and aesthetic quality
- Voice interaction quality (TTS/STT)
- The "feel" of using the UI (latency, responsiveness)
- Whether the agent's personality is pleasant to interact with

These require human evaluation. Self-play focuses on **functional competence**:
can the agent complete tasks correctly and efficiently?

### Cost Considerations

Each self-play task involves:
- Test instance startup and teardown
- The test instance's LLM calls (the "inner" agent doing the task)
- The supervisor's LLM calls (evaluation)
- Browser extension overhead (minimal)

To keep costs manageable:
- Use cheaper models for the test instance when possible (Haiku for simple tasks)
- Run self-play during off-hours or on a schedule, not continuously
- Start with a small task library (5-10 tasks) and grow incrementally
- Cache test environments so setup isn't repeated unnecessarily

---

## Pillar 3: Benchmarks

### The Insight

Formal benchmarks are hard to build and risk being artificial. But structured
episode records from real usage and self-play ARE benchmarks — just ones that
emerged from actual work rather than being designed in a lab.

### What Gets Measured

From episode records (both real-use and self-play):

| Metric | Source | What it reveals |
|---|---|---|
| **Task completion rate** | outcome field | Is the agent getting better at finishing tasks? |
| **Turns per task** | turns field | Is it getting more efficient? |
| **User correction rate** | friction field | Is it making fewer mistakes? |
| **User rating trend** | user_rating field | Is subjective quality improving? |
| **Cost per task** | cost field | Is it getting cheaper to operate? |
| **Domain-specific trends** | domain + outcome | Which domains is it strong/weak in? |
| **Failure patterns** | friction + lessons | What categories of failure recur? |
| **Self-play scores** | eval results | Is functional competence improving? |

### Dashboard / Queries

No dedicated dashboard needed initially. The agent can query its own episode
log via tools:

- `search_episodes(domain: "web-ui", outcome: "failed", last: 30)` — recent failures
- `episode_stats(domain: "debugging", period: "month")` — completion rate, avg turns
- `compare_periods(metric: "user_rating", period_a: "2026-02", period_b: "2026-03")`

These queries can be implemented as extensions to the existing `search_memory`
tool, or as a new `query_episodes` tool that operates on the NDJSON/SQLite
episode store.

### Regression Detection

When the agent modifies its own source:

1. Run the self-play task suite (or a relevant subset) before the change
2. Run it again after the change
3. Compare scores

If scores drop, the change is flagged for review. This isn't a CI gate (too
expensive to run on every commit) but a periodic check — weekly, or triggered
when the agent makes significant self-modifications.

### Benchmark Evolution

The task library grows naturally:

- **From real usage:** When a task reveals a weakness, it becomes a benchmark
  task. "The agent failed to handle CORS errors 3 times" → add a "debug CORS"
  task to the library.
- **From self-play:** Tasks where the agent consistently scores low get refined
  into focused regression tests.
- **From the user:** "I want the agent to be good at X" → add representative
  X tasks.

---

## How the Three Pillars Connect

```
Real Usage ────→ Episode Logging ────→ Reflection Agent ────→ Improvements
                      │                      │                     │
                      │                      ├── Updates MEMORY.md │
                      │                      ├── Files TODO items  │
                      │                      └── Small auto-fixes ─┘
                      │
                      ├── Benchmark Queries (trends, patterns)
                      │
Self-Play ─────→ Episode Logging ────→ Regression Detection
                      │                      │
                      └── Task Library ◄─────┘
                            grows from
                            real failures

Human Feedback ─→ Episode Ratings ──→ Experiential quality signal
                                         (what the agent can't self-assess)
```

The episode log is the hub. Everything writes to it, everything reads from it.
The reflection agent is the learning loop. Self-play is the testing loop.
Benchmarks are the measurement layer that emerges from both.

---

## Implementation Phases

### Phase 1: Episode Logging (foundation)

- Define episode schema (TypeScript interface)
- NDJSON append-only storage (`workspace/episodes.ndjson`)
- `log_episode` tool for the agent to record episodes explicitly
- Hook into session end / reset to auto-log if the agent didn't
- Basic `query_episodes` tool (grep over NDJSON, JSON parse, filter)
- Domain tagging (inferred from conversation or set explicitly)

**Depends on:** nothing new — builds on existing workspace system.

### Phase 2: Reflection Agent (done)

- `src/reflection.ts`: direct Haiku LLM call (not `dispatch_task` — server is closing at shutdown)
- Loads last 50 episodes, formats as compact text, asks for recurring patterns
- Structured JSON output: patterns, memoryLessons, todoItems
- Appends to MEMORY.md (`## Reflection Insights`) and TODO.md (`## Reflection-Suggested`)
- Audit log: `workspace/reflections.ndjson`
- Runs after `distillToMemory()` at shutdown and `/reset` — order avoids MEMORY.md conflicts
- Minimum 5 episodes required before reflection fires
- 17 unit tests with mock provider

**Depends on:** Phase 1 (episode storage to read from).

### Phase 3: Self-Play Harness

- Script to launch isolated test instance (different port, clean workspace)
- Task library format (prompt + setup + eval criteria)
- Supervisor loop: load task → send to test instance via browser → evaluate
- Episode logging for self-play results (same schema, tagged as self-play)
- Initial task library: 5-10 tasks covering key categories

**Depends on:** Phase 1 (episode logging), browser extension (already exists).

### Phase 4: Feedback & Ratings (done)

- ~~`ask_user` integration~~ → replaced with UI rating widget (1-5 dots on each message)
- `user_rating` field populated via averaged per-message ratings
- Compaction-triggered episode boundaries (`auto-compact` source)
- Automated friction signals from tool failures and API errors
- System prompt instructs agent to call `log_episode` at natural breaks
- Trend queries available via `query_episodes` tool

### Phase 5: Semantic Retrieval (done)

- Local neural embeddings via `@xenova/transformers` (`all-MiniLM-L6-v2`, 384-dim)
- Sidecar NDJSON index (`workspace/episodes.index.ndjson`) stores embeddings
- `search_episodes` tool — cosine similarity search by meaning, not keywords
- Proactive retrieval — before each agent turn, automatically surface top 3
  relevant past episodes (similarity > 0.4) as context hints
- Auto-indexing — new episodes embedded fire-and-forget in `appendEpisode()`
- Always on — model downloads lazily on first use (~22MB, cached in `~/.cache/`)
- 23 unit tests (cosine similarity, episodeToText, hasIndex, search logic)

---

## Interaction with Existing Memory System

The episode system **complements** the existing memory architecture, it doesn't
replace it:

| System | Purpose | Still needed? |
|---|---|---|
| **MEMORY.md** | Curated long-term knowledge in system prompt | Yes — this is the agent's "working knowledge" |
| **Daily logs** | Raw session records | Yes — these become input to episode extraction |
| **search_memory** | Keyword search over logs | Yes — lightweight retrieval for specific facts |
| **distillToMemory()** | End-of-session consolidation | Yes — but reflection agent extends this |
| **Episode log** | Structured task outcomes and lessons | NEW — the learning layer |
| **Reflection agent** | Pattern extraction and improvement proposals | NEW — the learning loop |

The reflection agent subsumes some of what `distillToMemory()` does, but
doesn't replace it. `distillToMemory()` updates MEMORY.md with session-level
knowledge. The reflection agent extracts structured episodes and cross-session
patterns. Both run at session boundaries.

---

## Open Questions

1. **Episode granularity:** One episode per session, or multiple episodes
   per session when topics shift? Starting with one-per-session is simpler;
   the agent can split if needed.

2. **Reflection agent model:** Haiku (cheap, fast) or the main model
   (better understanding)? Probably Haiku for episode extraction,
   main model for pattern analysis.

3. **Self-play scheduling:** On-demand, nightly, weekly? Start with
   on-demand (user triggers), move to scheduled once the task library
   is stable.

4. **Feedback fatigue:** How often can we ask the user for ratings
   before it becomes annoying? Probably only after tasks the agent is
   uncertain about, not every interaction.

5. **Episode privacy:** Some domains (personal writing, sensitive work)
   may not want full episode records. Need a way to mark conversations
   as private / no-log.
