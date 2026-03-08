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

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (socket && connected) {
      resolve(socket);
      return;
    }

    socket = new net.Socket();
    socket.connect(AIGENT_PORT, AIGENT_HOST, () => {
      // Send HTTP Upgrade request for WebSocket
      const request = [
        `GET ${AIGENT_PATH} HTTP/1.1`,
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
      socket!.on('data', (data) => {
        buffer += data.toString();
        if (buffer.includes('\r\n\r\n')) {
          if (buffer.includes('101 Switching Protocols')) {
            connected = true;
            resolve(socket!);
          } else {
            reject(new Error('WebSocket upgrade failed'));
          }
        }
      });
    });

    socket.on('error', (err) => {
      connected = false;
      reject(err);
    });

    socket.on('close', () => {
      connected = false;
    });

    // Send VS Code hello to identify this client after connection
    const hello = JSON.stringify({ type: 'vscode_hello', version: '1.0.0' });
    const len = Buffer.byteLength(hello);
    const frame = Buffer.alloc(2 + len);
    frame[0] = 0x81;
    frame[1] = len;
    frame.write(hello, 2);
    socket.write(frame);
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
  // Connect to aigent on startup
  connect().then(() => {
    vscode.window.showInformationMessage('aigent: Connected');
  }).catch(() => {
    // Silent fail - will reconnect on first action
  });

  // Send selection command
  context.subscriptions.push(
    vscode.commands.registerCommand('aigent.sendSelection', async () => {
      try {
        await connect();
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