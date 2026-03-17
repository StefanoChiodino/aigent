# Design: Initial aigent Specification

## Technical Approach

### Architecture Decisions

#### 1. Three-Tier Safety System

**Decision**: Implement gatekeeper-based permission model with explicit user approval.

**Rationale**: 
- Prevents unauthorized system access
- Gives user full control over agent capabilities
- Reduces risk of accidental damage

**Implementation**:
- Read tier: File listing and reading
- Write tier: File modification and creation
- Execute tier: Shell command execution

#### 2. Worker Process Isolation

**Decision**: Run agent in separate worker process with limited privileges.

**Rationale**:
- Sandbox prevents system-wide damage
- Easier to kill/restart without affecting host
- Clear separation of concerns

**Implementation**:
- `src/worker.ts` - Sandboxed execution
- `src/gatekeeper.tsx` - Permission enforcement
- IPC for communication between host and worker

#### 3. WebSocket Communication

**Decision**: Use WebSocket for real-time bidirectional communication.

**Rationale**:
- Low latency for chat interface
- Persistent connection for state management
- Works across web and VSCode extensions

**Implementation**:
- `src/server.ts` - WebSocket server on port 3141
- `src/client.ts` - Client interface
- `web/src/hooks/useWebSocket.ts` - React hook

#### 4. Abstract LLM Provider

**Decision**: Abstract LLM interface supporting multiple providers.

**Rationale**:
- Vendor flexibility
- Easy to switch models
- Fallback options when one provider fails

**Implementation**:
- `src/provider.ts` - Provider abstraction
- AnthropicProvider, OpenAIProvider, local providers
- Unified interface for all models

### File Organization

```
src/
├── agent.ts          # Main agent loop and state
├── server.ts         # HTTP + WebSocket server
├── client.ts         # Client-to-server communication
├── provider.ts       # LLM provider abstraction
├── tools.ts          # Tool registry and execution
├── safety.ts         # Safety checks and validation
├── workspace.ts      # Workspace context management
├── compact.ts        # Context compaction logic
└── ...

web/
├── src/
│   ├── app.ts       # Main React app
│   ├── components/  # UI components
│   └── hooks/       # React hooks
└── style.css        # Global styles

vscode-extension/
├── src/             # Extension code
└── package.json     # Extension manifest
```

### State Management

**Decision**: Centralized state in server with WebSocket broadcast.

**Rationale**:
- Single source of truth
- Easy to persist and restore
- Real-time updates to all clients

**Implementation**:
- Server maintains conversation state
- Broadcasts updates to connected clients
- Persists to workspace/memory/ directory

### Error Handling

**Decision**: Graceful degradation with user notifications.

**Rationale**:
- Prevents complete system failure
- Keeps user informed of issues
- Allows recovery from errors

**Implementation**:
- Try-catch in all tool calls
- Error messages to user via chat
- Fallback providers when primary fails

## Security Considerations

### Permission Model

1. **Explicit Approval**: All file writes and shell commands require user approval
2. **Sandboxed Execution**: Agent runs in limited-privilege worker process
3. **Path Validation**: Only workspace-root paths accessible
4. **Audit Trail**: All actions logged for review

### Risk Mitigation

1. **Read-Only Default**: Agent cannot modify files without approval
2. **Shell Command Review**: All commands shown to user before execution
3. **Network Access Control**: Explicit permission for external API calls
4. **Process Isolation**: Worker process can be killed without affecting host

## Future Enhancements

### Planned Features

1. **Browser Automation**: Computer-use API for desktop app interaction
2. **STT/TTS Integration**: Voice input/output capabilities
3. **Multi-Instance Agents**: Per-project agent processes
4. **Enhanced Memory**: Episode-based context with embeddings
5. **Reflection System**: Self-improvement and learning

### Technical Debt

1. **Context Management**: Improve compaction algorithms
2. **Error Recovery**: Better handling of API failures
3. **Testing**: More comprehensive unit and E2E tests
4. **Documentation**: Update docs as features evolve

## Next Steps

1. Review and validate specification accuracy
2. Identify areas needing clarification
3. Plan next change for specific feature implementation
4. Archive this change when complete
