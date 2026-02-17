import { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from './TextInput.js';

interface InputBarProps {
  onSubmit: (value: string) => void;
  isLoading: boolean;
}

export function InputBar({ onSubmit, isLoading }: InputBarProps): React.JSX.Element {
  const [value, setValue] = useState('');

  const handleSubmit = (input: string): void => {
    if (isLoading) return;
    setValue('');
    onSubmit(input);
  };

  return (
    <Box borderStyle="single" borderColor={isLoading ? 'gray' : 'cyan'} paddingX={1}>
      <Text color={isLoading ? 'gray' : 'cyan'} bold>{'> '}</Text>
      {isLoading ? (
        <Text color="gray" dimColor>waiting for response...</Text>
      ) : (
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder="Type a message..."
        />
      )}
    </Box>
  );
}
