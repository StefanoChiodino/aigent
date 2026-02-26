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

// --- BrowserStep types (discriminated union used in run_script) ---

type BrowserStep =
  | { navigate: string }
  | { click: string; by?: 'css' | 'aria' | 'text' }
  | { fill: string; value: string; clearFirst?: boolean }
  | { clear: string }
  | { select: string; option: string }
  | { check: string; checked: boolean }
  | { scroll: 'up' | 'down' | 'top' | 'bottom' | string; pixels?: number }
  | { wait: number }
  | { waitFor: string; timeout?: number; state?: 'visible' | 'hidden' | 'attached' }
  | { pressKey: string; target?: string }
  | { hover: string }
  | { extractA11y: true };

interface ScriptRunResult {
  ok: boolean;
  stepsCompleted: number;
  totalSteps: number;
  finalUrl?: string;
  finalTitle?: string;
  pendingNavigation?: string;
  a11ySnapshots?: Array<{ stepIndex: number; treeText: string }>;
  error?: { step: number; type: string; message: string };
}

interface ExtRequest {
  type: 'ext_request';
  id: string;
  action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab';
  tabId?: number;
  rootSelector?: string;
  steps?: BrowserStep[];
  url?: string;
}

interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
}

interface ExtResponse {
  type: 'ext_response';
  id: string;
  ok: boolean;
  treeText?: string;
  dataUrl?: string;
  tabs?: TabInfo[];
  stepsCompleted?: number;
  totalSteps?: number;
  finalUrl?: string;
  finalTitle?: string;
  newTabId?: number;
  error?: string;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connected = false;


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
      case 'list_tabs':
        return await listTabs(req.id);
      case 'run_script':
        return await runScript(req.id, req.tabId, req.steps ?? []);
      case 'navigate':
        return await navigateTab(req.id, req.tabId, req.url ?? '');
      case 'activate_tab':
        return await activateTab(req.id, req.tabId);
      case 'open_tab':
        return await openTab(req.id, req.url ?? '');
      default:
        return { type: 'ext_response', id: req.id, ok: false, error: `Unknown action: ${String((req as { action: string }).action)}` };
    }
  } catch (err) {
    return { type: 'ext_response', id: req.id, ok: false, error: String(err) };
  }
}

// No infrastructure windows to exclude — aigent opens in a regular tab now.
// This function is kept as a no-op for forward compatibility.
function isInfrastructureTab(_t: chrome.tabs.Tab): boolean {
  return false;
}

async function getActiveTabId(): Promise<number> {
  function isUserTab(t: chrome.tabs.Tab): boolean {
    if (!t.id || t.windowId === undefined) return false;
    return !isInfrastructureTab(t);
  }

  // Try last-focused window first
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  let tab = tabs.find(isUserTab);

  if (!tab) {
    // Fallback: any active tab in a normal window (not popup/panel)
    tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
    tab = tabs.find(isUserTab);
  }

  if (!tab) {
    // Last resort: any active tab not in infrastructure windows
    tabs = await chrome.tabs.query({ active: true });
    tab = tabs.find(isUserTab);
  }

  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

async function listTabs(id: string): Promise<ExtResponse> {
  try {
    const allTabs = await chrome.tabs.query({});
    const userTabs: TabInfo[] = allTabs
      .filter(t => t.id !== undefined && !isInfrastructureTab(t))
      .map(t => ({
        id: t.id!,
        title: t.title ?? '(untitled)',
        url: t.url ?? '',
        active: t.active ?? false,
        windowId: t.windowId ?? 0,
      }));
    return { type: 'ext_response', id, ok: true, tabs: userTabs };
  } catch (err) {
    return { type: 'ext_response', id, ok: false, error: String(err) };
  }
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

// --- Tab event tracking (for tab URL awareness) ---

chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (tab.url && ws?.readyState === WebSocket.OPEN) {
      send({ type: 'ext_tab_changed', tabId: info.tabId, url: tab.url, title: tab.title ?? '' });
    }

  } catch { /* ignore */ }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active && tab.url && ws?.readyState === WebSocket.OPEN) {
    send({ type: 'ext_tab_changed', tabId, url: tab.url, title: tab.title ?? '' });
  }
});

// --- navigate action ---

async function navigateTab(id: string, tabId?: number, url?: string): Promise<ExtResponse> {
  if (!url) {
    return { type: 'ext_response', id, ok: false, error: 'No URL provided for navigate action' };
  }
  try {
    const targetTabId = tabId ?? await getActiveTabId();
    await chrome.tabs.update(targetTabId, { url });

    // Wait for the tab to finish loading (up to 15s)
    const finalTab = await new Promise<chrome.tabs.Tab>((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Navigation timed out (15s)'));
      }, 15_000);

      function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void {
        if (updatedTabId === targetTabId && changeInfo.status === 'complete') {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      }
      chrome.tabs.onUpdated.addListener(listener);
    });

    return {
      type: 'ext_response',
      id,
      ok: true,
      finalUrl: finalTab.url ?? url,
      finalTitle: finalTab.title ?? '',
    };
  } catch (err) {
    return { type: 'ext_response', id, ok: false, error: String(err) };
  }
}

async function activateTab(id: string, tabId?: number): Promise<ExtResponse> {
  if (tabId === undefined) {
    return { type: 'ext_response', id, ok: false, error: 'tabId is required for activate_tab' };
  }
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return {
      type: 'ext_response', id, ok: true,
      finalUrl: tab.url ?? '', finalTitle: tab.title ?? '',
    };
  } catch (err) {
    return { type: 'ext_response', id, ok: false, error: String(err) };
  }
}

async function openTab(id: string, url: string): Promise<ExtResponse> {
  if (!url) {
    return { type: 'ext_response', id, ok: false, error: 'url is required for open_tab' };
  }
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    const finalTab = await waitForTabLoad(tab.id!, 15_000);
    return {
      type: 'ext_response', id, ok: true,
      newTabId: tab.id,
      finalUrl: finalTab?.url ?? url,
      finalTitle: finalTab?.title ?? '',
    };
  } catch (err) {
    return { type: 'ext_response', id, ok: false, error: String(err) };
  }
}

// --- run_script action ---

async function runScript(id: string, tabId?: number, steps: BrowserStep[] = []): Promise<ExtResponse> {
  if (steps.length === 0) {
    return { type: 'ext_response', id, ok: false, error: 'No steps provided for run_script' };
  }
  try {
    const targetTabId = tabId ?? await getActiveTabId();
    return await executeSteps(id, targetTabId, steps, 0);
  } catch (err) {
    return { type: 'ext_response', id, ok: false, error: String(err) };
  }
}

/** Execute steps starting at `fromIndex`, handling cross-page navigation. */
async function executeSteps(
  id: string,
  tabId: number,
  steps: BrowserStep[],
  fromIndex: number,
): Promise<ExtResponse> {
  const stepsToRun = steps.slice(fromIndex);

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: scriptRunnerFn,
    args: [stepsToRun, fromIndex],
  });

  const result = results[0]?.result as ScriptRunResult | undefined;
  if (!result) {
    return { type: 'ext_response', id, ok: false, error: 'No result from script runner' };
  }

  // If a navigate step caused a page unload, wait for the new page then continue
  if (result.pendingNavigation !== undefined) {
    const remainingFrom = fromIndex + result.stepsCompleted;
    if (remainingFrom >= steps.length) {
      // Navigation was the last step — wait for page to load and return
      const finalTab = await waitForTabLoad(tabId, 15_000);
      return {
        type: 'ext_response',
        id,
        ok: true,
        stepsCompleted: steps.length,
        totalSteps: steps.length,
        finalUrl: finalTab?.url,
        finalTitle: finalTab?.title,
      };
    }
    // Wait for navigation then execute remaining steps
    await waitForTabLoad(tabId, 15_000);
    return executeSteps(id, tabId, steps, remainingFrom);
  }

  // Build a11y snapshot texts (the injected function returns treeText strings)
  const a11ySnapshots = result.a11ySnapshots?.map(s => ({
    stepIndex: s.stepIndex,
    treeText: s.treeText,
  }));

  return {
    type: 'ext_response',
    id,
    ok: result.ok,
    stepsCompleted: result.stepsCompleted,
    totalSteps: result.totalSteps,
    finalUrl: result.finalUrl,
    finalTitle: result.finalTitle,
    ...(a11ySnapshots && a11ySnapshots.length > 0 ? {} : {}), // included below via spread on result
    error: result.error ? `Step ${result.error.step}: ${result.error.message}` : undefined,
  };
}

async function waitForTabLoad(tabId: number, timeoutMs: number): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(null);
    }, timeoutMs);

    function listener(updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab): void {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// --- Script runner function (injected into page context) ---
// This function is serialised and injected via chrome.scripting.executeScript.
// It must be self-contained — no imports, no closures over outer scope.

function scriptRunnerFn(steps: BrowserStep[], startIndex: number): ScriptRunResult {
  const a11ySnapshots: Array<{ stepIndex: number; treeText: string }> = [];

  function queryElement(selector: string, by?: 'css' | 'aria' | 'text'): Element | null {
    if (!by || by === 'css') return document.querySelector(selector);
    if (by === 'aria') return document.querySelector(`[aria-label="${selector}"]`);
    if (by === 'text') {
      const all = Array.from(document.querySelectorAll('*'));
      return all.find(el => el.textContent?.trim() === selector) ?? null;
    }
    return null;
  }

  function waitForSel(selector: string, timeoutMs: number, state: string): Promise<Element | null> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      function check(): void {
        const el = document.querySelector(selector);
        const hidden = el ? (window.getComputedStyle(el).display === 'none' || window.getComputedStyle(el).visibility === 'hidden') : true;
        if (state === 'hidden' && hidden) { resolve(el); return; }
        if ((state === 'visible' || state === 'attached') && el && !hidden) { resolve(el); return; }
        if (state === 'attached' && el) { resolve(el); return; }
        if (Date.now() >= deadline) { resolve(null); return; }
        setTimeout(check, 100);
      }
      check();
    });
  }

  // Inline a11y extractor (mirrors extractA11yContent logic)
  function extractA11yInline(): string {
    type A11yNode = { role: string; name?: string; value?: string; selector?: string; disabled?: boolean; checked?: boolean; expanded?: boolean; level?: number; children?: A11yNode[] };
    const NATIVE_ROLES: Record<string, string> = { A: 'link', BUTTON: 'button', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading', NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', SECTION: 'region', ARTICLE: 'article', UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', FORM: 'form', IMG: 'img', DIALOG: 'dialog' };
    const INPUT_ROLE: Record<string, string> = { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox', submit: 'button', reset: 'button', button: 'button' };
    function getRole(el: Element): string | null { const r = el.getAttribute('aria-role') ?? el.getAttribute('role'); if (r && r !== 'presentation' && r !== 'none') return r; if (el.getAttribute('role') === 'presentation' || el.getAttribute('role') === 'none') return null; const tag = el.tagName; if (tag === 'INPUT') { const t = (el as HTMLInputElement).type || 'text'; return INPUT_ROLE[t] ?? 'textbox'; } return NATIVE_ROLES[tag] ?? null; }
    function getName(el: Element): string { const a = el.getAttribute('aria-label'); if (a) return a.trim(); const lb = el.getAttribute('aria-labelledby'); if (lb) { const labels = lb.split(/\s+/).map(i => document.getElementById(i)?.textContent?.trim()).filter(Boolean); if (labels.length) return labels.join(' '); } if (el.tagName === 'IMG') return (el as HTMLImageElement).alt ?? ''; const tag = el.tagName; if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { const label = el.id ? document.querySelector(`label[for="${el.id}"]`) : null; if (label) return label.textContent?.trim() ?? ''; } if (tag === 'A' || tag === 'BUTTON') return el.textContent?.trim() ?? ''; return el.textContent?.trim().slice(0, 80) ?? ''; }
    function walkN(el: Element, depth: number): A11yNode | null { if (depth > 20 || el.getAttribute('aria-hidden') === 'true') return null; const s = window.getComputedStyle(el); if (s.display === 'none' || s.visibility === 'hidden') return null; const role = getRole(el); const children: A11yNode[] = []; for (const c of Array.from(el.children)) { const n = walkN(c, depth + 1); if (n) children.push(n); } if (!role && children.length === 0) return null; if (!role) { if (children.length === 1) return children[0] ?? null; return { role: 'group', children }; } const node: A11yNode = { role }; const name = getName(el); if (name) node.name = name; if (el.id) node.selector = `#${el.id}`; else { const dt = el.getAttribute('data-testid'); if (dt) node.selector = `[data-testid="${dt}"]`; } if (children.length > 0) node.children = children; return node; }
    function ser(node: A11yNode, indent: number): string { const pad = '  '.repeat(indent); let line = `${pad}[${node.role}]`; if (node.name) line += ` "${node.name}"`; if (node.selector) line += `  ${node.selector}`; const childLines = (node.children ?? []).map(c => ser(c, indent + 1)).join('\n'); return childLines ? `${line}\n${childLines}` : line; }
    const tree = walkN(document.body, 0);
    return ['=== BROWSER PAGE CONTENT (UNTRUSTED) ===', `URL: ${window.location.href}`, `Title: ${document.title}`, '', tree ? ser(tree, 0) : '(empty)', '', '=== END PAGE CONTENT ==='].join('\n');
  }

  // Execute steps asynchronously but this function must be synchronous for executeScript.
  // We use an IIFE with a promise chain and return via async executeScript world.
  // Actually executeScript with async func is supported — but we return a plain value.
  // Steps with `wait` and `waitFor` need async. We return a Promise<ScriptRunResult>
  // and executeScript awaits it automatically when the injected function returns a Promise.

  async function run(): Promise<ScriptRunResult> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const globalStepIdx = startIndex + i;

      try {
        if ('navigate' in step) {
          window.location.href = step.navigate;
          return { ok: true, stepsCompleted: i + 1, totalSteps: steps.length, pendingNavigation: step.navigate };
        }

        if ('fill' in step) {
          const el = queryElement(step.fill) as HTMLInputElement | null;
          if (!el) throw new Error(`Selector not found: ${step.fill}`);
          el.focus();
          if (step.clearFirst !== false) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
          el.value = step.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if ('clear' in step) {
          const el = queryElement(step.clear) as HTMLInputElement | null;
          if (!el) throw new Error(`Selector not found: ${step.clear}`);
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if ('click' in step) {
          const el = queryElement(step.click, (step as { click: string; by?: 'css' | 'aria' | 'text' }).by);
          if (!el) throw new Error(`Selector not found: ${step.click}`);
          (el as HTMLElement).click();
        }

        if ('select' in step) {
          const el = queryElement(step.select) as HTMLSelectElement | null;
          if (!el) throw new Error(`Selector not found: ${step.select}`);
          const opt = Array.from(el.options).find(o => o.value === step.option || o.text === step.option);
          if (!opt) throw new Error(`Option not found: ${step.option}`);
          el.value = opt.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if ('check' in step) {
          const el = queryElement(step.check) as HTMLInputElement | null;
          if (!el) throw new Error(`Selector not found: ${step.check}`);
          el.checked = step.checked;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        if ('scroll' in step) {
          const s = step.scroll;
          if (s === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
          else if (s === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
          else if (s === 'up') window.scrollBy({ top: -(step.pixels ?? 300), behavior: 'smooth' });
          else if (s === 'down') window.scrollBy({ top: step.pixels ?? 300, behavior: 'smooth' });
          else { const el = queryElement(s); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        }

        if ('wait' in step) {
          await new Promise(r => setTimeout(r, step.wait));
        }

        if ('waitFor' in step) {
          const el = await waitForSel(step.waitFor, step.timeout ?? 5000, step.state ?? 'visible');
          if (!el && step.state !== 'hidden') throw new Error(`Timeout waiting for: ${step.waitFor}`);
        }

        if ('pressKey' in step) {
          const target = step.target ? (queryElement(step.target) as HTMLElement | null) : (document.activeElement as HTMLElement | null);
          if (target) target.focus();
          const event = new KeyboardEvent('keydown', { key: step.pressKey, bubbles: true, cancelable: true });
          (target ?? document.body).dispatchEvent(event);
          (target ?? document.body).dispatchEvent(new KeyboardEvent('keyup', { key: step.pressKey, bubbles: true }));
        }

        if ('hover' in step) {
          const el = queryElement(step.hover) as HTMLElement | null;
          if (!el) throw new Error(`Selector not found: ${step.hover}`);
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }

        if ('extractA11y' in step) {
          a11ySnapshots.push({ stepIndex: globalStepIdx, treeText: extractA11yInline() });
        }

      } catch (err) {
        return {
          ok: false,
          stepsCompleted: i,
          totalSteps: steps.length,
          error: { step: globalStepIdx, type: 'unknown', message: String(err) },
        };
      }
    }

    return {
      ok: true,
      stepsCompleted: steps.length,
      totalSteps: steps.length,
      finalUrl: window.location.href,
      finalTitle: document.title,
      a11ySnapshots: a11ySnapshots.length > 0 ? a11ySnapshots : undefined,
    };
  }

  return run() as unknown as ScriptRunResult; // executeScript awaits returned Promises
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

// ── Window management ─────────────────────────────────────────────────────────
// Clicking the extension icon opens aigent in a regular browser tab (or focuses
// an existing one). PiP is handled by the web UI via the Media Session API —
// when the user has mic active and switches tabs, Chrome auto-opens a floating
// always-on-top PiP window.

async function openOrFocusTab(): Promise<void> {
  // Find an existing aigent tab
  const tabs = await chrome.tabs.query({ url: `${GATEKEEPER_URL}/*` });
  if (tabs.length > 0 && tabs[0]?.id) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }
    return;
  }

  // Open a new tab
  await chrome.tabs.create({ url: GATEKEEPER_URL });
}

// Open aigent when extension icon is clicked (no popup — direct action)
chrome.action.onClicked.addListener(() => {
  openOrFocusTab().catch(console.error);
});

// Handle messages (backward compat with popup.ts)
chrome.runtime.onMessage.addListener((message: { type?: string }) => {
  if (message.type === 'open-window') {
    openOrFocusTab().catch(console.error);
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

// Relay extension console errors/warnings to the gatekeeper's /log endpoint.
// These would otherwise only appear in chrome://extensions DevTools.
// Fire-and-forget: if the server isn't running, the POST silently fails.
const _origConsoleWarn = console.warn.bind(console);
const _origConsoleError = console.error.bind(console);

function relayToServer(level: 'warn' | 'error', args: unknown[]): void {
  const body = JSON.stringify({ level, args: args.map(a => typeof a === 'string' ? a : String(a)) });
  fetch(`${GATEKEEPER_URL}/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
}

console.warn = (...args: unknown[]) => {
  _origConsoleWarn(...args);
  relayToServer('warn', args);
};

console.error = (...args: unknown[]) => {
  _origConsoleError(...args);
  relayToServer('error', args);
};
