import React from 'react';
import type { CommandDef } from '../types';
import { COMMANDS } from '../lib/settings-schema';

interface CommandPaletteProps {
  text: string;
  hidden: boolean;
  selected: number;
  onSelect: (idx: number) => void;
  onComplete: (item: CommandDef) => void;
}

export function getCommandMatches(text: string): CommandDef[] {
  if (!text.startsWith('/')) return [];
  const spaceIdx = text.indexOf(' ');
  const prefix = spaceIdx > 0 ? text.slice(0, spaceIdx) : text;
  if (spaceIdx > 0 && COMMANDS.some(c => c.name === prefix)) return [];
  return COMMANDS.filter(c => c.name.startsWith(prefix.toLowerCase()));
}

export const CommandPalette = React.memo(function CommandPalette({
  text, hidden, selected, onSelect, onComplete,
}: CommandPaletteProps) {
  const items = getCommandMatches(text);
  const isHidden = hidden || items.length === 0;

  return (
    <div id="command-palette" className={isHidden ? 'hidden' : ''}>
      {items.map((item, i) => (
        <div
          key={item.name}
          className={`palette-item${i === selected ? ' selected' : ''}`}
          onMouseEnter={() => onSelect(i)}
          onClick={() => onComplete(item)}
        >
          <span>
            <span className="cmd-name">{item.name}</span>
            {item.argHint && <span className="cmd-args"> {item.argHint}</span>}
          </span>
          <span className="cmd-desc">{item.desc}</span>
        </div>
      ))}
    </div>
  );
});
