/**
 * Markdown utilities — HTML escaping, markdown rendering,
 * TTS stripping, speak tag extraction/stripping.
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, renderMarkdown, stripMarkdownForTTS, extractSpeakContent, stripSpeakTag } from '../lib/markdown';

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
  it('renders code blocks with language class', () => {
    const html = renderMarkdown('```js\nconsole.log("hi");\n```');
    expect(html).toContain('console.log');
    expect(html).toContain('<pre>');
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
  it('strips <speak> tags but keeps content inside', () => {
    expect(stripMarkdownForTTS('<speak>Hello world</speak>')).toBe('Hello world');
  });
  it('strips speak tags from mixed content', () => {
    expect(stripMarkdownForTTS('<speak>Summary.</speak>\n\nFull details here.')).toBe('Summary.\n\nFull details here.');
  });
  it('does not leave the literal word "speak" from tags', () => {
    const result = stripMarkdownForTTS('<speak>Quick answer</speak>\n\nLong answer.');
    expect(result).not.toMatch(/\bspeak\b/i);
  });
});

describe('extractSpeakContent', () => {
  it('extracts content between speak tags', () => {
    expect(extractSpeakContent('<speak>Hello world</speak>')).toBe('Hello world');
  });
  it('extracts from multi-line text', () => {
    expect(extractSpeakContent('<speak>Summary.</speak>\n\nMore.')).toBe('Summary.');
  });
  it('returns null when no speak tag', () => {
    expect(extractSpeakContent('No speak tag')).toBeNull();
  });
  it('trims whitespace', () => {
    expect(extractSpeakContent('<speak>  trimmed  </speak>')).toBe('trimmed');
  });
});

describe('stripSpeakTag', () => {
  it('removes speak tags and trims end', () => {
    // stripSpeakTag uses trimEnd(), so leading newlines from removal are preserved
    const result = stripSpeakTag('<speak>Summary.</speak>\n\nDetails here.');
    expect(result.trim()).toBe('Details here.');
  });
  it('returns speak content when entire text is in speak tags', () => {
    expect(stripSpeakTag('<speak>Only spoken text</speak>')).toBe('Only spoken text');
  });
  it('returns text unchanged when no speak tags', () => {
    expect(stripSpeakTag('Regular text')).toBe('Regular text');
  });
  it('removes multiple speak tags', () => {
    const result = stripSpeakTag('<speak>One.</speak> Middle <speak>Two.</speak>');
    expect(result.trim()).toBe('Middle');
  });
});
