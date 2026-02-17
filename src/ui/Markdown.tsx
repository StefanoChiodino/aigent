import { Text } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Configure marked with terminal renderer once
const terminalMarked = new Marked();
terminalMarked.use(
  markedTerminal({
    // No heading prefix characters
    showSectionPrefix: false,
    // Compact list style
    tab: 2,
  })
);

export function renderMarkdown(text: string): string {
  try {
    const rendered = terminalMarked.parse(text);
    if (typeof rendered !== 'string') return text;
    // marked-terminal adds a trailing newline; strip it
    return rendered.replace(/\n+$/, '');
  } catch {
    return text;
  }
}

interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps): React.JSX.Element {
  return <Text>{renderMarkdown(children)}</Text>;
}
