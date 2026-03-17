## MODIFIED Requirements

### Requirement: Agent conversation loop
The agent SHALL run a conversation loop that executes tool calls and returns responses to the user. The loop SHALL include anomaly detection to prevent runaway behavior.

#### Scenario: Normal tool use completes turn
- **WHEN** the agent calls tools and eventually produces a text response with no tool calls
- **THEN** the turn SHALL complete and the text response SHALL be returned to the user

#### Scenario: Max iterations reached
- **WHEN** the agent reaches `MAX_AGENT_ITERATIONS` without producing a final text response
- **THEN** the agent SHALL inject a summary prompt and return the model's summary to the user

#### Scenario: High tool error rate halts turn
- **WHEN** more than 50% of recent tool calls fail
- **THEN** the agent loop SHALL halt with an error message describing the high failure rate

#### Scenario: Repetitive tool call loop halts turn
- **WHEN** the same tool with identical arguments is called more than `AIGENT_LOOP_MAX_REPEATS` times within the last `AIGENT_LOOP_WINDOW` tool calls
- **THEN** the agent loop SHALL halt immediately and surface a descriptive error naming the looping tool
