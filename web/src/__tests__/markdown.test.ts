/**
 * Markdown utilities — HTML escaping, markdown rendering, TTS stripping.
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, renderMarkdown, stripMarkdownForTTS } from '../lib/markdown';

describe('escapeHtml', () => {
  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert("xss")&lt;/script&gt;');
  });
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });
  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
  it('passes safe text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('renderMarkdown', () => {
  it('renders bold text', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });
  it('renders inline code', () => {
    expect(renderMarkdown('use `console.log`')).toContain('<code>console.log</code>');
  });
  it('renders code blocks with hljs classes', () => {
    const html = renderMarkdown('```js\nconsole.log("hi");\n```');
    expect(html).toContain('console');
    expect(html).toContain('log');
    expect(html).toContain('<pre>');
    expect(html).toContain('hljs');
  });
  it('syntax highlights code with language tag', () => {
    const html = renderMarkdown('```python\ndef hello():\n    pass\n```');
    expect(html).toContain('<span class="hljs-keyword">');
    expect(html).toContain('def');
  });
  it('auto-detects language for untagged code blocks', () => {
    const html = renderMarkdown('```\nfunction foo() { return 42; }\n```');
    expect(html).toContain('hljs');
  });
  it('renders copy button on code blocks', () => {
    const html = renderMarkdown('```js\nconst x = 1;\n```');
    expect(html).toContain('code-copy-btn');
    expect(html).toContain('Copy');
  });
  it('renders language label on code blocks', () => {
    const html = renderMarkdown('```typescript\nconst x: number = 1;\n```');
    expect(html).toContain('code-lang-label');
    expect(html).toContain('typescript');
  });
  it('does not render language label without language tag', () => {
    const html = renderMarkdown('```\nsome code\n```');
    expect(html).not.toContain('code-lang-label');
  });
  it('does not highlight @mentions inside highlighted code blocks', () => {
    const html = renderMarkdown('```python\n@decorator\ndef foo(): pass\n```');
    expect(html).not.toContain('class="at-mention"');
    expect(html).toContain('@decorator');
  });
  it('renders links', () => {
    const html = renderMarkdown('[click](https://example.com)');
    expect(html).toContain('<a');
    expect(html).toContain('https://example.com');
  });
  it('highlights @mentions outside code blocks', () => {
    const html = renderMarkdown('Hello @user check this');
    expect(html).toContain('class="at-mention"');
    expect(html).toContain('@user');
  });
  it('does not highlight @mentions inside inline code', () => {
    const html = renderMarkdown('Run `@test` command');
    const codeMatch = html.match(/<code>(.*?)<\/code>/);
    if (codeMatch) expect(codeMatch[1]).not.toContain('at-mention');
  });
  it('handles empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });
  it('renders GFM line breaks', () => {
    expect(renderMarkdown('line one\nline two')).toContain('<br');
  });
});

describe('stripMarkdownForTTS', () => {
  it('replaces code blocks with "code block"', () => {
    const result = stripMarkdownForTTS('```\nconst x = 1;\n```');
    expect(result).toContain('code block');
    expect(result).not.toContain('const x');
  });
  it('strips inline code backticks', () => {
    expect(stripMarkdownForTTS('use `console.log` for debugging')).toBe('use console.log for debugging');
  });
  it('strips header markers', () => {
    expect(stripMarkdownForTTS('## My Header')).toBe('My Header');
  });
  it('strips bold formatting', () => {
    expect(stripMarkdownForTTS('**bold text**')).toBe('bold text');
  });
  it('strips italic formatting', () => {
    expect(stripMarkdownForTTS('*italic text*')).toBe('italic text');
  });
  it('strips underscored emphasis', () => {
    expect(stripMarkdownForTTS('__double__')).toBe('double');
    expect(stripMarkdownForTTS('_single_')).toBe('single');
  });
  it('removes images', () => {
    expect(stripMarkdownForTTS('![alt](image.png)')).toBe('');
  });
  it('extracts link text, removes URL', () => {
    expect(stripMarkdownForTTS('[click here](https://example.com)')).toBe('click here');
  });
  it('collapses multiple newlines', () => {
    expect(stripMarkdownForTTS('a\n\n\n\nb')).toBe('a\n\nb');
  });
});
