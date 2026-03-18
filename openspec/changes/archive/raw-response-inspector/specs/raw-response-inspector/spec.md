## ADDED Requirements

### Requirement: Raw turn data is captured per assistant message
For every assistant message produced by the agent, the system SHALL capture the raw LLM API response data for each agent iteration: content blocks in order (text, thinking, tool_use), stop reason, model ID, token usage, and completion timestamp.

#### Scenario: Single-turn response
- **WHEN** the agent completes a response in one iteration (no tool calls)
- **THEN** the assistant message has one raw turn containing the text content block, stop reason `end_turn`, model, and token counts

#### Scenario: Multi-turn response with tool calls
- **WHEN** the agent uses tools across multiple iterations before responding
- **THEN** the assistant message has one raw turn per iteration, each with its content blocks and usage

#### Scenario: Response with thinking blocks
- **WHEN** extended thinking is enabled and the model returns a thinking block
- **THEN** the raw turn includes the thinking block in its correct position within the content block sequence

### Requirement: Raw inspector is accessible from assistant messages
The system SHALL display a "Raw" button on assistant messages that have raw turn data. Clicking it SHALL open the raw response inspector overlay.

#### Scenario: Button visibility
- **WHEN** an assistant message has raw turn data attached
- **THEN** a "Raw" button is visible in the message action bar (alongside copy, TTS, etc.)

#### Scenario: Button absent on old messages
- **WHEN** an assistant message was created before this feature (no raw turn data)
- **THEN** no Raw button appears

#### Scenario: Opening the inspector
- **WHEN** the user clicks the Raw button on an assistant message
- **THEN** the raw response inspector overlay opens showing data for that message

### Requirement: Inspector displays turns with content blocks
The inspector SHALL display each agent iteration as a labelled turn section. Each turn SHALL show: turn number, model, stop reason, timestamp, token usage, and content blocks in order.

#### Scenario: Content block rendering — text
- **WHEN** a turn contains a text content block
- **THEN** the inspector displays it as preformatted scrollable text

#### Scenario: Content block rendering — thinking
- **WHEN** a turn contains a thinking content block
- **THEN** the inspector displays it in a collapsible section labelled "thinking"

#### Scenario: Content block rendering — tool_use
- **WHEN** a turn contains a tool_use content block
- **THEN** the inspector displays the tool name and pretty-printed JSON input

#### Scenario: Multiple turns
- **WHEN** a message has more than one raw turn
- **THEN** each turn is shown as a separate section labelled "Turn N of M"

### Requirement: Inspector provides copy-to-clipboard for raw JSON
The inspector SHALL include a "Copy JSON" button that copies the full raw turn data as a JSON string to the clipboard.

#### Scenario: Copy JSON
- **WHEN** the user clicks "Copy JSON" in the inspector
- **THEN** the complete raw turn array for that message is copied to the clipboard as formatted JSON

### Requirement: Inspector can be closed
The inspector SHALL be dismissible via a close button and by clicking the backdrop.

#### Scenario: Close via button
- **WHEN** the user clicks the close button in the inspector header
- **THEN** the overlay closes

#### Scenario: Close via backdrop
- **WHEN** the user clicks outside the inspector modal on the backdrop
- **THEN** the overlay closes
