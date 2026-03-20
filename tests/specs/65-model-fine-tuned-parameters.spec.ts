import { test, expect } from '@playwright/test';

test.describe('Model Fine-Tuned Parameters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });
  
  test('has all required settings in schema', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.map((s: any) => s.key);
    });
    
    expect(settings).toContain('model_temperature');
    expect(settings).toContain('model_top_p');
    expect(settings).toContain('model_top_k');
    expect(settings).toContain('model_presence_penalty');
    expect(settings).toContain('model_frequency_penalty');
    expect(settings).toContain('model_repetition_penalty');
    expect(settings).toContain('model_stop_sequences');
    expect(settings).toContain('model_max_tool_calls');
    expect(settings).toContain('model_allow_parallel_tool_use');
    expect(settings).toContain('model_use_system_prompt_caching');
    expect(settings).toContain('model_use_response_caching');
    expect(settings).toContain('model_image_input_quality');
    expect(settings).toContain('model_image_input_max_images');
    expect(settings).toContain('model_document_input_max_pages');
    expect(settings).toContain('AIGENT_STREAM_TIMEOUT');
    expect(settings).toContain('AIGENT_MAX_REASONING_TOKENS');
    expect(settings).toContain('model_per_model_config');
  });
  
  test('validates temperature range', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.find((s: any) => s.key === 'model_temperature');
    });
    
    expect(settings?.min).toBe(0.0);
    expect(settings?.max).toBe(2.0);
    expect(settings?.step).toBe(0.1);
    expect(settings?.default).toBe(0.7);
  });
  
  test('validates top_p range', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.find((s: any) => s.key === 'model_top_p');
    });
    
    expect(settings?.min).toBe(0.0);
    expect(settings?.max).toBe(1.0);
    expect(settings?.step).toBe(0.01);
    expect(settings?.default).toBe(0.95);
  });
  
  test('validates top_k range', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.find((s: any) => s.key === 'model_top_k');
    });
    
    expect(settings?.min).toBe(0);
    expect(settings?.max).toBe(500);
    expect(settings?.step).toBe(1);
    expect(settings?.default).toBe(0);
  });
  
  test('validates presence_penalty range', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.find((s: any) => s.key === 'model_presence_penalty');
    });
    
    expect(settings?.min).toBe(-2.0);
    expect(settings?.max).toBe(2.0);
    expect(settings?.step).toBe(0.1);
    expect(settings?.default).toBe(0.0);
  });
  
  test('validates frequency_penalty range', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.find((s: any) => s.key === 'model_frequency_penalty');
    });
    
    expect(settings?.min).toBe(-2.0);
    expect(settings?.max).toBe(2.0);
    expect(settings?.step).toBe(0.1);
    expect(settings?.default).toBe(0.0);
  });
  
  test('validates repetition_penalty range', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.find((s: any) => s.key === 'model_repetition_penalty');
    });
    
    expect(settings?.min).toBe(0.5);
    expect(settings?.max).toBe(2.0);
    expect(settings?.step).toBe(0.05);
    expect(settings?.default).toBe(1.1);
  });
  
  test('has descriptions for all settings', async ({ page }) => {
    const settings = await page.evaluate(() => {
      const schema = (window as any).SETTINGS_SCHEMA;
      return schema.map((s: any) => ({ key: s.key, hasDesc: !!s.desc }));
    });
    
    for (const setting of settings) {
      expect(setting.hasDesc).toBe(true);
    }
  });
});
