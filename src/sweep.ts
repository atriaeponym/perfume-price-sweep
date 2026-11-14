// The sweep: the price of every indexed page of one shop, oldest reading first, until the time budget runs out
// (supabase/migrations/0011_pp_ref_offer.sql). Each shop runs in its own job of the public collector repository,
// so the shops are read side by side, twice a day, each page at most once a day; within a shop, one page at a time, 2 s apart or the shop's crawl delay.
// Notino and Marionnaud are read with the runner's Chrome like their followed pages (collect.ts, BROWSER_HOSTS; the owner's
// decision, 12/11/2026). What the shop could not price is noted on the index row and read again at its next turn.

import { httpFetch, readableHere, shippingFor, type ShippingRule } from './collect.ts';
import { insert, remove, select, update, upsert } from './db.ts';
import { examineLink, type LinkProduct } from './links.ts';
import { robotsFor } from './requests.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// a shop that refuses this many pages in a row is left until the next run: its pages are not asked again and again
export const REFUSALS_IN_A_ROW = 20;

export interface Offer {
  key: string;
  brand: string;
  name: string;
  concentration: string;
  size_ml: number | null;
  ean: string | null;
  price: number;
  shipping: number | null;
  currency: string;
  availability: string;
}

/** The sizes of one page as stored: perfumes only, one row per EAN (else per size), the lowest price kept. */
export function offersOf(products: LinkProduct[], currency: string, rule: ShippingRule | null): Offer[] {
  const out = new Map<string, Offer>();
  for (const p of products) {
    const c = p.candidate;
    if (p.concentration === 'OTHER' || !(c.price > 0)) continue;
    const key = p.ean ? p.ean : p.sizeMl !== null ? `ml:${p.sizeMl}` : null;
    if (!key) continue;
    const seen = out.get(key);
    if (seen && seen.price <= c.price) continue;
    out.set(key, { key, brand: p.brand, name: p.name, concentration: p.concentration, size_ml: p.sizeMl,
      ean: p.ean, price: c.price, shipping: shippingFor(c.price, rule), currency: c.currency || currency,
      availability: c.availability });
  }
  return [...out.values()];
}

/** The price changes between what was stored and what was just read. */
export function changesOf(before: { key: string; price: number }[], after: Offer[]) {
  const old = new Map(before.map((o) => [o.key, Number(o.price)]));
  return after.filter((o) => old.has(o.key) && old.get(o.key) !== o.price)
    .map((o) => ({ key: o.key, old_price: old.get(o.key)!, new_price: o.price }));
}

/** The rows written for one page. Every row carries price_since (PostgREST refuses a batch whose rows have different
 *  keys, 13/11/2026): now for a new size or a new price, else the date already stored. */
export function rowsOf(url: string, merchant: string, before: { key: string; price: number; price_since: string | null }[],
  after: Offer[], now: string) {
  const old = new Map(before.map((b) => [b.key, b]));
  return after.map((o) => {
    const b = old.get(o.key);
    const since = b && Number(b.price) === o.price && b.price_since ? b.price_since : now;
    return { url, merchant_id: merchant, ...o, read_at: now, price_since: since };
  });
}

interface Shop { id: string; name: string; currency: string; shipping_rule: ShippingRule | null }

/** One part of a shop read side by side with the others (Notino, 13/11/2026: the whole shop in a day instead of
 *  three): part [k] of [n] takes the pages whose pp_index.shard (0 to 11, from the address) is k modulo n. */
export interface Part { k: number; n: number }

export async function sweep(merchant: string, budgetMin: number, part?: Part): Promise<void> {
  const end = Date.now() + budgetMin * 60e3;
  const [shop] = await select<Shop>(`pp_merchant?select=id,name,currency,shipping_rule&id=eq.${merchant}&active=is.true`);
  if (!shop) throw new Error(`no active shop ${merchant}`);
  let refusedInARow = 0;
  const counts = { read: 0, priced: 0, offers: 0, changes: 0, refused: 0, other: 0 };
  const started = Date.now();
  const shards = part ? `&shard=in.(${Array.from({ length: 12 }, (_, i) => i).filter((i) => i % part.n === part.k).join(',')})` : '';
  while (Date.now() < end) {
    // pages never read or read more than 20 hours ago: two runs a day, each page at most once a day
    const due = new Date(Date.now() - 20 * 3600e3).toISOString();
    const rows = (await select<{ url: string }>(`pp_index?select=url&merchant_id=eq.${merchant}&hidden=is.false${shards}` +
      `&or=(priced_at.is.null,priced_at.lt.${due})&order=priced_at.asc.nullsfirst,url.asc&limit=100`))
      .filter((r) => !seenThisRun.has(r.url));
    if (rows.length === 0) break;
    for (const { url } of rows) {
      if (Date.now() >= end) break;
      if (!readableHere(url)) { console.log(`${merchant}: not readable from this runner, stopped`); return report(); }
      seenThisRun.add(url);
      const robots = await robotsFor(url);
      const r = await examineLink(url, robots, httpFetch).catch((e) => ({ ok: false as const, reason: `error ${(e as Error).message}` }));
      const now = new Date().toISOString();
      counts.read++;
      if (r.ok) {
        const offers = offersOf(r.products, shop.currency, shop.shipping_rule);
        const before = await select<{ key: string; price: number; price_since: string | null }>(
          `pp_ref_offer?select=key,price,price_since&url=eq.${encodeURIComponent(url)}`);
        const changes = changesOf(before, offers);
        if (changes.length) await insert('pp_ref_change', changes.map((c) => ({ url, ...c, at: now })));
        if (offers.length) await upsert('pp_ref_offer', rowsOf(url, merchant, before, offers, now), 'url,key');
        const gone = before.filter((b) => !offers.some((o) => o.key === b.key)).map((b) => b.key);
        for (const key of gone) await remove('pp_ref_offer', `url=eq.${encodeURIComponent(url)}&key=eq.${encodeURIComponent(key)}`);
        await update('pp_index', `url=eq.${encodeURIComponent(url)}`, { priced_at: now, price_note: offers.length ? null : 'no perfume size' });
        refusedInARow = 0;
        if (offers.length) counts.priced++;
        counts.offers += offers.length;
        counts.changes += changes.length;
      } else {
        if (r.reason === 'blocked' || r.reason === 'robots') counts.refused++; else counts.other++;
        refusedInARow = r.reason === 'blocked' ? refusedInARow + 1 : 0;
        await update('pp_index', `url=eq.${encodeURIComponent(url)}`, { priced_at: now, price_note: r.reason });
      }
      if (counts.read % 100 === 0) report();
      if (refusedInARow >= REFUSALS_IN_A_ROW) { console.log(`${merchant}: ${refusedInARow} pages refused in a row, left until the next run`); return report(); }
      const delay = Math.max(2, robots.crawlDelaySeconds ?? 0);
      await sleep(delay * 1000 + Math.random() * 500);
    }
  }
  report();

  function report() {
    const min = (Date.now() - started) / 60e3;
    console.log(`${shop.name}${part ? ` (part ${part.k + 1}/${part.n})` : ''}: ${counts.read} pages read in ${min.toFixed(1)} min (${(min * 60 / Math.max(1, counts.read)).toFixed(1)} s each), ` +
      `${counts.priced} priced, ${counts.offers} sizes, ${counts.changes} price changes, ${counts.refused} refused, ${counts.other} without price`);
  }
}

const seenThisRun = new Set<string>();
