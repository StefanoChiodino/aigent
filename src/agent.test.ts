import { Agent } from './agent';
import type { Provider } from './provider';

// Mock provider for testing
const mockProvider: Provider = {
  sendMessage: jest.fn(),
  listModels: jest.fn(),
  isOAuthToken: false,
};

describe('Agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getEffectiveMaxTokens', () => {
    it('should return model-specific max tokens when available', () => {
      const agent = new Agent({
        provider: mockProvider,
        modelMaxTokens: {
          'claude-sonnet-4-6': 16384,
          'claude-opus-4-6': 32768
        }
      });

      expect(agent['getEffectiveMaxTokens']('claude-sonnet-4-6')).toBe(16384);
      expect(agent['getEffectiveMaxTokens']('claude-opus-4-6')).toBe(32768);
    });

    it('should return default max tokens when model not found', () => {
      const agent = new Agent({
        provider: mockProvider,
        maxTokens: 8192,
        modelMaxTokens: {
          'claude-sonnet-4-6': 16384,
        }
      });

      expect(agent['getEffectiveMaxTokens']('claude-opus-4-6')).toBe(8192);
    });

    it('should return default max tokens when model is empty', () => {
      const agent = new Agent({
        provider: mockProvider,
        maxTokens: 4096,
      });

      expect(agent['getEffectiveMaxTokens']('')).toBe(4096);
    });
  });

  describe('constructor', () => {
    it('should properly initialize modelMaxTokens from options', () => {
      const modelMaxTokens = { 'claude-sonnet-4-6': 16384 };
      const agent = new Agent({
        provider: mockProvider,
        modelMaxTokens
      });

      expect(agent['modelMaxTokens']).toEqual(modelMaxTokens);
    });
  });
});