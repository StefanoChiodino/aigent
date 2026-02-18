/**
 * Protocol types for client ↔ server communication over Unix socket.
 * Newline-delimited JSON (NDJSON).
 */

import type { ThinkingLevel } from './agent.js';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number; // Estimated cost in USD (informational, even for subscription users)
  contextTokens?: number; // Latest API call's input tokens = actual context window fill
}

// --- Client → Server ---

export type ClientCommand =
  | { type: 'message'; content: string }
  | { type: 'cancel' }
  | { type: 'command'; cmd: string }
  | { type: 'ping' };

// --- Server → Client ---

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  elapsed?: number | undefined;
}

export interface ServerState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  thinking: ThinkingLevel;
  profile: string;
  sessionId: string;
  model: string;
  isLoading: boolean;
}

export type ServerEvent =
  | { type: 'connected'; state: ServerState }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; name: string; input: string; summary: string }
  | { type: 'tool_output'; content: string }
  | { type: 'tool_end' }
  | { type: 'message'; message: DisplayMessage }
  | { type: 'system'; content: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string }
  | { type: 'state'; thinking?: ThinkingLevel; profile?: string; sessionId?: string }
  | { type: 'pong' };

// Socket path
export const SOCKET_PATH = '/tmp/aigent.sock';
