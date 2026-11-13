// Read one product page and turn it into one observation. Network access is
// injected so tests run on saved real pages.

import { isBlocked, isGone, outlierReason, pickVariant, type Wanted } from './checks.ts';
import type { Availability } from './jsonld.ts';
import { pageTitle, pictureOf } from './jsonld.ts';
import { readerFor } from './readers.ts';
import type { Robots } from './robots.ts';

// Our own name and contact, without the word « bot »: Sabina answers any « …bot » agent with a stale copy
// of its pages, where products it no longer sells still have a price (24/10/2026); the robots.txt groups
// written for « ParfumPocketBot » still apply (robots.ts).
export const USER_AGENT = 'ParfumPocket/0.2 (+https://atriaeponym.github.io; atria.eponym@gmail.com)';

export type Validity = 'ok' | 'variant_mismatch' | 'outlier' | 'blocked' | 'error';
export type ListingStatus = 'active' | 'mismatch' | 'blocked' | 'gone' | 'error';

/** Cheapest home delivery, one item (decision 7); fee null = not published. `steps`: a lower fee from
 *  an order amount on (Marionnaud: 5.95 up to 50, 2.95 from 50, free from 89). */
export interface ShippingRule {
  fee: number | null;
  free_from?: number;
  steps?: { from: number; fee: number }[];
}

export interface Target {
  url: string;
  reader: string;
  currency: string;
  shipping: ShippingRule | null;
  wanted: Wanted;
  ownHistory: number[];
  otherShops: number[];
}

export interface Result {
  price: number | null;
  shipping: number | null;
  currency: string;
  availability: Availability;
  validity: Validity;
  status: ListingStatus;
  note: string;
  /** The bottle's picture on the shop's page, when the page was read. */
  image?: string | null;
}

export type Fetcher = (url: string) => Promise<{ status: number; body: string }>;

// Shops read with a real browser (browser.ts), on the collector's runner only: the Edge Function has no
// browser and leaves their link requests to the scheduled run.
export const BROWSER_HOSTS = ['www.marionnaud.fr', 'www.notino.fr'];
// Shops that refuse every server, GitHub's and Supabase's alike, and serve only a home connection: read by the
// console Chrome on the owner's Mac, once a day (`run.ts home`, tools/home-collect.sh; owner's choice, 04/11/2026).
export const HOME_HOSTS = ['www.yslbeauty.fr'];
export const atHome = !('Deno' in globalThis) && process.env.HOME_CHROME === '1';
const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : '');
export const needsBrowser = (url: string) => BROWSER_HOSTS.includes(hostOf(url)) || HOME_HOSTS.includes(hostOf(url));
export const canBrowse = !('Deno' in globalThis);
// Shops that refuse GitHub's runners (or answer them an empty sitemap) but serve Supabase: their index and their
// prices are read by the link-request Edge Function only (0012, 0014; Parfumdo 12/11/2026, whose index the owner's Mac
// read until then; Parfums Moins Chers and Perfumes Club 13/11/2026, Cloudflare refusing GitHub since 03/11).
export const EDGE_HOSTS = ['www.parfumdo.com', 'www.parfumsmoinschers.com', 'www.perfumesclub.fr'];
const onEdge = 'Deno' in globalThis;
/** Whether this run rebuilds that shop's index: the Edge shops on the Edge Function only. */
export const indexedHere = (url: string) => EDGE_HOSTS.includes(hostOf(url)) ? onEdge : readableHere(url);
/** Whether this run reads that page: the home run reads only the home shops, the others never read them. */
export function readableHere(url: string): boolean {
  if (HOME_HOSTS.includes(hostOf(url))) return atHome;
  if (atHome) return false;
  return BROWSER_HOSTS.includes(hostOf(url)) ? canBrowse : true;
}
/** Whether this run files a link request for that page: the home run also files the browser shops' links,
 *  which GitHub's runners are sometimes refused (Notino, 05/11/2026: 3 tries out of 3). */
export const fileableHere = (url: string) => readableHere(url) || (atHome && BROWSER_HOSTS.includes(hostOf(url)));
/** A browser shop's refusal seen from GitHub is not final: the home run tries the link again. */
export const homeRetries = (url: string) => !atHome && BROWSER_HOSTS.includes(hostOf(url));
/** Whether a listing is read by this run: once per shop cycle, and a refused page at every run (every 3 hours on
 *  GitHub). The home run reads again every page GitHub's runners were refused, any shop: some refuse their
 *  addresses for hours and serve a home connection (Parfumdo, 05/11/2026: refused GitHub from 13:16 UTC, still at
 *  21:57, while it served the Mac; Notino and Marionnaud likewise). */
export function isDue(l: { url: string; status: string; last_checked_at: string | null;
  merchant: { active: boolean; frequency_hours: number } }, now: number): boolean {
  if (!l.merchant.active) return false;
  if (atHome && l.status === 'blocked') return true;
  if (!readableHere(l.url)) return false;
  return l.status === 'blocked' || !l.last_checked_at || now - Date.parse(l.last_checked_at) > (l.merchant.frequency_hours - 1) * 3600e3;
}
// a computed path, so that the Edge Function's bundler does not follow it
interface BrowserModule {
  browserFetch: Fetcher;
  browserText: (url: string) => Promise<{ status: number; text: string }>;
  closeBrowser: () => Promise<void>;
}
const browserModule = () => import(['.', 'browser.ts'].join('/')) as Promise<BrowserModule>;
export const browserFetch: Fetcher = async (url) => (await browserModule()).browserFetch(url);
export const browserText = async (url: string) => (await browserModule()).browserText(url);
export const closeBrowser = async () => { if (canBrowse) await (await browserModule()).closeBrowser(); };

export const httpFetch: Fetcher = async (url) => {
  if (needsBrowser(url)) return browserFetch(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'fr-FR,fr;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, body: await res.text() };
};

export function shippingFor(price: number, rule: ShippingRule | null): number | null {
  if (!rule) return null;
  if (rule.free_from !== undefined && price >= rule.free_from) return 0;
  const step = (rule.steps ?? []).filter((s) => price >= s.from).sort((a, b) => b.from - a.from)[0];
  return step ? step.fee : rule.fee;
}

function failure(currency: string, validity: Validity, status: ListingStatus, note: string): Result {
  return { price: null, shipping: null, currency, availability: 'unknown', validity, status, note };
}

export async function collect(target: Target, robots: Robots, fetcher: Fetcher): Promise<Result> {
  const { currency } = target;
  if (robots.refused) return failure(currency, 'blocked', 'blocked', 'refused by the shop (robots.txt)');
  if (!robots.allowed(target.url)) return failure(currency, 'blocked', 'blocked', 'robots.txt disallows this page');

  let page: { status: number; body: string };
  try {
    page = await fetcher(target.url);
  } catch (e) {
    return failure(currency, 'error', 'error', `fetch failed: ${(e as Error).message}`);
  }
  if (page.status === 404 || page.status === 410) return failure(currency, 'error', 'gone', `HTTP ${page.status}`);
  if (isBlocked(page.status, page.body)) return failure(currency, 'blocked', 'blocked', `refused by the shop (HTTP ${page.status})`);
  if (page.status >= 400) return failure(currency, 'error', 'error', `HTTP ${page.status}`);
  if (isGone(page.body)) return failure(currency, 'error', 'gone', 'the shop says the product was not found');

  const pick = pickVariant(readerFor(target.reader)(page.body), target.wanted, pageTitle(page.body));
  if (!pick.ok) return failure(currency, 'variant_mismatch', 'mismatch', pick.reason);

  const c = pick.candidate;
  if (c.currency && c.currency !== currency) {
    return failure(currency, 'error', 'error', `currency ${c.currency}, shop is set to ${currency}`);
  }
  const outlier = outlierReason(c.price, target.ownHistory, target.otherShops);
  return {
    price: c.price,
    shipping: shippingFor(c.price, target.shipping),
    currency,
    availability: c.availability,
    validity: outlier ? 'outlier' : 'ok',
    status: 'active',
    note: outlier ?? `matched by ${pick.by}: ${c.label}`,
    image: pictureOf(page.body),
  };
}
