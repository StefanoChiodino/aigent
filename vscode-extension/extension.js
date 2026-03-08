"use strict";
/**
 * aigent VS Code Extension
 *
 * Sends VS Code context to aigent agent via WebSocket at ws://localhost:3141/ext
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
const AIGENT_HOST = 'localhost';
const AIGENT_PORT = 3141;
const AIGENT_PATH = '/ext';
let socket = null;
let connected = false;
function connect() {
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
            socket.write(request);
            // Wait for upgrade response
            let buffer = '';
            socket.on('data', (data) => {
                buffer += data.toString();
                if (buffer.includes('\r\n\r\n')) {
                    if (buffer.includes('101 Switching Protocols')) {
                        connected = true;
                        resolve(socket);
                    }
                    else {
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
    });
}
function sendMessage(data) {
    if (!socket || !connected) {
        vscode.window.showWarningMessage('aigent: Not connected. Make sure aigent is running.');
        return;
    }
    // Simple WebSocket frame: opcode 0x81 (text), length + payload
    const json = JSON.stringify(data);
    const length = Buffer.byteLength(json);
    let frame;
    if (length <= 125) {
        frame = Buffer.alloc(2 + length);
        frame[0] = 0x81; // text frame
        frame[1] = length;
    }
    else if (length <= 65535) {
        frame = Buffer.alloc(4 + length);
        frame[0] = 0x81;
        frame[1] = 126;
        frame.writeUInt16BE(length, 2);
    }
    else {
        frame = Buffer.alloc(10 + length);
        frame[0] = 0x81;
        frame[1] = 127;
        frame.writeBigUInt64BE(BigInt(length), 2);
    }
    frame.write(json, frame[1] === 126 ? 4 : frame[1] === 127 ? 10 : 2);
    socket.write(frame);
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
    // Connect to aigent on startup
    connect().then(() => {
        vscode.window.showInformationMessage('aigent: Connected');
    }).catch(() => {
        // Silent fail - will reconnect on first action
    });
    // Send selection command
    context.subscriptions.push(vscode.commands.registerCommand('aigent.sendSelection', async () => {
        try {
            await connect();
            const ctx = await getSelection();
            sendMessage(ctx);
            vscode.window.showInformationMessage(`aigent: Sent selection (lines ${ctx.selection?.startLine}-${ctx.selection?.endLine})`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`aigent: ${err}`);
        }
    }));
    // Send active file command
    context.subscriptions.push(vscode.commands.registerCommand('aigent.sendFile', async () => {
        try {
            await connect();
            const ctx = await getActiveFile();
            sendMessage(ctx);
            vscode.window.showInformationMessage(`aigent: Sent ${ctx.filePath}`);
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
}
function deactivate() {
    if (socket) {
        socket.end();
    }
}
//# sourceMappingURL=extension.js.map