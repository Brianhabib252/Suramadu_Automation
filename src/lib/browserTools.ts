import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Browser,
  BrowserContext,
  Locator,
  Page,
  chromium,
  type LaunchOptions,
} from 'playwright';
import { nowJakarta } from './time';

export type LoadState = 'load' | 'domcontentloaded' | 'networkidle';

type TypeMode = 'clear' | 'append';

export interface BrowserToolsOptions {
  headless?: boolean;
  artifactsDir?: string;
  screenshotOnError?: boolean;
  slowMoMs?: number;
  defaultTimeoutMs?: number;
  browserChannel?: string;
}

export interface WaitForOptions {
  selector?: string;
  state?: LoadState;
  timeoutMs?: number;
}

export class BrowserTools {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly artifactsDir: string,
    private readonly screenshotOnError: boolean,
    private readonly defaultTimeoutMs: number,
  ) {}

  static async launch(options: BrowserToolsOptions = {}): Promise<BrowserTools> {
    const artifactsDir =
      options.artifactsDir ??
      path.resolve(process.cwd(), 'artifacts');

    await fs.mkdir(artifactsDir, { recursive: true });

    const launchConfig: LaunchOptions = {
      headless: options.headless ?? true,
      slowMo: options.slowMoMs,
    };
    if (options.browserChannel) {
      launchConfig.channel = options.browserChannel;
    }

    let browser: Browser | undefined;
    try {
      browser = await chromium.launch(launchConfig);
    } catch (error) {
      if (!options.browserChannel) {
        throw error;
      }
      console.warn(
        `Launching channel "${options.browserChannel}" failed, falling back to bundled Chromium.`,
        error,
      );
      const fallbackConfig: LaunchOptions = {
        headless: launchConfig.headless,
        slowMo: launchConfig.slowMo,
      };
      browser = await chromium.launch(fallbackConfig);
    }

    if (!browser) {
      throw new Error('Failed to launch automation browser instance.');
    }
    const context = await browser.newContext();
    const page = await context.newPage();

    const defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    context.setDefaultTimeout(defaultTimeoutMs);
    context.setDefaultNavigationTimeout(defaultTimeoutMs);
    page.setDefaultTimeout(defaultTimeoutMs);
    page.setDefaultNavigationTimeout(defaultTimeoutMs);

    return new BrowserTools(
      browser,
      context,
      page,
      artifactsDir,
      options.screenshotOnError ?? true,
      defaultTimeoutMs,
    );
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  async navigate(
    url: string,
    waitUntil: LoadState = 'load',
    timeoutMs?: number,
  ): Promise<void> {
    await this.execute('navigate', async () => {
      try {
        await this.page.goto(url, {
          waitUntil,
          timeout: timeoutMs ?? this.defaultTimeoutMs,
        });
      } catch (error) {
        if (this.isNavigationAbortedError(error)) {
          const matched = await this.waitForUrlMatch(url);
          if (matched) {
            return;
          }
          await this.page.waitForTimeout(750);
          try {
            await this.page.goto(url, {
              waitUntil: waitUntil === 'networkidle' ? 'domcontentloaded' : waitUntil,
              timeout: timeoutMs ?? this.defaultTimeoutMs,
            });
            if (waitUntil === 'networkidle') {
              await this.page
                .waitForLoadState('networkidle', {
                  timeout: timeoutMs ?? this.defaultTimeoutMs,
                })
                .catch(() => {});
            }
            return;
          } catch (retryError) {
            console.warn(
              `Navigation aborted and final URL "${this.page.url()}" did not match "${url}".`,
            );
            throw retryError;
          }
        }
        throw error;
      }
    });
  }

  async type(
    target: Locator | string,
    value: string,
    mode: TypeMode = 'clear',
  ): Promise<void> {
    await this.execute('type', async () => {
      const locator = this.resolveLocator(target);
      await locator.waitFor({ state: 'visible' });
      if (mode === 'clear') {
        await locator.fill(value, { timeout: undefined });
      } else {
        await locator.focus();
        await locator.type(value, { delay: 10 });
      }
    });
  }

  async click(target: Locator | string): Promise<void> {
    await this.execute('click', async () => {
      const locator = this.resolveLocator(target);
      await locator.waitFor({ state: 'visible' });
      await locator.click();
    });
  }

  async check(target: Locator | string, checked = true): Promise<void> {
    await this.execute('check', async () => {
      const locator = this.resolveLocator(target);
      await locator.waitFor({ state: 'visible' });
      await locator.setChecked(checked);
    });
  }

  async select(
    target: Locator | string,
    values: string | string[],
  ): Promise<void> {
    await this.execute('select', async () => {
      const locator = this.resolveLocator(target);
      await locator.waitFor({ state: 'visible' });
      await locator.selectOption(values);
    });
  }

  async waitFor(options: WaitForOptions): Promise<void> {
    await this.execute('waitFor', async () => {
      const { selector, state, timeoutMs } = options;
      if (!selector && !state) {
        const duration = timeoutMs ?? this.defaultTimeoutMs;
        await this.page.waitForTimeout(duration);
        return;
      }
      if (selector) {
        await this.page.waitForSelector(selector, {
          timeout: timeoutMs ?? this.defaultTimeoutMs,
        });
      }
      if (state) {
        await this.page.waitForLoadState(state, {
          timeout: timeoutMs ?? this.defaultTimeoutMs,
        });
      }
    });
  }

  async extractText(target: Locator | string): Promise<string> {
    return this.execute('extractText', async () => {
      const locator = this.resolveLocator(target);
      await locator.waitFor({ state: 'visible' });
      return locator.innerText();
    });
  }

  getDefaultTimeout(): number {
    return this.defaultTimeoutMs;
  }

  async saveHtml(filename = 'page.html'): Promise<string> {
    return this.execute('saveHtml', async () => {
      const filePath = await this.buildArtifactPath(filename);
      const html = await this.page.content();
      await fs.writeFile(filePath, html, 'utf-8');
      return filePath;
    });
  }

  async screenshot(
    filename = `screenshot-${nowJakarta('yyyyMMdd-HHmmss')}.png`,
  ): Promise<string> {
    return this.execute('screenshot', async () => {
      const filePath = await this.buildArtifactPath(filename);
      await this.page.screenshot({ path: filePath, fullPage: true });
      return filePath;
    });
  }

  async count(selector: string): Promise<number> {
    return this.execute('count', async () => {
      return this.page.locator(selector).count();
    });
  }

  locator(selector: string): Locator {
    return this.page.locator(selector);
  }

  getPage(): Page {
    return this.page;
  }

  getArtifactsDir(): string {
    return this.artifactsDir;
  }

  private resolveLocator(target: Locator | string): Locator {
    return typeof target === 'string' ? this.page.locator(target) : target;
  }

  private async execute<T>(
    action: string,
    task: () => Promise<T>,
  ): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (this.screenshotOnError) {
        const safeAction = action.replace(/\s+/g, '-');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `${safeAction}-error-${timestamp}.png`;
        try {
          const errorPath = await this.buildArtifactPath(fileName);
          await this.page.screenshot({ path: errorPath, fullPage: true });
        } catch (shotErr) {
          console.warn(
            `Failed to capture screenshot for ${action}:`,
            shotErr,
          );
        }
      }
      throw error;
    }
  }

  private async buildArtifactPath(filename: string): Promise<string> {
    const fullPath = path.isAbsolute(filename)
      ? filename
      : path.join(this.artifactsDir, filename);
    const directory = path.dirname(fullPath);
    await fs.mkdir(directory, { recursive: true });
    return fullPath;
  }

  private isNavigationAbortedError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const message = (error as { message?: string }).message ?? '';
    return message.includes('net::ERR_ABORTED');
  }

  private async waitForUrlMatch(targetUrl: string): Promise<boolean> {
    let target: URL | undefined;
    try {
      target = new URL(targetUrl);
    } catch {
      // ignore parse errors, fallback to simple comparison
    }

    if (this.urlsMatch(this.page.url(), targetUrl, target)) {
      return true;
    }

    try {
      await this.page.waitForURL(
        (current) => {
          return this.urlsMatch(current, targetUrl, target);
        },
        { timeout: this.defaultTimeoutMs },
      );
      await this.page
        .waitForLoadState('networkidle', {
          timeout: this.defaultTimeoutMs,
        })
        .catch(() => {});
      return true;
    } catch {
      return this.urlsMatch(this.page.url(), targetUrl, target);
    }
  }

  private urlsMatch(
    actual: string | URL,
    targetUrl: string,
    target?: URL,
  ): boolean {
    const normalizePath = (pathname: string): string => {
      if (!pathname) {
        return pathname;
      }
      return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
    };

    const normalizeHref = (href: string): string => {
      return href.endsWith('/') ? href.slice(0, -1) : href;
    };

    try {
      const actualUrl =
        actual instanceof URL ? actual : new URL(String(actual));
      if (!target) {
        const normalizedActual = normalizeHref(actualUrl.href);
        const normalizedTarget = normalizeHref(targetUrl);
        return (
          normalizedActual === normalizedTarget ||
          normalizedActual.startsWith(`${normalizedTarget}/`)
        );
      }
      return (
        actualUrl.origin === target.origin &&
        normalizePath(actualUrl.pathname).startsWith(
          normalizePath(target.pathname),
        )
      );
    } catch {
      return false;
    }
  }
}
