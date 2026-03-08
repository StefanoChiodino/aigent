import * as vscode from 'vscode';
import * as path from 'path';
import { WebSocket } from 'ws';

// Import protocol types from your existing codebase
interface ExtResponse {
  type: 'ext_response';
  id: string;
  ok: boolean;
  treeText?: string;
  dataUrl?: string;
  tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[];
  stepsCompleted?: number;
  totalSteps?: number;
  finalUrl?: string;
  finalTitle?: string;
  newTabId?: number;
  screenshots?: Array<{ stepIndex: number; dataUrl: string }>;
  devtools?: {
    network: Array<{ id: string; url: string; method: string; status?: number; mimeType?: string; size?: number; error?: string; timestamp: number }>;
    console: Array<{ type: string; text: string; url?: string; line?: number; timestamp: number }>;
    exceptions: Array<{ text: string; url?: string; line?: number; stack?: string; timestamp: number }>;
    performance?: { metrics: Record<string, number> };
  };
  error?: string;
}

type ExtMessage = 
  | { type: 'ext_hello'; version: string; browser: string }
  | ExtResponse
  | { type: 'ext_tab_changed'; tabId: number; url: string; title: string };

export function activate(context: vscode.ExtensionContext) {
  console.log('Aigent extension activating...');
  
  // Create the chat provider
  const chatProvider = new AigentChatProvider(context.extensionUri);
  
  // Register the chat view
  vscode.window.registerWebviewViewProvider('aigent.chatView', chatProvider);
  
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
    }),
    
    vscode.commands.registerCommand('aigent.runInTerminal', async () => {
      const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Aigent');
      terminal.show();
      
      // The agent can send terminal commands via the normal message flow
      vscode.window.showInformationMessage('Use the chat to send terminal commands to aigent');
    })
  );
  
  console.log('Aigent extension activated successfully');
}

class AigentChatProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _ws: WebSocket | null = null;
  private _connected = false;
  private _messageQueue: Array<{type: string, [key: string]: any}> = [];
  private _pendingRequests = new Map<string, {
    resolve: (response: ExtResponse) => void;
    reject: (error: Error) => void;
  }>();
  private _requestId = 0;
  private _gatekeeperUrl: string;
  private _autoConnect: boolean;
  
  constructor(private readonly _extensionUri: vscode.Uri) {
    this._gatekeeperUrl = vscode.workspace.getConfiguration('aigent').get('gatekeeperUrl', 'ws://localhost:3141/ext');
    this._autoConnect = vscode.workspace.getConfiguration('aigent').get('autoConnect', true);
    
    if (this._autoConnect) {
      this._connect();
    }
  }
  
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'user_message':
          await this._handleUserMessage(data.content);
          break;
        case 'connect':
          this._connect();
          break;
        case 'requestAction':
          this._handleActionRequest(data.action, data.params);
          break;
      }
    });
    
    this._updateConnectionStatus();
  }
  
  public sendUserMessage(message: string) {
    if (this._view) {
      this._view.webview.postMessage({ type: 'addUserMessage', content: message });
    }
    this._handleUserMessage(message);
  }
  
  private _connect() {
    if (this._ws?.readyState === WebSocket.OPEN) {
      return;
    }
    
    console.log(`Connecting to aigent at ${this._gatekeeperUrl}`);
    
    this._ws = new WebSocket(this._gatekeeperUrl);
    
    this._ws.on('open', () => {
      console.log('Connected to aigent gatekeeper');
      this._connected = true;
      this._updateConnectionStatus();
      
      // Send queued messages
      while (this._messageQueue.length > 0) {
        const msg = this._messageQueue.shift();        if (msg && this._ws) {
          this._ws.send(JSON.stringify(msg));
        }
      }
    });
    
    this._ws.on('message', (data: Buffer) => {
      this._handleMessage(data.toString());
    });
    
    this._ws.on('close', () => {
      console.log('Disconnected from aigent gatekeeper');
      this._connected = false;
      this._updateConnectionStatus();
      
      // Attempt to reconnect after 3 seconds
      setTimeout(() => {
        if (this._autoConnect) {
          this._connect();
        }
      }, 3000);
    });
    
    this._ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      this._connected = false;
      this._updateConnectionStatus();
    });
  }
  
  private _handleMessage(data: string) {
    try {
      const message = JSON.parse(data) as any;
      
      if (message.type === 'ext_response') {
        const pending = this._pendingRequests.get(message.id);
        if (pending) {
          pending.resolve(message);
          this._pendingRequests.delete(message.id);
        }
      } else if (message.type === 'ext_hello') {
        console.log('Extension hello from aigent:', message.version);
      } else if (message.type === 'ext_tab_changed') {
        // Track active tab changes from browser
        console.log('Active tab changed:', message.url);
      } else {
        // Forward other messages to the webview
        this._view?.webview.postMessage(message);
      }
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  }
  
  private async _handleUserMessage(content: string) {
    const message = {
      type: 'message' as const,
      content,
      reqId: `vscode_${++this._requestId}`
    };
    
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify(message));
    } else {
      this._messageQueue.push(message);
    }
  }
  
  private async _handleActionRequest(action: string, params: any) {
    // Handle special IDE actions here
    switch (action) {
      case 'readFile':
        try {
          const uri = vscode.Uri.file(params.path);
          const content = await vscode.workspace.fs.readFile(uri);
          return { ok: true, content: content.toString() };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      
      case 'writeFile':
        try {
          const uri = vscode.Uri.file(params.path);
          await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content));
          return { ok: true };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      
      case 'listWorkspace':
        try {
          if (!vscode.workspace.workspaceFolders?.[0]) {
            return { ok: false, error: 'No workspace folder open' };
          }
          
          const root = vscode.workspace.workspaceFolders[0].uri;
          const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**');
          const relativePaths = files.map(f => path.relative(root.fsPath, f.fsPath));
          
          return { ok: true, files: relativePaths };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      
      case 'getDiagnostics':
        try {
          const diagnostics = vscode.languages.getDiagnostics();
          const diagnosticInfo = diagnostics.map(([uri, diags]) => ({
            file: uri.fsPath,
            diagnostics: diags.map(d => ({
              message: d.message,
              severity: d.severity,
              line: d.range.start.line,
              character: d.range.start.character,
              source: d.source
            }))
          }));
          
          return { ok: true, diagnostics: diagnosticInfo };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      
      case 'runTerminalCommand':
        try {
          const terminal = vscode.window.activeTerminal || vscode.window.createTerminal('Aigent');
          terminal.show();
          terminal.sendText(params.command);
          
          return { ok: true, terminal: terminal.name };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
    }
  }
  
  private _updateConnectionStatus() {
    this._view?.webview.postMessage({
      type: 'connectionStatus',
      connected: this._connected
    });
  }
  
  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Aigent Chat</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
          }
          .header {
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-widget-border);
            display: flex;
            align-items: center;
            gap: 8px;
          }
          .connection-status {
            display: flex;
            align-items: center;
            gap: 4px;
          }
          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--vscode-errorForeground);
          }
          .dot.connected {
            background: var(--vscode-charts-green);
          }
          .chat-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
          }
          .messages {
            flex: 1;
            overflow-y: auto;
            padding: 12px;
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .message {
            padding: 8px 12px;
            border-radius: 4px;
            max-width: 100%;
            word-wrap: break-word;
          }
          .user-message {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            align-self: flex-end;
          }
          .assistant-message {
            background: var(--vscode-editor-inactiveBackground);
            color: var(--vscode-foreground);
            align-self: flex-start;
          }
          .system-message {
            background: var(--vscode-editor-hoverHighlight);
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            align-self: center;
          }
          .input-area {
            padding: 12px;
            border-top: 1px solid var(--vscode-widget-border);
            display: flex;
            gap: 8px;
          }
          .input {
            flex: 1;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border);
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px;
          }
          .send-btn {
            padding: 6px 12px;
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
          }
          .send-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .code-block {
            background: var(--vscode-editor-background);
            border: 1px solid var(--vscode-widget-border);
            border-radius: 3px;
            padding: 8px;
            margin: 4px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
          }
          .tool-trace {
            background: var(--vscode-editor-hoverHighlight);
            border: 1px solid var(--vscode-focusBorder);
            border-radius: 3px;
            padding: 8px;
            margin: 4px 0;
            font-size: 0.9em;
          }
          .tool-status {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-bottom: 4px;
          }
          .spinner {
            width: 12px;
            height: 12px;
            border: 2px solid var(--vscode-foreground);
            border-top-color: transparent;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="connection-status">
            <div class="dot" id="connection-dot"></div>
            <span id="connection-label">Not connected</span>
          </div>
        </div>
        
        <div class="chat-container">
          <div class="messages" id="messages"></div>
          
          <div class="input-area">
            <input 
              type="text" 
              class="input" 
              id="message-input"
              placeholder="Type a message..."
              onkeydown="handleKeydown(event)"
            />
            <button class="send-btn" id="send-btn" onclick="sendMessage()">Send</button>
          </div>
        </div>
        
        <script>
          const vscode = acquireVsCodeApi();
          const messages = document.getElementById('messages');
          const input = document.getElementById('message-input');
          const sendBtn = document.getElementById('send-btn');
          const connectionDot = document.getElementById('connection-dot');
          const connectionLabel = document.getElementById('connection-label');
          
          function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
          }
          
          function addMessage(content, role) {
            const msg = document.createElement('div');
            msg.className = 'message ' + role + '-message';
            
            // Parse markdown-like content
            let html = escapeHtml(content);
            
            // Code blocks
            html = html.replace(/\n\`\`\`(\w+)?\n([\s\S]*?)\n\`\`\`/g, 
              (match, lang, code) => '<div class="code-block">' + escapeHtml(code) + '</div>');
            
            // Simple bold
            html = html.replace(/\*(.*?)\*/g, '<strong>$1</strong>');
            
            // Newlines
            html = html.replace(/\n/g, '<br>');
            
            msg.innerHTML = html;
            messages.appendChild(msg);
            messages.scrollTop = messages.scrollHeight;
          }
          
          function sendMessage() {
            const content = input.value.trim();
            if (!content) return;
            
            addMessage(content, 'user');
            vscode.postMessage({ type: 'user_message', content });
            
            input.value = '';
            sendBtn.disabled = true;
            
            setTimeout(() => sendBtn.disabled = false, 100);
          }
          
          function handleKeydown(event) {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              sendMessage();
            }
          }
          
          function updateConnectionStatus(connected) {
            connectionDot.className = 'dot' + (connected ? ' connected' : '');
            connectionLabel.textContent = connected ? 'Connected to aigent' : 'Not connected';
          }
          
          // Message handling
          window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
              case 'text':
                addMessage(message.content, 'assistant');
                break;
              case 'system':
                addMessage(message.content, 'system');
                break;
              case 'connectionStatus':
                updateConnectionStatus(message.connected);
                break;
              case 'tool_start':
                // Show tool execution indicator
                const traceDiv = document.createElement('div');
                traceDiv.className = 'tool-trace';
                traceDiv.id = 'trace-' + message.id;
                traceDiv.innerHTML = '<div class="tool-status"><div class="spinner"></div><span>' + 
                  escapeHtml(message.name) + ': ' + escapeHtml(message.summary) + '</span></div>';
                messages.appendChild(traceDiv);
                messages.scrollTop = messages.scrollHeight;
                break;
              case 'tool_end':
                // Hide tool execution indicator
                const trace = document.getElementById('trace-' + message.id);
                if (trace) trace.style.opacity = '0.5';
                break;
              case 'error':
                addMessage('Error: ' + message.content, 'system');
                break;
            }
          });
          
          updateConnectionStatus(false);
        </script>
      </body>
      </html>`;
  }
}

export function deactivate() {}