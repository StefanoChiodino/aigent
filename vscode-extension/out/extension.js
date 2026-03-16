"use strict";
/**
 * aigent VS Code Extension
 *
 * Sends VS Code context to aigent agent via Unix domain socket
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const net = __importStar(require("net"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// Use Unix domain socket for local connections
const AIGENT_SOCKET_PATH = process.env['AIGENT_SOCKET_PATH'] || path.join(os.tmpdir(), 'aigent', 'worker.sock');
let socket = null;
let connected = false;
let outputChannel = null;
let statusBar;
function log(message) {
    if (outputChannel) {
        outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
    }
    console.log(`[aigent] ${message}`);
}
function updateStatusBar() {
    log(`updateStatusBar: connected=${connected}, socket.destroyed=${socket?.destroyed}`);
    if (connected) {
        statusBar.text = '✓ aigent';
        statusBar.tooltip = 'Connected to aigent agent';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBar.background');
        statusBar.show();
        log('Status bar → connected');
    }
    else {
        statusBar.text = '✗ aigent';
        statusBar.tooltip = 'Not connected to aigent agent';
        statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBar.show();
        log('Status bar → disconnected');
    }
}
function connect() {
    return new Promise(async (resolve, reject) => {
        if (socket && connected) {
            resolve(socket);
            return;
        }
        socket = new net.Socket();
        socket.connect(AIGENT_SOCKET_PATH, () => {
            log('Connected to Unix socket');
            // Send VS Code hello message (newline-delimited JSON)
            const hello = JSON.stringify({ type: 'vscode_hello', version: '1.0.0' }) + '\n';
            socket.write(hello);
            // Wait a moment for server to process hello before resolving
            setTimeout(() => {
                log('Sent hello, setting connected=true');
                connected = true;
                updateStatusBar();
                resolve(socket);
            }, 100);
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
function sendMessage(data) {
    if (!socket || !connected) {
        vscode.window.showWarningMessage('aigent: Not connected. Make sure aigent is running.');
        return;
    }
    // Newline-delimited JSON (NDJSON) protocol
    const json = JSON.stringify(data) + '\n';
    socket.write(json);
}
async function getSelection() {
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
async function getActiveFile() {
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
async function getTerminal() {
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
async function getOpenTabs() {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({
        path: tab.input?.uri?.fsPath ?? '',
        name: tab.label
    })).filter(t => t.path));
    return {
        type: 'vscode_context',
        event: 'open_tabs',
        tabs
    };
}
function activate(context) {
    // Create output channel (shows up in Output > Aigent dropdown)
    outputChannel = vscode.window.createOutputChannel('Aigent', 'json');
    // Don't auto-show the output panel - user can open it manually if needed
    // outputChannel.show(true);
    context.subscriptions.push(outputChannel);
    // Create status bar item
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
    statusBar.name = 'Aigent Connection';
    statusBar.command = 'aigent.status';
    context.subscriptions.push(statusBar);
    updateStatusBar();
    log('Status bar item created');
    // Register command to show connection status (simple message, no popup)
    context.subscriptions.push(vscode.commands.registerCommand('aigent.status', () => {
        log(`Status clicked: connected=${connected}`);
        if (connected) {
            // Silent - status bar shows connection state
            // vscode.window.showInformationMessage('aigent: Connected ✓');
        }
        else {
            // Silent - status bar shows connection state
            // vscode.window.showInformationMessage('aigent: Not connected - check if aigent server is running');
        }
    }));
    log('Extension activated');
    // Connect to aigent on startup
    log('Starting initial connection...');
    connect().then(() => {
        log('Connected to aigent agent successfully');
        // Silent connection - status bar shows connection state
        updateStatusBar();
    }).catch((err) => {
        log(`Initial connection failed: ${err.message}`);
        updateStatusBar();
        // Silent fail - will reconnect on first action
    });
    // Send selection command
    context.subscriptions.push(vscode.commands.registerCommand('aigent.sendSelection', async () => {
        try {
            await connect();
            updateStatusBar();
            const ctx = await getSelection();
            sendMessage(ctx);
            // Silent - status bar shows connection state
            // vscode.window.showInformationMessage(`aigent: Sent selection (lines ${ctx.selection?.startLine}-${ctx.selection?.endLine})`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`aigent: ${err}`);
        }
    }));
    // Send active file command
    context.subscriptions.push(vscode.commands.registerCommand('aigent.sendFile', async () => {
        try {
            await connect();
            updateStatusBar();
            const ctx = await getActiveFile();
            sendMessage(ctx);
            // Silent - status bar shows connection state
            // vscode.window.showInformationMessage(`aigent: Sent ${ctx.filePath}`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`aigent: ${err}`);
        }
    }));
    // Auto-send context on selection change
    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(async (e) => {
        // Optional: auto-send selection changes
        // For now, manual trigger only to avoid spam
    }));
    // Help command - shows basic usage instructions (available via Command Palette)
    context.subscriptions.push(vscode.commands.registerCommand('aigent.help', () => {
        const help = `
# aigent VSCode Extension - Quick Start

## Commands
- aigent: Send Selection (Ctrl+Shift+A) - Send selected code to aigent
- aigent: Send Active File - Send entire file to aigent
- aigent: Show Connection Status - Check if connected

## Status Bar
- ✓ aigent = Connected to aigent server
- ✗ aigent = Not connected

## Tips
- Select code and press Ctrl+Shift+A to send to aigent
- Click status bar item to check connection
- Open Output > Aigent to see connection logs
`;
        vscode.window.showInformationMessage('aigent: Help shown in Output panel');
        outputChannel?.appendLine(help);
        outputChannel?.show(false);
    }));
}
function deactivate() {
    if (socket) {
        socket.end();
    }
}
//# sourceMappingURL=extension.js.map