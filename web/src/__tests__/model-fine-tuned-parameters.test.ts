import { describe, it, expect } from 'vitest';
import type { SettingDef } from '../../lib/settings-schema';
import { SETTINGS_SCHEMA } from '../../lib/settings-schema';

describe('Model Fine-Tuned Parameters', () => {
  it('has all required settings', () => {
    const keys = SETTINGS_SCHEMA.map((s: SettingDef) => s.key);
    
    // Generation parameters
    expect(keys).toContain('model_temperature');
    expect(keys).toContain('model_top_p');
    expect(keys).toContain('model_top_k');
    expect(keys).toContain('model_presence_penalty');
    expect(keys).toContain('model_frequency_penalty');
    expect(keys).toContain('model_repetition_penalty');
    
    // Stop sequences
    expect(keys).toContain('model_stop_sequences');
    
    // Behavior controls
    expect(keys).toContain('model_max_tool_calls');
    expect(keys).toContain('model_allow_parallel_tool_use');
    
    // Caching
    expect(keys).toContain('model_use_system_prompt_caching');
    expect(keys).toContain('model_use_response_caching');
    
    // Vision & documents
    expect(keys).toContain('model_image_input_quality');
    expect(keys).toContain('model_image_input_max_images');
    expect(keys).toContain('model_document_input_max_pages');
    
    // Advanced
    expect(keys).toContain('AIGENT_STREAM_TIMEOUT');
    expect(keys).toContain('AIGENT_MAX_REASONING_TOKENS');
    expect(keys).toContain('model_per_model_config');
  });
  
  it('validates temperature range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_temperature');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(0.0);
    expect(setting?.max).toBe(2.0);
    expect(setting?.step).toBe(0.1);
    expect(setting?.default).toBe(0.7);
  });
  
  it('validates top_p range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_top_p');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(0.0);
    expect(setting?.max).toBe(1.0);
    expect(setting?.step).toBe(0.01);
    expect(setting?.default).toBe(0.95);
  });
  
  it('validates top_k range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_top_k');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(0);
    expect(setting?.max).toBe(500);
    expect(setting?.step).toBe(1);
    expect(setting?.default).toBe(0);
  });
  
  it('validates presence_penalty range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_presence_penalty');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(-2.0);
    expect(setting?.max).toBe(2.0);
    expect(setting?.step).toBe(0.1);
    expect(setting?.default).toBe(0.0);
  });
  
  it('validates frequency_penalty range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_frequency_penalty');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(-2.0);
    expect(setting?.max).toBe(2.0);
    expect(setting?.step).toBe(0.1);
    expect(setting?.default).toBe(0.0);
  });
  
  it('validates repetition_penalty range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_repetition_penalty');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(0.5);
    expect(setting?.max).toBe(2.0);
    expect(setting?.step).toBe(0.05);
    expect(setting?.default).toBe(1.1);
  });
  
  it('validates model_max_tool_calls range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_max_tool_calls');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(0);
    expect(setting?.max).toBe(100);
    expect(setting?.step).toBe(1);
    expect(setting?.default).toBe(0);
  });
  
  it('validates model_image_input_max_images range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_image_input_max_images');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(0);
    expect(setting?.max).toBe(20);
    expect(setting?.step).toBe(1);
    expect(setting?.default).toBe(5);
  });
  
  it('validates model_document_input_max_pages range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_document_input_max_pages');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(0);
    expect(setting?.max).toBe(1000);
    expect(setting?.step).toBe(10);
    expect(setting?.default).toBe(20);
  });
  
  it('validates AIGENT_STREAM_TIMEOUT range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'AIGENT_STREAM_TIMEOUT');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(1000);
    expect(setting?.max).toBe(600000);
    expect(setting?.step).toBe(1000);
    expect(setting?.default).toBe(120000);
  });
  
  it('validates AIGENT_MAX_REASONING_TOKENS range', () => {
    const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'AIGENT_MAX_REASONING_TOKENS');
    expect(setting).toBeDefined();
    expect(setting?.min).toBe(100);
    expect(setting?.max).toBe(32768);
    expect(setting?.step).toBe(100);
    expect(setting?.default).toBe(8192);
  });
  
  it('has correct types for all settings', () => {
    const temperature = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_temperature');
    expect(temperature?.type).toBe('number');
    
    const topP = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_top_p');
    expect(topP?.type).toBe('number');
    
    const stopSeq = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_stop_sequences');
    expect(stopSeq?.type).toBe('text');
    
    const parallel = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_allow_parallel_tool_use');
    expect(parallel?.type).toBe('toggle');
    
    const imageQuality = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === 'model_image_input_quality');
    expect(imageQuality?.type).toBe('select');
  });
  
  it('has descriptions for all settings', () => {
    const keys = SETTINGS_SCHEMA.map((s: SettingDef) => s.key);
    for (const key of keys) {
      const setting = SETTINGS_SCHEMA.find((s: SettingDef) => s.key === key);
      expect(setting?.desc).toBeDefined();
      expect(setting?.desc).toBeTruthy();
    }
  });
});
