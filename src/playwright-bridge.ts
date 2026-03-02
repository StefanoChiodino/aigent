/**
 * Playwright Bridge — headless browser fallback when the Chrome extension is not connected.
 *
 * Implements the same action interface as ExtensionBridge, using playwright-core to
 * drive a headless Chromium. playwright-core is an optional peer dependency — the user
 * must install it themselves (`npm install playwright-core`).
 *
 * The browser is launched lazily on first request and auto-closes after 15 minutes idle.
 */

import { createLogger } from './logger.js';
import { validateFetchUrl } from './safety.js';

const log = createLogger('playwright-bridge');

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// Re-export the response shape matching ExtensionBridge
interface PlaywrightResponse {
  ok: boolean;
  treeText?: string;
  dataUrl?: string;
  tabs?: Array<{ id: number; title: string; url: string; active: boolean; windowId: number }>;
  stepsCompleted?: number;
  totalSteps?: number;
  finalUrl?: string;
  finalTitle?: string;
  newTabId?: number;
  screenshots?: Array<{ stepIndex: number; dataUrl: string }>;
  error?: string;
}

// Playwright types (lazily imported)
type Browser = import('playwright-core').Browser;
type BrowserContext = import('playwright-core').BrowserContext;
type Page = import('playwright-core').Page;

let playwrightModule: typeof import('playwright-core') | null = null;

async function loadPlaywright(): Promise<typeof import('playwright-core')> {
  if (playwrightModule) return playwrightModule;
  try {
    playwrightModule = await import('playwright-core');
    return playwrightModule;
  } catch {
    throw new Error(
      'playwright-core is not installed. Install it with: npm install playwright-core\n' +
      'Then install a browser: npx playwright install chromium',
    );
  }
}

class PlaywrightBridge {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages = new Map<number, Page>(); // tabId → Page
  private nextTabId = 1;
  private activeTabId = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Check if playwright-core is available without throwing. */
  async isAvailable(): Promise<boolean> {
    try {
      await loadPlaywright();
      return true;
    } catch {
      return false;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      log.info('Playwright idle timeout — closing browser');
      void this.close();
    }, IDLE_TIMEOUT_MS);
  }

  private async ensureBrowser(): Promise<BrowserContext> {
    if (this.context) {
      this.resetIdleTimer();
      return this.context;
    }

    const pw = await loadPlaywright();
    log.info('Launching headless Chromium');
    this.browser = await pw.chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    this.resetIdleTimer();
    return this.context;
  }

  private async getPage(tabId?: number): Promise<Page> {
    const ctx = await this.ensureBrowser();

    if (tabId !== undefined && this.pages.has(tabId)) {
      this.activeTabId = tabId;
      return this.pages.get(tabId)!;
    }

    if (this.activeTabId && this.pages.has(this.activeTabId)) {
      return this.pages.get(this.activeTabId)!;
    }

    // No pages yet — create one
    const page = await ctx.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;
    page.on('close', () => {
      this.pages.delete(id);
      if (this.activeTabId === id) this.activeTabId = 0;
    });
    return page;
  }

  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.pages.clear();
    this.activeTabId = 0;
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  async request(
    action: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<PlaywrightResponse> {
    if (signal?.aborted) return { ok: false, error: 'Aborted by user' };
    this.resetIdleTimer();
    try {
      switch (action) {
        case 'list_tabs': return this.listTabs();
        case 'extract_a11y': return await this.extractA11y(params.tabId as number | undefined);
        case 'screenshot': return await this.captureScreenshot(params.tabId as number | undefined);
        case 'navigate': return await this.navigate(params.tabId as number | undefined, params.url as string);
        case 'activate_tab': return this.activateTab(params.tabId as number);
        case 'open_tab': return await this.openTab(params.url as string);
        case 'close_tab': return await this.closeTab(params.tabId as number);
        case 'run_script': return await this.runScript(params.tabId as number | undefined, (params.steps as unknown[]) ?? [], signal);
        default:
          return { ok: false, error: `Action '${action}' is not supported in headless mode` };
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  private listTabs(): PlaywrightResponse {
    const tabs = [...this.pages.entries()].map(([id, page]) => ({
      id,
      title: '', // Playwright doesn't cache titles — filled lazily
      url: page.url(),
      active: id === this.activeTabId,
      windowId: 1,
    }));
    return { ok: true, tabs };
  }

  private async extractA11y(tabId?: number): Promise<PlaywrightResponse> {
    const page = await this.getPage(tabId);
    // Use Playwright's aria snapshot API (available since Playwright 1.49+)
    // Falls back to evaluating in-page if not available
    try {
      const snapshot = await page.locator('body').ariaSnapshot();
      return { ok: true, treeText: snapshot };
    } catch {
      // Fallback: extract basic structure via string-based JS evaluation
      const treeText = await page.evaluate(`
        (function() {
          function walk(el, depth) {
            var role = el.getAttribute('role') || el.tagName.toLowerCase();
            var name = el.getAttribute('aria-label') || (el.textContent || '').slice(0, 50);
            var lines = [Array(depth + 1).join('  ') + role + ' "' + name.trim() + '"'];
            for (var i = 0; i < el.children.length; i++) {
              lines = lines.concat(walk(el.children[i], depth + 1));
            }
            return lines;
          }
          return walk(document.body, 0).join('\\n');
        })()
      `) as string;
      return { ok: true, treeText };
    }
  }

  private async captureScreenshot(tabId?: number): Promise<PlaywrightResponse> {
    const page = await this.getPage(tabId);
    const buffer = await page.screenshot({ type: 'png' });
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    return { ok: true, dataUrl };
  }

  private async navigate(tabId: number | undefined, url: string): Promise<PlaywrightResponse> {
    if (!url) return { ok: false, error: 'No URL provided' };

    // SSRF validation
    const ssrfErr = validateFetchUrl(url);
    if (ssrfErr) return { ok: false, error: `Blocked: ${ssrfErr}` };

    const page = await this.getPage(tabId);
    await page.goto(url, { timeout: 15_000, waitUntil: 'load' });
    return { ok: true, finalUrl: page.url(), finalTitle: await page.title() };
  }

  private activateTab(tabId: number): PlaywrightResponse {
    if (!this.pages.has(tabId)) return { ok: false, error: `Tab ${tabId} not found` };
    this.activeTabId = tabId;
    const page = this.pages.get(tabId)!;
    return { ok: true, finalUrl: page.url() };
  }

  private async openTab(url: string): Promise<PlaywrightResponse> {
    if (!url) return { ok: false, error: 'No URL provided' };

    const ssrfErr = validateFetchUrl(url);
    if (ssrfErr) return { ok: false, error: `Blocked: ${ssrfErr}` };

    const ctx = await this.ensureBrowser();
    const page = await ctx.newPage();
    const id = this.nextTabId++;
    this.pages.set(id, page);
    this.activeTabId = id;
    page.on('close', () => {
      this.pages.delete(id);
      if (this.activeTabId === id) this.activeTabId = 0;
    });

    await page.goto(url, { timeout: 15_000, waitUntil: 'load' });
    return { ok: true, newTabId: id, finalUrl: page.url(), finalTitle: await page.title() };
  }

  private async closeTab(tabId: number): Promise<PlaywrightResponse> {
    const page = this.pages.get(tabId);
    if (!page) return { ok: false, error: `Tab ${tabId} not found` };
    await page.close();
    return { ok: true };
  }

  private async runScript(tabId: number | undefined, steps: unknown[], signal?: AbortSignal): Promise<PlaywrightResponse> {
    if (steps.length === 0) return { ok: false, error: 'No steps provided' };

    const page = await this.getPage(tabId);
    let completed = 0;
    const screenshots: Array<{ stepIndex: number; dataUrl: string }> = [];

    for (const rawStep of steps) {
      if (signal?.aborted) {
        return { ok: false, error: 'Aborted by user', stepsCompleted: completed, totalSteps: steps.length };
      }
      const step = rawStep as Record<string, unknown>;
      try {
        if ('navigate' in step) {
          const url = step['navigate'] as string;
          const ssrfErr = validateFetchUrl(url);
          if (ssrfErr) return { ok: false, error: `Blocked: ${ssrfErr}`, stepsCompleted: completed, totalSteps: steps.length };
          await page.goto(url, { timeout: 15_000, waitUntil: 'load' });
        } else if ('click' in step) {
          const selector = step['click'] as string;
          await page.click(selector, { timeout: 5000 });
        } else if ('fill' in step) {
          const selector = step['fill'] as string;
          const value = step['value'] as string ?? '';
          if (step['clearFirst'] !== false) await page.fill(selector, '');
          await page.fill(selector, value);
        } else if ('clear' in step) {
          await page.fill(step['clear'] as string, '');
        } else if ('select' in step) {
          await page.selectOption(step['select'] as string, { label: step['option'] as string });
        } else if ('check' in step) {
          const checked = step['checked'] as boolean;
          if (checked) await page.check(step['check'] as string);
          else await page.uncheck(step['check'] as string);
        } else if ('scroll' in step) {
          const dir = step['scroll'] as string;
          const pixels = (step['pixels'] as number) ?? 300;
          if (dir === 'up') await page.evaluate(`window.scrollBy(0, -${pixels})`);
          else if (dir === 'down') await page.evaluate(`window.scrollBy(0, ${pixels})`);
          else if (dir === 'top') await page.evaluate('window.scrollTo(0, 0)');
          else if (dir === 'bottom') await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
          else await page.locator(dir).scrollIntoViewIfNeeded();
        } else if ('wait' in step) {
          await page.waitForTimeout(step['wait'] as number);
        } else if ('waitFor' in step) {
          const state = (step['state'] as 'visible' | 'hidden' | 'attached') ?? 'visible';
          const timeout = (step['timeout'] as number) ?? 5000;
          await page.locator(step['waitFor'] as string).waitFor({ state, timeout });
        } else if ('pressKey' in step) {
          const target = step['target'] as string | undefined;
          if (target) await page.locator(target).press(step['pressKey'] as string);
          else await page.keyboard.press(step['pressKey'] as string);
        } else if ('hover' in step) {
          await page.hover(step['hover'] as string);
        } else if ('screenshot' in step) {
          const buf = await page.screenshot({ type: 'png' });
          screenshots.push({ stepIndex: completed, dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
        }
        // extractA11y steps are silently skipped in headless mode (use extract_a11y action directly)
        completed++;
      } catch (err) {
        return {
          ok: false,
          error: `Step ${completed} failed: ${String(err)}`,
          stepsCompleted: completed,
          totalSteps: steps.length,
          finalUrl: page.url(),
          finalTitle: await page.title(),
          ...(screenshots.length > 0 ? { screenshots } : {}),
        };
      }
    }

    return {
      ok: true,
      stepsCompleted: completed,
      totalSteps: steps.length,
      finalUrl: page.url(),
      finalTitle: await page.title(),
      ...(screenshots.length > 0 ? { screenshots } : {}),
    };
  }
}

export const playwrightBridge = new PlaywrightBridge();
