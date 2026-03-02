import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/common';

const marked = new Marked(
  { breaks: true, gfm: true },
  markedHighlight({
    emptyLangClass: 'hljs',
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value;
      }
      return hljs.highlightAuto(code).value;
    },
  }),
);

// Custom renderer: language label + copy-to-clipboard button on code blocks
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const langClass = lang ? `hljs language-${lang}` : 'hljs';
      const langLabel = lang
        ? `<span class="code-lang-label">${lang}</span>`
        : '';
      const copyBtn =
        '<button class="code-copy-btn" onclick="' +
        "(function(b){var c=b.closest('pre').querySelector('code');" +
        "navigator.clipboard.writeText(c.textContent||'');" +
        "b.textContent='Copied!';b.classList.add('copied');" +
        "setTimeout(function(){b.textContent='Copy';b.classList.remove('copied')},1500)" +
        '})(this)" type="button">Copy</button>';
      return `<pre>${langLabel}${copyBtn}<code class="${langClass}">${text}</code></pre>\n`;
    },
  },
});

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
