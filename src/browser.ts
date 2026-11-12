// Shops whose anti-bot service refuses any plain request, robots.txt included, but serves a real browser:
// their pages, robots.txt and sitemaps are read with the runner's own Google Chrome, headless, under a
// browser's name (the owner lifted decision 8 for them on 04/11/2026: one reading a day, no load on the shop).
// Checked from GitHub's runners on 04/11/2026: plain HTTP 403 on both, headless Chrome under its own
// « HeadlessChrome » name refused, the same Chrome under a browser's name served the product page.
// The shops are listed in collect.ts (BROWSER_HOSTS); this file is loaded only on demand, so the
// link-request Edge Function never imports it.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

let browser: Promise<Browser> | null = null;
// the home run drives the console Chrome already running on the owner's Mac,
// with its own profile and name, in a tab of its own closed after each page
const home = process.env.HOME_CHROME === '1';

/** A fresh window: a new private context on the runner, a new tab of the console Chrome at home. */
async function newWindow(): Promise<{ page: Page; close: () => Promise<void> }> {
  if (home) {
    browser ??= chromium.connectOverCDP('http://127.0.0.1:9333');
    const page = await (await browser).contexts()[0].newPage();
    return { page, close: () => page.close() };
  }
  browser ??= chromium.launch({ channel: 'chrome', headless: true });
  const b = await browser;
  const os = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
  const major = b.version().split('.')[0];
  const c: BrowserContext = await b.newContext({
    userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    locale: 'fr-FR',
  });
  return { page: await c.newPage(), close: () => c.close() };
}

const challenged = async (page: Page) => /just a moment|un instant|access denied/i.test(await page.title().catch(() => ''));

/** Opens a page and waits for the shop's own check (Notino's script reloads the page by itself). */
async function open(page: Page, url: string): Promise<number> {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 20 && (await challenged(page)); i++) await page.waitForTimeout(1000);
  if (await challenged(page)) return res?.status() ?? 403;
  // the check answers 403 before it lets the page through: what counts is the page finally shown
  return res && res.status() !== 403 ? res.status() : 200;
}

// From GitHub's runners Notino lets some fresh windows through and checks others, whatever their first page
// (04/11/2026: 2 of 5 windows got its sitemap): a refused reading is tried again in a new window, at most 3 times.
const ATTEMPTS = 3;
const later = () => new Promise((r) => setTimeout(r, 5000 + Math.random() * 5000));

/** A product page as the shop shows it to a first-time visitor, each try in a fresh window closed after. */
export async function browserFetch(url: string): Promise<{ status: number; body: string }> {
  let last = { status: 403, body: '' };
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i > 0) await later();
    const { page, close } = await newWindow();
    try {
      const status = await open(page, url);
      if (status < 400) await page.waitForSelector('script[type="application/ld+json"]', { state: 'attached', timeout: 10_000 }).catch(() => {});
      last = { status, body: await page.content() };
    } finally {
      await close();
    }
    if (last.status < 400) break;
  }
  return last;
}

/** A text file of the shop (robots.txt, sitemap), fetched from inside a fresh window opened on the shop's
 *  robots.txt; gzip archives unpacked. Refused, it is tried again in a new window. */
export async function browserText(url: string): Promise<{ status: number; text: string }> {
  let last = { status: 403, text: '' };
  for (let i = 0; i < ATTEMPTS; i++) {
    if (i > 0) await later();
    const { page, close } = await newWindow();
    try {
      await open(page, `${new URL(url).origin}/robots.txt`);
      // the window's check may still clear while this request runs: its own answer is what counts
      last = await page.evaluate(async (u) => {
        const res = await fetch(u);
        const raw = new Uint8Array(await res.arrayBuffer());
        const gz = raw[0] === 0x1f && raw[1] === 0x8b;
        const bytes = gz ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : raw;
        return { status: res.status, text: new TextDecoder().decode(bytes) };
      }, url);
    } catch {
      last = { status: 403, text: '' };
    } finally {
      await close();
    }
    if (last.status < 400 && !/<title>(just a moment|un instant)/i.test(last.text.slice(0, 2000))) break;
    last = { status: Math.max(last.status, 403), text: '' };
  }
  return last;
}

/** Closes the runner's Chrome; at home, only disconnects from the console Chrome, which keeps running. */
export async function closeBrowser() {
  if (browser) await (await browser).close();
  browser = null;
}
