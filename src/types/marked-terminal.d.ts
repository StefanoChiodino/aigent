declare module 'marked-terminal' {
  import type { MarkedExtension } from 'marked';

  interface MarkedTerminalOptions {
    showSectionPrefix?: boolean;
    tab?: number;
    width?: number;
    reflowText?: boolean;
    unescape?: boolean;
    emoji?: boolean;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
}
