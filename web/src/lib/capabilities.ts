/** Human-readable info for host capabilities and grant levels. */

export interface CapInfo {
  label: string;
  description: string;
}

export const CAP_INFO: Record<string, CapInfo> = {
  'clipboard.read':  { label: 'Clipboard Read',  description: 'Read from system clipboard' },
  'clipboard.write': { label: 'Clipboard Write', description: 'Write to system clipboard' },
  'screen.capture':  { label: 'Screenshot',      description: 'Take a screenshot' },
  'screen.list':     { label: 'Screen List',      description: 'List windows and screens' },
  'audio.play':      { label: 'Audio Play',       description: 'Play audio via host daemon' },
  'audio.record':    { label: 'Audio Record',     description: 'Record audio via host daemon' },
  'notify':          { label: 'Notify',           description: 'Send OS notifications' },
  'open':            { label: 'Open',             description: 'Open URLs/files in default app' },
  'fs.read':         { label: 'FS Read',          description: 'Read host filesystem' },
  'fs.write':        { label: 'FS Write',         description: 'Write host filesystem' },
};

export const GRANT_DESCRIPTIONS: Record<string, string> = {
  'allow':   'Always allowed',
  'session': 'Allowed for this session',
  'prompt':  'Will ask for permission when used',
  'timed':   'Allowed temporarily',
  'deny':    'Blocked',
};
