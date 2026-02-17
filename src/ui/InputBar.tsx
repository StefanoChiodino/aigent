import { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from './TextInput.js';

const SLASH_COMMANDS = [
  '/help',
  '/refresh',
  '/reset',
  '/reasoning on',
  '/reasoning off',
  '/effort low',
  '/effort medium',
  '/effort high',
  '/effort max',
  '/profiles',
  '/profile ',
  '/profile create ',
  '/save',
  '/sessions',
  '/load ',
];

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
}

export function InputBar({ value, onChange, onSubmit, isLoading }: InputBarProps): React.JSX.Element {
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const handleSubmit = (input: string): void => {
    setSuggestions([]);
    onChange('');
    onSubmit(input);
  };

  const handleChange = useCallback((newValue: string) => {
    // Clear suggestions when user types
    if (suggestions.length > 0) {
      setSuggestions([]);
    }
    onChange(newValue);
  }, [onChange, suggestions.length]);

  const handleTab = useCallback((currentValue: string): string | null => {
    if (!currentValue.startsWith('/')) return null;

    const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(currentValue) && cmd !== currentValue);

    if (matches.length === 0) {
      setSuggestions([]);
      return null;
    }

    if (matches.length === 1) {
      setSuggestions([]);
      return matches[0]!;
    }

    // Multiple matches — find common prefix and show suggestions
    setSuggestions(matches);
    const prefix = commonPrefix(matches);
    return prefix.length > currentValue.length ? prefix : null;
  }, []);

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box paddingX={2}>
          <Text color="gray">
            {suggestions.map((s) => s.trimEnd()).join('  ')}
          </Text>
        </Box>
      )}
      <Box borderStyle="single" borderColor={isLoading ? 'gray' : 'cyan'} paddingX={1}>
        <Box flexGrow={1}>
          <Text color={isLoading ? 'gray' : 'cyan'} bold>{'> '}</Text>
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            onTab={handleTab}
            placeholder={isLoading ? 'Type to queue a message...' : 'Type a message...'}
          />
        </Box>
      </Box>
    </Box>
  );
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0]!;
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i]!;
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}
