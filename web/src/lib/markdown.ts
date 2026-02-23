import { marked } from 'marked';

marked.setOptions({ breaks: true, gfm: true });

export function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

export function renderMarkdown(text: string): string {
  try {
    const result = marked.parse(text);
    return (typeof result === 'string' ? result : '').trim();
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
