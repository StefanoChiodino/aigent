import { Box, Text } from 'ink';
import { TextInput } from './TextInput.js';

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
}

export function InputBar({ value, onChange, onSubmit, isLoading }: InputBarProps): React.JSX.Element {
  const handleSubmit = (input: string): void => {
    if (isLoading) return;
    onChange('');
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
          onChange={onChange}
          onSubmit={handleSubmit}
          placeholder="Type a message..."
        />
      )}
    </Box>
  );
}
