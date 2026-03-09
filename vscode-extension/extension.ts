/**
 * aigent VS Code Extension
 * 
 * Sends VS Code context to aigent agent via WebSocket at ws://localhost:3141/ext
 */

import * as vscode from 'vscode';
import * as net from 'net';

const AIGENT_HOST = 'localhost';
const AIGENT_PORT = 3141;
const AIGENT_PATH = '/ext';

let socket: net.Socket | null = null;
let connected = false;
let outputChannel: vscode.OutputChannel | null = null;
let statusBar: vscode.StatusBarItem;

function log(message: string): void {
  if (outputChannel) {
    outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
  console.log(`[aigent] ${message}`);
}

function updateStatusBar(): void {
  log(`updateStatusBar: connected=${connected}, socket.destroyed=${socket?.destroyed}`);
  if (connected) {
    statusBar.text = '✓ aigent';
    statusBar.tooltip = 'Connected to aigent agent';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBar.background');
    statusBar.show();
    log('Status bar → connected');
  } else {
    statusBar.text = '✗ aigent';
    statusBar.tooltip = 'Not connected to aigent agent';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    statusBar.show();
    log('Status bar → disconnected');
  }
}

function decodeChunkedEncoding(body: string): string {
  // Remove headers (everything up to first \r\n\r\n)
  const parts = body.split('\r\n\r\n');
  if (parts.length < 2) return '';
  let chunkedData = parts.slice(1).join('\r\n\r\n').trim();
  
  if (!chunkedData) return '';
  
  // Parse chunked encoding: "31\r\n{...}\r\n0\r\n\r\n"
  const chunks: string[] = [];
  let remaining = chunkedData;
  
  while (remaining) {
    const crlfIndex = remaining.indexOf('\r\n');
    if (crlfIndex === -1) break;
    
    const chunkSizeHex = remaining.substring(0, crlfIndex).trim();
    const chunkSize = parseInt(chunkSizeHex, 16);
    
    if (chunkSize === 0) break; // end of chunks
    
    remaining = remaining.substring(crlfIndex + 2); // skip "\r\n"
    
    if (remaining.length < chunkSize) {
      log(`Chunk decoding error: expected ${chunkSize} bytes but got ${remaining.length}`);
      break;
    }
    
    chunks.push(remaining.substring(0, chunkSize));
    remaining = remaining.substring(chunkSize);
    
    // Skip trailing "\r\n" if present
    if (remaining.startsWith('\r\n')) {
      remaining = remaining.substring(2);
    }
  }
  
  return chunks.join('');
}

async function fetchSecret(): Promise<string | null> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    const request = [
      `GET /ext/secret HTTP/1.1`,
      `Host: ${AIGENT_HOST}:${AIGENT_PORT}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n');

    let buffer = '';

    client.on('data', (data) => {
      buffer += data.toString();
      log(`Secret fetch raw response: ${buffer}`);
      if (buffer.includes('\r\n\r\n')) {
        const bodyMatch = buffer.match(/\r\n\r\n(.*)$/s);
        if (bodyMatch) {
          let bodyText = bodyMatch[1];
          log(`Secret fetch body (raw): ${bodyText}`);
          
          // Decode chunked transfer encoding if present
          if (bodyText.match(/^[0-9a-fA-F]+\r\n/)) {
            bodyText = decodeChunkedEncoding(buffer);
            log(`Secret fetch body (decoded): ${bodyText}`);
          }
          
          try {
            const body = JSON.parse(bodyText);
            client.destroy();
            log(`Secret fetched: ${body.secret ? 'yes' : 'no'}`);
            resolve(body.secret ?? null);
            return;
          } catch (e) {
            log(`Secret fetch JSON parse error: ${e}`);
          }
        }
        client.destroy();
        resolve(null);
      }
    });

    client.on('error', () => {
      resolve(null);
    });

    client.on('timeout', () => {
      client.destroy();
      resolve(null);
    });

    client.setTimeout(5000);
    client.connect(AIGENT_PORT, AIGENT_HOST, () => {
      client.write(request);
    });
  });
}

function connect(): Promise<net.Socket> {
  return new Promise(async (resolve, reject) => {
    if (socket && connected) {
      resolve(socket);
      return;
    }

    // Fetch auth secret first (like Chrome extension does)
    const secret = await fetchSecret();
    log(`Connect: secret=${secret ? 'present' : 'missing'}`);
    const wsPath = secret ? `${AIGENT_PATH}?secret=${encodeURIComponent(secret)}` : AIGENT_PATH;
    log(`Connect: wsPath=${wsPath}`);

    socket = new net.Socket();
    socket.connect(AIGENT_PORT, AIGENT_HOST, () => {
      // Send HTTP Upgrade request for WebSocket
      const request = [
        `GET ${wsPath} HTTP/1.1`,
        `Host: ${AIGENT_HOST}:${AIGENT_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        ''
      ].join('\r\n');

      socket!.write(request);

      // Wait for upgrade response
      let buffer = '';
      const onData = (data: Buffer) => {
        buffer += data.toString();
        if (buffer.includes('\r\n\r\n')) {
          socket!.off('data', onData);
          if (buffer.includes('101 Switching Protocols')) {
            log('WebSocket upgrade successful');
            // Now send the VS Code hello message (WebSocket upgrade complete)
            const hello = JSON.stringify({ type: 'vscode_hello', version: '1.0.0' });
            const len = Buffer.byteLength(hello);
            const frame = Buffer.alloc(2 + len);
            frame[0] = 0x81; // text frame
            frame[1] = len;
            frame.write(hello, 2);
            
            // Wait a moment for server to process hello before resolving
            setTimeout(() => {
              log('Sent hello, setting connected=true');
              connected = true;
              updateStatusBar();
              resolve(socket!);
            }, 100);
            return;
          } else {
            const statusMatch = buffer.match(/HTTP\/1\.1 (\d+)/);
            const status = statusMatch ? statusMatch[1] : 'unknown';
            reject(new Error(`WebSocket upgrade failed (HTTP ${status})`));
          }
        }
      };
      socket!.on('data', onData);
    });

    socket.on('error', (err) => {
      log(`Socket error: ${err.message} - connected=${connected}`);
      // Check if socket is actually still connected
      if (socket && !socket.destroyed) {
        log('Socket still alive, not updating status');
        return;
      }
      log('Socket destroyed, updating status to disconnected');
      connected = false;
      updateStatusBar();
      reject(err);
    });

    // Track whether we initiated a close vs an unexpected disconnect
    let wasJustConnected = false;
    socket.on('close', (code) => {
      log('Socket closed (code ' + code + ') - connected=' + connected + ' - socket.destroyed=' + (socket?.destroyed));
      // Only set disconnected if socket is actually destroyed
      if (socket && socket.destroyed === true && connected) {
        log('Socket destroyed while marked connected - updating status');
        connected = false;
        updateStatusBar();
      }
    });
  });
}

function sendMessage(data: object): void {
  if (!socket || !connected) {
    vscode.window.showWarningMessage('aigent: Not connected. Make sure aigent is running.');
    return;
  }

  // Simple WebSocket frame: opcode 0x81 (text), length + payload
  const json = JSON.stringify(data);
  const length = Buffer.byteLength(json);
  
  let frame: Buffer;
  if (length <= 125) {
    frame = Buffer.alloc(2 + length);
    frame[0] = 0x81; // text frame
    frame[1] = length;
  } else if (length <= 65535) {
    frame = Buffer.alloc(4 + length);
    frame[0] = 0x81;
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame = Buffer.alloc(10 + length);
    frame[0] = 0x81;
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  
  frame.write(json, frame[1] === 126 ? 4 : frame[1] === 127 ? 10 : 2);
  socket.write(frame);
}

interface VSCodeContext {
  type: 'vscode_context';
  event: 'selection' | 'file' | 'terminal' | 'open_tabs';
  filePath?: string;
  content?: string;
  selection?: { startLine: number; endLine: number; text: string };
  terminalText?: string;
  tabs?: Array<{ path: string; name: string }>;
}

async function getSelection(): Promise<VSCodeContext> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor');
    throw new Error('No active editor');
  }

  const doc = editor.document;
  const selection = editor.selection;
  const text = selection.isEmpty 
    ? doc.getText() 
    : doc.getText(selection);

  return {
    type: 'vscode_context',
    event: 'selection',
    filePath: doc.fileName,
    content: doc.getText(),
    selection: {
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      text
    }
  };
}

async function getActiveFile(): Promise<VSCodeContext> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor');
    throw new Error('No active editor');
  }

  const doc = editor.document;

  return {
    type: 'vscode_context',
    event: 'file',
    filePath: doc.fileName,
    content: doc.getText()
  };
}

async function getTerminal(): Promise<VSCodeContext> {
  const terminal = vscode.window.terminals.find(t => t.name.includes('terminal') || t.name.includes('bash') || t.name.includes('zsh'));
  
  if (!terminal) {
    vscode.window.showWarningMessage('No terminal found');
    throw new Error('No terminal');
  }

  // Note: VS Code API doesn't provide terminal output history
  // This sends basic terminal info
  return {
    type: 'vscode_context',
    event: 'terminal',
    terminalText: `Terminal: ${terminal.name}`
  };
}

async function getOpenTabs(): Promise<VSCodeContext> {
  const tabs = vscode.window.tabGroups.all.flatMap(group => 
    group.tabs.map(tab => ({
      path: (tab.input as any)?.uri?.fsPath ?? '',
      name: tab.label
    })).filter(t => t.path)
  );

  return {
    type: 'vscode_context',
    event: 'open_tabs',
    tabs
  };
}

export function activate(context: vscode.ExtensionContext) {
  // Create output channel (shows up in Output > Aigent dropdown)
  outputChannel = vscode.window.createOutputChannel('Aigent', 'json');
  outputChannel.show(true);
  context.subscriptions.push(outputChannel);

  // Create status bar item
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  statusBar.name = 'Aigent Connection';
  statusBar.command = 'aigent.status';
  context.subscriptions.push(statusBar);
  updateStatusBar();
  log('Status bar item created');
  
  // Register command to show connection status
  context.subscriptions.push(
    vscode.commands.registerCommand('aigent.status', () => {
      log(`Status clicked: connected=${connected}`);
      vscode.window.showInformationMessage(`aigent: ${connected ? 'Connected ✓' : 'Disconnected ✗'}`);
    })
  );

  log('Extension activated');

  // Connect to aigent on startup
  log('Starting initial connection...');
  connect().then(() => {
    log('Connected to aigent agent successfully');
    vscode.window.showInformationMessage('aigent: Connected');
    updateStatusBar();
  }).catch((err) => {
    log(`Initial connection failed: ${err.message}`);
    updateStatusBar();
    // Silent fail - will reconnect on first action
  });

  // Send selection command
  context.subscriptions.push(
    vscode.commands.registerCommand('aigent.sendSelection', async () => {
      try {
        await connect();
        updateStatusBar();
        const ctx = await getSelection();
        sendMessage(ctx);
        vscode.window.showInformationMessage(`aigent: Sent selection (lines ${ctx.selection?.startLine}-${ctx.selection?.endLine})`);
      } catch (err) {
        vscode.window.showErrorMessage(`aigent: ${err}`);
      }
    })
  );

  // Send active file command
  context.subscriptions.push(
    vscode.commands.registerCommand('aigent.sendFile', async () => {
      try {
        await connect();
        updateStatusBar();
        const ctx = await getActiveFile();
        sendMessage(ctx);
        vscode.window.showInformationMessage(`aigent: Sent ${ctx.filePath}`);
      } catch (err) {
        vscode.window.showErrorMessage(`aigent: ${err}`);
      }
    })
  );

  // Auto-send context on selection change
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(async (e) => {
      // Optional: auto-send selection changes
      // For now, manual trigger only to avoid spam
    })
  );
}

export function deactivate() {
  if (socket) {
    socket.end();
  }
}