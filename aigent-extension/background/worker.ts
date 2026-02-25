/**
 * aigent Extension — Background Service Worker
 *
 * Maintains a WebSocket connection to the aigent gatekeeper at ws://localhost:3141/ext.
 * Receives browser_ext commands and dispatches them to the active tab.
 *
 * MV3 service workers are terminated by Chrome after ~30s of inactivity.
 * We use chrome.alarms (fires every 25s) to wake the worker up and ensure
 * the WebSocket connection stays alive / reconnects if it dropped.
 */

const GATEKEEPER_WS = 'ws://localhost:3141/ext';
const GATEKEEPER_URL = 'http://localhost:3141';
const RECONNECT_DELAY_MS = 3000;
const KEEPALIVE_ALARM = 'aigent-keepalive';

interface ExtRequest {
  type: 'ext_request';
  id: string;
  action: 'extract_a11y' | 'screenshot';
  tabId?: number;
  rootSelector?: string;
}

interface ExtResponse {
  type: 'ext_response';
  id: string;
  ok: boolean;
  treeText?: string;
  dataUrl?: string;
  error?: string;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connected = false;

// Track the aigent popup window so we can focus it instead of opening duplicates
let aigentWindowId: number | null = null;

function setConnected(value: boolean): void {
  connected = value;
  chrome.storage.session.set({ connected }).catch(() => {});
}

function send(msg: object): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function connect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  ws = new WebSocket(GATEKEEPER_WS);

  ws.onopen = () => {
    console.log('[aigent] Connected to gatekeeper');
    setConnected(true);
    send({ type: 'ext_hello', version: '0.2.0', browser: navigator.userAgent });
  };

  ws.onmessage = async (event: MessageEvent) => {
    let msg: ExtRequest;
    try {
      msg = JSON.parse(event.data as string) as ExtRequest;
    } catch {
      console.error('[aigent] Failed to parse message', event.data);
      return;
    }

    if (msg.type !== 'ext_request') return;

    const response = await handleRequest(msg);
    send(response);
  };

  ws.onerror = () => {
    console.warn('[aigent] WebSocket error');
  };

  ws.onclose = () => {
    console.log('[aigent] Disconnected from gatekeeper, reconnecting...');
    setConnected(false);
    ws = null;
    reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };
}

async function handleRequest(req: ExtRequest): Promise<ExtResponse> {
  try {
    switch (req.action) {
      case 'extract_a11y':
        return await extractA11y(req.id, req.tabId, req.rootSelector);
      case 'screenshot':
        return await captureScreenshot(req.id, req.tabId);
      default:
        return { type: 'ext_response', id: req.id, ok: false, error: `Unknown action: ${String((req as { action: string }).action)}` };
    }
  } catch (err) {
    return { type: 'ext_response', id: req.id, ok: false, error: String(err) };
  }
}

async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

async function extractA11y(id: string, tabId?: number, rootSelector?: string): Promise<ExtResponse> {
  const targetTabId = tabId ?? await getActiveTabId();

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: extractA11yContent,
    args: [rootSelector ?? null],
  });

  const result = results[0]?.result as string | undefined;
  if (result === undefined) {
    return { type: 'ext_response', id, ok: false, error: 'No result from content script' };
  }

  return { type: 'ext_response', id, ok: true, treeText: result };
}

async function captureScreenshot(id: string, tabId?: number): Promise<ExtResponse> {
  const targetTabId = tabId ?? await getActiveTabId();

  // Get the window ID for the tab
  const tab = await chrome.tabs.get(targetTabId);
  if (!tab.windowId) {
    return { type: 'ext_response', id, ok: false, error: 'Tab has no window' };
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return { type: 'ext_response', id, ok: true, dataUrl };
}

// --- A11y extractor function (runs in page context) ---
// This function is serialised and injected into the page via chrome.scripting.executeScript.
// It must be self-contained — no imports, no closures over outer scope.

function extractA11yContent(rootSelector: string | null): string {
  type A11yNode = {
    role: string;
    name?: string;
    value?: string;
    selector?: string;
    disabled?: boolean;
    checked?: boolean;
    expanded?: boolean;
    level?: number;
    children?: A11yNode[];
  };

  const NATIVE_ROLES: Record<string, string> = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox',
    SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading',
    H4: 'heading', H5: 'heading', H6: 'heading', NAV: 'navigation',
    MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary',
    SECTION: 'region', ARTICLE: 'article', UL: 'list', OL: 'list',
    LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    FORM: 'form', IMG: 'img', HR: 'separator', DIALOG: 'dialog',
    DETAILS: 'group', SUMMARY: 'button',
  };

  const INPUT_ROLE: Record<string, string> = {
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox',
    password: 'textbox', submit: 'button', reset: 'button', button: 'button',
    file: 'button',
  };

  function getRole(el: Element): string | null {
    const ariaRole = el.getAttribute('aria-role') ?? el.getAttribute('role');
    if (ariaRole && ariaRole !== 'presentation' && ariaRole !== 'none') return ariaRole;
    if (el.getAttribute('role') === 'presentation' || el.getAttribute('role') === 'none') return null;

    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el as HTMLInputElement).type || 'text';
      return INPUT_ROLE[type] ?? 'textbox';
    }
    return NATIVE_ROLES[tag] ?? null;
  }

  function getAccessibleName(el: Element): string {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      const labels = ariaLabelledBy.split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean);
      if (labels.length > 0) return labels.join(' ');
    }

    const tag = el.tagName;
    if (tag === 'IMG') return (el as HTMLImageElement).alt ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const id = el.id;
      if (id) {
        const label = document.querySelector(`label[for="${id}"]`);
        if (label) return label.textContent?.trim() ?? '';
      }
    }
    if (tag === 'A' || tag === 'BUTTON') return el.textContent?.trim() ?? '';

    const title = el.getAttribute('title');
    if (title) return title.trim();

    return el.textContent?.trim().slice(0, 80) ?? '';
  }

  function getBestSelector(el: Element): string | undefined {
    if (el.id) return `#${el.id}`;
    const dataTestId = el.getAttribute('data-testid');
    if (dataTestId) return `[data-testid="${dataTestId}"]`;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `[aria-label="${ariaLabel}"]`;
    const tag = el.tagName.toLowerCase();
    const type = (el as HTMLInputElement).type;
    if (type) return `${tag}[type="${type}"]`;
    return undefined;
  }

  function getValue(el: Element): string | undefined {
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const input = el as HTMLInputElement;
      if (input.type === 'password') return '[REDACTED]';
      if (input.type === 'checkbox' || input.type === 'radio') return undefined;
      return input.value || undefined;
    }
    if (tag === 'TEXTAREA') return (el as HTMLTextAreaElement).value || undefined;
    if (tag === 'SELECT') {
      const sel = el as HTMLSelectElement;
      return sel.options[sel.selectedIndex]?.text || undefined;
    }
    return undefined;
  }

  function isHidden(el: Element): boolean {
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    return false;
  }

  function walkNode(el: Element, depth: number): A11yNode | null {
    if (depth > 20) return null;
    if (isHidden(el)) return null;

    const role = getRole(el);
    const children: A11yNode[] = [];

    for (const child of Array.from(el.children)) {
      const childNode = walkNode(child, depth + 1);
      if (childNode) children.push(childNode);
    }

    // If no role and no interactive children, skip
    if (!role && children.length === 0) return null;

    // Collapse role-less containers that only pass through children
    if (!role) {
      if (children.length === 1) return children[0] ?? null;
      // Wrap multiple children in a generic group — but only if there are children worth keeping
      return { role: 'group', children };
    }

    const name = getAccessibleName(el);
    const node: A11yNode = { role };
    if (name) node.name = name;

    const value = getValue(el);
    if (value) node.value = value;

    const selector = getBestSelector(el);
    if (selector) node.selector = selector;

    const disabled = el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled;
    if (disabled) node.disabled = true;

    const checked = el.getAttribute('aria-checked');
    if (checked !== null) node.checked = checked === 'true';
    else if ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio') {
      node.checked = (el as HTMLInputElement).checked;
    }

    const expanded = el.getAttribute('aria-expanded');
    if (expanded !== null) node.expanded = expanded === 'true';

    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) node.level = parseInt(tag[1] ?? '1', 10);

    if (children.length > 0) node.children = children;

    return node;
  }

  function serialise(node: A11yNode, indent = 0): string {
    const pad = '  '.repeat(indent);
    let line = `${pad}[${node.role}]`;
    if (node.name) line += ` "${node.name}"`;
    if (node.selector) line += `  ${node.selector}`;
    const meta: string[] = [];
    if (node.value) meta.push(`value: ${node.value}`);
    if (node.disabled) meta.push('disabled');
    if (node.checked !== undefined) meta.push(`checked: ${node.checked}`);
    if (node.expanded !== undefined) meta.push(`expanded: ${node.expanded}`);
    if (meta.length > 0) line += `\n${pad}  ${meta.join(', ')}`;

    const childLines = (node.children ?? []).map(c => serialise(c, indent + 1)).join('\n');
    return childLines ? `${line}\n${childLines}` : line;
  }

  const root = rootSelector
    ? (document.querySelector(rootSelector) ?? document.body)
    : document.body;

  const tree = walkNode(root, 0);
  const treeText = tree ? serialise(tree) : '(empty)';

  return [
    '=== BROWSER PAGE CONTENT (UNTRUSTED) ===',
    `URL: ${window.location.href}`,
    `Title: ${document.title}`,
    '',
    treeText,
    '',
    '=== END PAGE CONTENT ===',
  ].join('\n');
}

// ── Popup window management ────────────────────────────────────────────────────
// Clicking the extension toolbar icon opens (or focuses) a popup window
// showing the aigent web UI. This is a normal Chrome window with full
// getUserMedia access — no iframe restrictions.

async function openOrFocusWindow(): Promise<void> {
  // If we already have a window, try to focus it
  if (aigentWindowId !== null) {
    try {
      const existing = await chrome.windows.get(aigentWindowId);
      if (existing) {
        await chrome.windows.update(aigentWindowId, { focused: true });
        return;
      }
    } catch {
      // Window was closed — fall through to create
      aigentWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    url: GATEKEEPER_URL,
    type: 'popup',
    width: 420,
    height: 720,
  });
  aigentWindowId = win.id ?? null;
}

// Clear tracked window ID when it's closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === aigentWindowId) aigentWindowId = null;
});

// Handle "open-window" messages from the popup page
chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message.type === 'open-window') {
    openOrFocusWindow().catch(console.error);
  }
});

// ── Keep-alive via chrome.alarms ──────────────────────────────────────────────
// MV3 service workers are killed after ~30s idle. We use an alarm (max every
// 1 minute per Chrome policy, but we fire every 25s via the alarm itself) to
// wake the worker and ensure the WebSocket is still alive.
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.4 }); // ~25s

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // If WS is closed or closing, reconnect (but don't double-connect)
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    connect();
  }
});

// Boot
connect();
