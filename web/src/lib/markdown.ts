import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

export function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/** Wrap @mention tokens outside of code blocks/spans with a chip span. */
function highlightAtMentions(html: string): string {
  // Split on code blocks to avoid touching code content
  const parts = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g);
  return parts.map((part, i) => {
    // Odd-indexed parts are code blocks — leave them alone
    if (i % 2 === 1) return part;
    return part.replace(
      /(@[\w./\-]+)/g,
      '<span class="at-mention">$1</span>',
    );
  }).join('');
}

export function renderMarkdown(text: string): string {
  try {
    const result = marked.parse(text);
    const html = (typeof result === 'string' ? result : '').trim();
    return highlightAtMentions(html);
  } catch {
    return escapeHtml(text);
  }
}

export function stripMarkdownForTTS(text: string): string {
  text = text.replace(/```[\s\S]*?```/g, ' code block. ');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/^#+\s+/gm, '');
  text = text.replace(/^[-*_]{3,}$/gm, '');
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/___(.+?)___/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/_(.+?)_/g, '$1');
  text = text.replace(/!\[.*?\]\([^)]+\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function extractSpeakContent(text: string): string | null {
  const m = text.match(/<speak>([\s\S]*?)<\/speak>/);
  return m ? m[1]!.trim() : null;
}

export function stripSpeakTag(text: string): string {
  return text.replace(/<speak>[\s\S]*?<\/speak>/g, '').trimEnd();
}
