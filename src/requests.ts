// Link requests (decision 16): the shops added from the app by pasting a product link.
// Shared by the command line (scheduled fallback) and the link-request Edge Function (at once).

import { browserText, collect, fileableHere, homeRetries, httpFetch, needsBrowser, readableHere, USER_AGENT, type Fetcher, type Result, type ShippingRule } from './collect.ts';
import { examineLink, type LinkProduct } from './links.ts';
import { insert, rpc, select, update, upsert } from './db.ts';
import { sameBrand, samePerfume } from './brands.ts';
import { parseRobots, type Robots } from './robots.ts';

const MIN_DELAY_S = 5;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const robotsCache = new Map<string, Robots>();
export async function robotsFor(pageUrl: string): Promise<Robots> {
  const origin = new URL(pageUrl).origin;
  let robots = robotsCache.get(origin);
  if (!robots) {
    let text = '';
    if (needsBrowser(pageUrl)) {
      // read the way its pages are; refused, the shop's pages are refused too and nothing is read
      const res = await browserText(`${origin}/robots.txt`);
      if (res.status >= 400) {
        // not kept: the next page tries again
        return { allowed: () => false, crawlDelaySeconds: null, refused: true };
      }
      text = res.text;
    } else {
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'User-Agent': USER_AGENT } }).catch(() => null);
      // no readable robots.txt: everything is allowed, per the robots convention
      text = res && res.ok ? await res.text() : '';
    }
    robots = parseRobots(text, USER_AGENT);
    robotsCache.set(origin, robots);
  }
  return robots;
}

/** Polite pause between two pages of the same shop. */
export async function pause(robots: Robots) {
  const s = Math.max(MIN_DELAY_S, robots.crawlDelaySeconds ?? 0);
  await sleep(s * 1000 + Math.random() * 3000);
}

export function line(shop: string, label: string, r: Result) {
  const price = r.price === null ? '-' : `${r.price.toFixed(2)} ${r.currency}`;
  console.log([shop.padEnd(11), label.padEnd(26), r.validity.padEnd(16), price.padEnd(12), r.note].join(' '));
}

interface MerchantRow { id: string; base_url: string; currency: string; reader: string; shipping_rule: ShippingRule | null }
interface VariantRow { id: string; ean: string | null; size_ml: number; fragrance_id: string }

const hostOf = (u: string) => new URL(u).hostname.replace(/^www\./, '');

/** The variant a product of a pasted page belongs to: by EAN, else by perfume and size. */
async function variantFor(p: LinkProduct, url: string, merchantId: string): Promise<VariantRow | null> {
  if (p.ean) {
    const [known] = await select<VariantRow>(`pp_variant?select=id,ean,size_ml,fragrance_id&ean=eq.${p.ean}`);
    if (known) return known;
  }
  if (p.sizeMl === null) return null;
  // the perfume already known under another spelling of its brand is reused (brands.ts)
  const known = await select<{ id: string; brand: string; name: string; concentration: string }>(
    `pp_fragrance?select=id,brand,name,concentration&concentration=eq.${encodeURIComponent(p.concentration)}`);
  // the sizes a shop sells on one page are one perfume, whatever name another page gave it (07/11/2026)
  const samePage = (await select<{ variant: { fragrance: { id: string; brand: string; concentration: string } } }>(
    `pp_listing?select=variant:pp_variant(fragrance:pp_fragrance(id,brand,concentration))&merchant_id=eq.${encodeURIComponent(merchantId)}&url=eq.${encodeURIComponent(url)}`))
    .map((l) => l.variant.fragrance).find((k) => k.concentration === p.concentration && sameBrand(k.brand, p.brand));
  const f = samePage ?? known.find((k) => samePerfume(k, p)) ?? (await upsert<{ id: string }>(
    'pp_fragrance', { brand: p.brand, name: p.name, concentration: p.concentration }, 'brand,name,concentration'))[0];
  const [same] = await select<VariantRow>(
    `pp_variant?select=id,ean,size_ml,fragrance_id&fragrance_id=eq.${f.id}&size_ml=eq.${p.sizeMl}&edition=eq.&kind=eq.standard`);
  if (same) {
    if (!same.ean && p.ean) await update('pp_variant', `id=eq.${same.id}`, { ean: p.ean });
    return same;
  }
  const [created] = await insert<VariantRow>(
    'pp_variant', { fragrance_id: f.id, size_ml: p.sizeMl, ean: p.ean, edition: '', kind: 'standard' });
  return created;
}

/** Files the pending requests, oldest first. `polite: false` skips the pause after the last page
 *  of each request (the Edge Function handles one request at a time). */
export async function processRequests({ id, polite = true }: { id?: string; polite?: boolean } = {}) {
  const pending = await select<{ id: string; url: string }>(
    'pp_link_request?select=id,url&status=eq.pending&order=created_at.asc&limit=20' + (id ? `&id=eq.${id}` : ''));
  if (pending.length === 0) return console.log('no link request');
  const merchants = await select<MerchantRow>('pp_merchant?select=id,base_url,currency,reader,shipping_rule');

  for (const req of pending) {
    // a link this run cannot read waits for the run that can: the scheduled one for the browser shops (the Edge
    // Function has no browser), the home run for the home shops and, refused on GitHub, the browser shops
    if (!fileableHere(req.url)) continue;
    const done = (patch: Record<string, unknown>) =>
      update('pp_link_request', `id=eq.${req.id}`, { ...patch, handled_at: new Date().toISOString() });
    // the page is fetched once and shared by the check and the first readings
    const pages = new Map<string, Promise<{ status: number; body: string }>>();
    const once: Fetcher = (u) => pages.get(u) ?? pages.set(u, httpFetch(u)).get(u)!;

    let robots: Robots;
    try {
      robots = await robotsFor(req.url);
    } catch {
      await done({ status: 'refused', reason: 'bad_url' });
      continue;
    }
    const r = await examineLink(req.url, robots, once);
    if (!r.ok) {
      if (r.reason === 'blocked' && homeRetries(req.url)) {
        console.log(`link left for the home run (blocked here): ${req.url}`);
        continue;
      }
      await done({ status: 'refused', reason: r.reason });
      console.log(`link refused (${r.reason}): ${req.url}`);
      continue;
    }

    let m = merchants.find((x) => hostOf(x.base_url) === r.shop.host);
    if (!m) {
      [m] = await insert<MerchantRow>('pp_merchant', {
        id: r.shop.host.replace(/[^a-z0-9]+/g, '-'), name: r.shop.name, base_url: r.shop.origin,
        country: r.shop.country, currency: r.shop.currency, reader: 'jsonld', added_by: 'user' });
      merchants.push(m);
    }

    // a page found through the search that is not a perfume leaves the search
    if (r.products.every((p) => p.concentration === 'OTHER') &&
        (await select<{ url: string }>(`pp_index?select=url&url=eq.${encodeURIComponent(req.url)}`)).length > 0) {
      await update('pp_index', `url=eq.${encodeURIComponent(req.url)}`, { hidden: true });
      await done({ status: 'refused', reason: 'not_perfume' });
      continue;
    }

    // a pasted link is a manual URL: it wins over the one known before
    const first = await fileProducts(req.url, 'manual', m, r.products, robots, once, r.shop.name);
    if (first) await done({ status: 'accepted', variant_id: first.variant, listing_id: first.listing });
    else await done({ status: 'refused', reason: 'no_size' });
    // the answer is given first: the other shops join the perfume a few seconds later
    if (first) await alsoElsewhere(r.products, m.id, merchants);
    if (polite) await pause(robots);
  }
}

/** Files every size of a page as a listing of its shop, with a first price; the first one is returned. */
async function fileProducts(url: string, source: 'manual' | 'auto', m: MerchantRow, products: LinkProduct[],
  robots: Robots, once: Fetcher, shopName: string): Promise<{ variant: string; listing: string } | null> {
  let first: { variant: string; listing: string } | null = null;
  for (const p of products) {
    const v = await variantFor(p, url, m.id);
    if (!v) continue;
    const [l] = await upsert<{ id: string }>('pp_listing',
      { variant_id: v.id, merchant_id: m.id, url, source, status: 'active' }, 'variant_id,merchant_id');
    first ??= { variant: v.id, listing: l.id };
    const res = await collect({
      url, reader: m.reader, currency: m.currency, shipping: m.shipping_rule,
      wanted: { sizeMl: Number(v.size_ml), ean: v.ean ?? p.ean, concentration: p.concentration },
      ownHistory: [], otherShops: [],
    }, robots, once);
    const observedAt = new Date().toISOString();
    await insert('pp_observation', {
      listing_id: l.id, observed_at: observedAt, price: res.price, shipping: res.shipping, currency: res.currency,
      availability: res.availability, validity: res.validity, note: res.note });
    await update('pp_listing', `id=eq.${l.id}`, { status: res.status, last_checked_at: observedAt, ...(res.image ? { image: res.image } : {}) });
    line(shopName, `${p.brand} ${p.name} ${p.sizeMl ?? '?'} ml`, res);
  }
  return first;
}

/** The tracked shops (decision 6) whose sitemaps feed the search index. */
const INDEXED = ['myorigines', 'parfumdo', 'sabina', 'parfumsetmoi', 'parfumdreams', 'lookfantastic', 'perfumesclub', 'parfumsmoinschers',
  'notino', 'marionnaud', 'yslbeauty'];

/** The same perfume in the other tracked shops, found through the search index: only a page whose
 *  name and concentration are those of the followed one, with the same brand, is filed (sizes by EAN or ml),
 *  one page per shop, at most three pages read per shop. Returns the number of shops added. */
export async function alsoElsewhere(products: LinkProduct[], fromMerchant: string, merchants: MerchantRow[]): Promise<number> {
  const p0 = products[0];
  if (!p0) return 0;
  const same = (p: LinkProduct) => samePerfume(p, p0);
  const found = await rpc<{ url: string; merchant_id: string }>('pp_search', { q: p0.name });
  let added = 0;
  for (const mid of INDEXED.filter((x) => x !== fromMerchant)) {
    const m = merchants.find((x) => x.id === mid);
    if (!m || !readableHere(m.base_url)) continue;
    for (const c of found.filter((x) => x.merchant_id === mid).slice(0, 3)) {
      const pages = new Map<string, Promise<{ status: number; body: string }>>();
      const once: Fetcher = (u) => pages.get(u) ?? pages.set(u, httpFetch(u)).get(u)!;
      const robots = await robotsFor(c.url);
      const r = await examineLink(c.url, robots, once).catch(() => null);
      // filed under the followed perfume's own brand and name, so that both shops share its sizes
      const matches = r?.ok ? r.products.filter(same).map((p) => ({ ...p, brand: p0.brand, name: p0.name })) : [];
      if (matches.length === 0) continue;
      if (await fileProducts(c.url, 'auto', m, matches, robots, once, mid)) added++;
      break;
    }
  }
  return added;
}

const CONCENTRATION_LABEL: Record<string, string> = {
  EDT: 'EDT', EDP: 'EDP', EDC: 'EDC', PARFUM: 'Parfum', EXTRAIT: 'Extrait',
};

/** Reads indexed pages not read yet, to show brand and concentration in the search; a page that
 *  sells no perfume leaves the search. The three shops are read side by side, each one page at a
 *  time with a 2 s pause (none of them sets a crawl delay), for about 100 s per call; a call made
 *  while another is still reading returns at once. */
export async function enrichIndex(budgetMs = 100_000): Promise<number> {
  const [last] = await select<{ checked_at: string }>('pp_index?select=checked_at&checked_at=not.is.null&order=checked_at.desc&limit=1');
  if (last && Date.now() - Date.parse(last.checked_at) < 10_000) return 0;
  const end = Date.now() + budgetMs;
  const counts = await Promise.all(INDEXED.map(async (merchant) => {
    const rows = await select<{ url: string }>(
      `pp_index?select=url&merchant_id=eq.${merchant}&checked_at=is.null&hidden=is.false&limit=60`);
    let n = 0;
    for (const row of rows) {
      if (Date.now() > end) break;
      if (!readableHere(row.url)) break;
      const robots = await robotsFor(row.url);
      if (robots.crawlDelaySeconds && robots.crawlDelaySeconds > 2) await sleep(robots.crawlDelaySeconds * 1000);
      const r = await examineLink(row.url, robots, httpFetch).catch(() => null);
      const patch: Record<string, unknown> = { checked_at: new Date().toISOString() };
      if (r?.ok) {
        const perfumes = r.products.filter((p) => p.concentration !== 'OTHER');
        if (perfumes.length === 0) patch.hidden = true;
        else {
          const kinds = [...new Set(perfumes.map((p) => CONCENTRATION_LABEL[p.concentration] ?? p.concentration))];
          patch.detail = [perfumes[0].brand, ...kinds].join(' · ');
        }
      } else if (r && ['no_size', 'no_product_data', 'gone'].includes(r.reason)) patch.hidden = true;
      await update('pp_index', `url=eq.${encodeURIComponent(row.url)}`, patch);
      n++;
      await sleep(2000 + Math.random() * 500);
    }
    return n;
  }));
  return counts.reduce((a, b) => a + b, 0);
}
