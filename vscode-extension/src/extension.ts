import * as vscode from 'vscode';
import * as path from 'path';
import { WebSocket } from 'ws';

let log: vscode.OutputChannel;
let extWs: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

/** Connect to the aigent gatekeeper /ext endpoint so the server knows VSCode is attached. */
async function connectExtBridge(baseUrl: string, statusBar: vscode.StatusBarItem) {
  if (extWs && extWs.readyState === WebSocket.OPEN) {
    log.appendLine('[ext-bridge] Already connected, skipping');
    return;
  }

  // Fetch the one-time secret
  let secret: string | null = null;
  try {
    log.appendLine(`[ext-bridge] Fetching secret from ${baseUrl}/ext/secret`);
    const res = await fetch(`${baseUrl}/ext/secret`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json() as { secret?: string };
      secret = data.secret ?? null;
      log.appendLine(`[ext-bridge] Got secret: ${secret ? 'yes' : 'no'}`);
    } else {
      log.appendLine(`[ext-bridge] Secret fetch failed: ${res.status} ${res.statusText}`);
    }
  } catch (err) {
    log.appendLine(`[ext-bridge] Secret fetch error (server not running?): ${err}`);
    statusBar.text = '$(x) aigent';
    statusBar.tooltip = 'Aigent — disconnected';
    scheduleReconnect(baseUrl, statusBar);
    return;
  }

  const wsUrl = secret
    ? `ws://localhost:${new URL(baseUrl).port}/ext?secret=${secret}`
    : `ws://localhost:${new URL(baseUrl).port}/ext`;

  log.appendLine(`[ext-bridge] Connecting WebSocket to ${wsUrl.replace(/secret=.*/, 'secret=***')}`);
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    extWs = ws;
    log.appendLine('[ext-bridge] WebSocket connected, sending vscode_hello');
    ws.send(JSON.stringify({ type: 'vscode_hello', version: '0.1.0' }));
    statusBar.text = '$(check) aigent';
    statusBar.backgroundColor = undefined;
    statusBar.tooltip = 'Aigent — connected';
    // Send current context immediately on connect
    sendVscodeContext();
  });

  ws.on('message', (data: Buffer) => {
    log.appendLine(`[ext-bridge] Received: ${data.toString().slice(0, 200)}`);
  });

  ws.on('close', (code, reason) => {
    log.appendLine(`[ext-bridge] WebSocket closed: code=${code} reason=${reason.toString()}`);
    extWs = null;
    statusBar.text = '$(x) aigent';
    statusBar.tooltip = 'Aigent — disconnected';
    scheduleReconnect(baseUrl, statusBar);
  });

  ws.on('error', (err) => {
    log.appendLine(`[ext-bridge] WebSocket error: ${err.message}`);
  });
}

function sendVscodeContext() {
  if (!extWs || extWs.readyState !== WebSocket.OPEN) return;

  const active = vscode.window.activeTextEditor;
  const visibleFiles = vscode.window.visibleTextEditors
    .map(e => e.document.uri.fsPath)
    .filter(p => p && !p.startsWith('extension-output'));

  const context: Record<string, unknown> = { visibleFiles };

  if (active) {
    context.activeFile = active.document.uri.fsPath;
    const sel = active.selection;
    context.selectionStartLine = sel.start.line + 1;
    context.selectionStartCol = sel.start.character + 1;
    context.selectionEndLine = sel.end.line + 1;
    context.selectionEndCol = sel.end.character + 1;
    if (!sel.isEmpty) {
      const text = active.document.getText(sel);
      // Cap selected text at 2000 chars to avoid bloating every message
      context.selectedText = text.length > 2000 ? text.slice(0, 2000) + '…' : text;
    }
  }

  extWs.send(JSON.stringify({ type: 'vscode_context', context }));
}

function scheduleReconnect(baseUrl: string, statusBar: vscode.StatusBarItem) {
  if (reconnectTimer) return;
  log.appendLine('[ext-bridge] Scheduling reconnect in 5s');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectExtBridge(baseUrl, statusBar);
  }, 5000);
}

export function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel('Aigent');
  log.appendLine('Aigent extension activating...');
  context.subscriptions.push(log);

  const port = vscode.workspace.getConfiguration('aigent').get('port', 3141);
  const baseUrl = `http://localhost:${port}`;
  log.appendLine(`Using baseUrl: ${baseUrl}`);

  // Status bar item
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'aigent.openChat';
  statusBar.text = '$(comment-discussion) aigent';
  statusBar.tooltip = 'Open Aigent';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Connect to the gatekeeper ext bridge (registers VSCode as connected)
  connectExtBridge(baseUrl, statusBar);
  context.subscriptions.push({ dispose: () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    extWs?.close();
  }});

  // Create the chat provider
  const chatProvider = new AigentChatProvider(context.extensionUri, baseUrl);

  // Register the chat view
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('aigent.chatView', chatProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // Track editor changes and send context to server
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => sendVscodeContext()),
    vscode.window.onDidChangeTextEditorSelection(() => sendVscodeContext()),
    vscode.window.onDidChangeVisibleTextEditors(() => sendVscodeContext()),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('aigent.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.aigent');
    }),

    vscode.commands.registerCommand('aigent.sendContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const text = editor.document.getText(selection);
      const filePath = editor.document.uri.fsPath;
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const relativePath = workspaceRoot ? path.relative(workspaceRoot, filePath) : filePath;

      chatProvider.sendUserMessage(`Context from ${relativePath}:\n\`\`\`\n${text}\n\`\`\``);
    })
  );

  log.appendLine('Aigent extension activated');
}

class AigentChatProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _baseUrl: string
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview();
  }

  public sendUserMessage(message: string) {
    this._view?.webview.postMessage({ type: 'inject_message', content: message });
  }

  private _getHtmlForWebview(): string {
    const baseUrl = this._baseUrl;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://localhost:* http://127.0.0.1:*; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title>Aigent</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100vh; overflow: hidden; background: #1e1e1e; }
    #frame { width: 100%; height: 100%; border: none; display: block; }
    #offline {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      color: #888;
      font-family: var(--vscode-font-family, sans-serif);
      gap: 12px;
    }
    #offline.visible { display: flex; }
    #retry-btn {
      padding: 6px 14px;
      background: #0e639c;
      color: #fff;
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <iframe id="frame" src="${baseUrl}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
  <div id="offline">
    <span>aigent is not running on ${baseUrl}</span>
    <button id="retry-btn" onclick="retry()">Retry</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const frame = document.getElementById('frame');
    const offline = document.getElementById('offline');

    frame.addEventListener('error', () => showOffline());

    function showOffline() {
      frame.style.display = 'none';
      offline.classList.add('visible');
    }

    function retry() {
      offline.classList.remove('visible');
      frame.style.display = 'block';
      frame.src = '${baseUrl}?' + Date.now();
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg && msg.type === 'inject_message') {
        frame.contentWindow?.postMessage({ type: 'inject_message', content: msg.content }, '*');
      }
    });
  </script>
</body>
</html>`;
  }
}

export function deactivate() {}
