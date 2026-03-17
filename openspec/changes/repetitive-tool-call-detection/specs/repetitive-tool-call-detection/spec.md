## ADDED Requirements

### Requirement: Detect repeated tool calls within a turn
The system SHALL track all tool calls made during a single agent turn and detect when the same tool is called with identical arguments more than a configurable threshold number of times within a sliding window of recent tool calls.

#### Scenario: Loop detected — identical calls exceed threshold
- **WHEN** the agent calls tool `grep` with identical arguments 5 or more times within the last 10 tool calls of a single turn
- **THEN** the agent loop SHALL halt immediately after the repetition is detected, before the next LLM call is made

#### Scenario: No loop — repeated calls below threshold
- **WHEN** the agent calls the same tool with identical arguments fewer than the configured max-repeats threshold
- **THEN** the agent loop SHALL continue normally without interruption

#### Scenario: No loop — same tool, different arguments
- **WHEN** the agent calls the same tool multiple times with different arguments
- **THEN** each distinct (tool, args) pair SHALL be counted independently and SHALL NOT contribute to each other's repetition count

### Requirement: Inject descriptive error on loop detection
The system SHALL inject a descriptive error message into the conversation when a repetitive tool call loop is detected.

#### Scenario: Error message names the looping tool
- **WHEN** a loop is detected for tool `grep`
- **THEN** the error message surfaced to the user SHALL name `grep` and indicate the agent appears stuck in a loop

#### Scenario: Agent turn halts, user can re-prompt
- **WHEN** a loop is detected mid-turn
- **THEN** the agent turn SHALL end and the user SHALL be able to send a new message to continue

### Requirement: Configurable detection thresholds
The system SHALL expose loop detection thresholds as environment variables with safe defaults.

#### Scenario: Default thresholds applied when env vars absent
- **WHEN** `AIGENT_LOOP_WINDOW` and `AIGENT_LOOP_MAX_REPEATS` are not set
- **THEN** the system SHALL use a sliding window of 10 and a max-repeats threshold of 5

#### Scenario: Custom thresholds from env vars
- **WHEN** `AIGENT_LOOP_WINDOW=20` and `AIGENT_LOOP_MAX_REPEATS=3` are set
- **THEN** the system SHALL use a window of 20 and a max-repeats threshold of 3

### Requirement: Detector resets between turns
The system SHALL reset the repetition tracking state at the start of each new agent turn so that repeated tool use across separate user messages is not flagged.

#### Scenario: Same tool used in consecutive turns without triggering loop detection
- **WHEN** the agent calls `read_file` 4 times in turn 1 and 4 times in turn 2 (threshold = 5)
- **THEN** no loop SHALL be detected in either turn
