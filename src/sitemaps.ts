// The search index (decision 9): every perfume page the tracked shops list in their public
// sitemaps, with a name to search on. Rebuilt every night; no page is read here, only the
// sitemaps, so the shops see a few requests a day. Prices are read when someone follows a result.

import { browserText, indexedHere, needsBrowser, USER_AGENT } from './collect.ts';
import { remove, select, selectAll, update, upsert } from './db.ts';
import { robotsFor } from './requests.ts';

export interface IndexEntry {
  url: string;
  name: string;
  search: string;
}

interface Shop {
  merchant: string;
  sitemaps: string[]; // sitemap indexes or plain sitemaps
  pick?: RegExp; // the sitemaps of an index that list products, when it also lists categories or articles
  keep: (url: string, title: string | null) => boolean;
  name: (url: string, title: string | null) => string;
}

// testers, gift sets, refills and samples are excluded (decision 8), and what is not a perfume
// (deodorant sticks, body and hair mists, after-shaves, diffusers: seen in the shops added on 02/11/2026)
const EXCLUDED = /\b(testeur|tester|coffret|gift ?set|recharge|refill|[eé]chantillon|sample|miniature|d[eé]odorant|gel douche|shower|lotion|cr[eè]me|cream|savon|soap|lait|body|bougie|candle|shampooing|shampoo|soin|s[eé]rum|masque|mask|gommage|huile|oil|spf|nettoyant|d[eé]maquillant|cheveux|hair|mascara|vernis|baume|balm|gel|d[eé]ostick|deo|brume|(?:body|hair|perfume|fragrance) mist|after ?shave|apr[eè]s ?rasage|diffuseur|capillaire)\b/i;
const PERFUME = /\b(parfum|parfums|perfume|toilette|cologne|edp|edt|edc|extrait|elixir)\b/i;
// a perfume kind named in full, where « elixir » alone is also a skin care or make-up name
const KIND = /eau de (parfum|toilette|cologne)|extrait|\bparfum\b|\bcologne\b|\bed[pct]\b/i;

const words = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
// spray words and the shop's own name say nothing about the perfume
const tidy = (s: string) => s.replace(/\b(vaporisateur|vaporis[eé]e?|vapor|vapo|spray|sabina)\b/gi, ' ').replace(/\s+/g, ' ').trim();
// the last word of the address, before a trailing slash or a bare product number (Lookfantastic)
const slugOf = (url: string) =>
  decodeURIComponent(new URL(url).pathname.split('/').filter((s) => s && !/^\d+$/.test(s)).pop() ?? '').replace(/\.html?$/, '');
const partsOf = (url: string) => decodeURIComponent(new URL(url).pathname).split('/').filter(Boolean);
// the size at the end of an address: -100-ml, -100ml, -7-5-ml
const SIZE_END = /-\d+(?:[-.]\d+)?-?ml$/i;

/** Lower-case words without accents, as pp_search compares them. */
export function searchText(...parts: string[]): string {
  return parts.join(' ').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export const SHOPS: Shop[] = [
  {
    // /fr/tobacco-vanille-88F23X03.html: perfumes end in X + two digits; no brand in the address
    merchant: 'myorigines',
    sitemaps: ['https://www.my-origines.com/fr/sitemap_index.xml'],
    keep: (url) => /\/fr\/[^/]+X\d\d\.html$/.test(url) && !EXCLUDED.test(words(slugOf(url))),
    name: (url) => titleCase(words(slugOf(url).replace(/-[0-9A-Z]+X\d\d$/, ''))),
  },
  {
    // /431932-lattafa-khamrah-edp-100-ml.html, with the product title as the image title
    merchant: 'parfumdo',
    sitemaps: ['https://www.parfumdo.com/1_index_sitemap.xml'],
    keep: (url, title) => /\/\d+-[^/]+\.html$/.test(url) && /parfumdo\.com\/\d/.test(url) &&
      PERFUME.test(`${title ?? ''} ${words(slugOf(url))}`) && !EXCLUDED.test(`${title ?? ''} ${words(slugOf(url))}`),
    name: (url, title) => titleCase(tidy(title?.trim() || words(slugOf(url).replace(/^\d+-/, '')))),
  },
  {
    // /fr/parfums-pour-homme/7094-dior-sauvage-eau-de-parfum.html: the category says perfume
    merchant: 'sabina',
    sitemaps: ['https://www.sabina.com/sitemap_index_shop_1.xml'],
    keep: (url) => /\/fr\/[^/]*parfum[^/]*\/\d+-[^/]+\.html$/.test(url) && !EXCLUDED.test(words(slugOf(url))),
    name: (url) => titleCase(tidy(words(slugOf(url).replace(/^\d+-/, '')))),
  },
  {
    // /lattafa-khamrah-eau-de-parfum-unisexe-100-ml_z854810/: brand, name, kind, gender and size in the address
    merchant: 'parfumsetmoi',
    sitemaps: ['https://www.parfumsetmoi.fr/sitemap.xml'],
    pick: /\/sitemap_products\.xml$/,
    keep: (url) => /\/[^/]+_z\d+\/$/.test(url) && PERFUME.test(words(slugOf(url))) && !EXCLUDED.test(words(slugOf(url))),
    name: (url) => titleCase(words(slugOf(url).replace(/_z\d+$/, '').replace(SIZE_END, ''))),
  },
  {
    // /Max-Mara/Parfums-pour-femmes/Le-Parfum/Eau-de-parfum-vaporisateur/index_146481.aspx: brand, category,
    // line, then the kind of product, which says perfume; care, body and home categories left out
    merchant: 'parfumdreams',
    sitemaps: ['https://www.parfumdreams.fr/Sitemaps/sitemap.fr.xml'],
    pick: /\/Articles\.fr\d*\.xml$/,
    keep: (url) => {
      const p = partsOf(url);
      return p.length === 5 && /^index_\d+\.aspx$/.test(p[4]) && !/ambiance|soin|corps|cheveux|visage|barbe|aromath/i.test(p[1]) &&
        KIND.test(words(p[3])) &&
        !EXCLUDED.test(words(`${p[2]} ${p[3]}`));
    },
    name: (url) => {
      const p = partsOf(url);
      return titleCase(tidy(words(`${p[0]} ${p[2]} ${p[3]}`.replace(/\bvaporisateur\b/gi, ''))));
    },
  },
  {
    // /p/jean-paul-gaultier-le-male-eau-de-toilette-75ml/10021723/: brand and name in the address, no category
    merchant: 'lookfantastic',
    sitemaps: ['https://www.lookfantastic.fr/sitemapindex-product.xml.gz'],
    keep: (url) => /\/p\/[^/]+\/\d+\/$/.test(url) && KIND.test(words(slugOf(url))) && !EXCLUDED.test(words(slugOf(url))),
    name: (url) => titleCase(words(slugOf(url).replace(SIZE_END, ''))),
  },
  {
    // /fr/lattafa/khamrah-eau-de-parfum-vaporisateur/p_697214/: brand, then name and kind, in the address;
    // every product of the shop sits in one sitemap (sitemap-G), perfumes told apart by their kind
    merchant: 'perfumesclub',
    sitemaps: ['https://www.perfumesclub.fr/sitemap.xml'],
    pick: /\/sitemap-G\.xml$/,
    keep: (url) => {
      const p = partsOf(url);
      return p.length === 4 && p[0] === 'fr' && /^p_\d+$/.test(p[3]) && KIND.test(words(p[2])) && !EXCLUDED.test(words(p[2]));
    },
    name: (url) => {
      const p = partsOf(url);
      return titleCase(tidy(words(`${p[1]} ${p[2]}`)));
    },
  },
  {
    // /lattafa/khamrah-eau-de-parfum-mixte/: brand, then name, kind and gender; read with a browser (collect.ts).
    // One sitemap lists every perfume page, candles, sets and body sprays included
    merchant: 'notino',
    sitemaps: ['https://www.notino.fr/sitemap.xml'],
    pick: /\/sitemap_detail_parfemy_fr\.xml$/,
    keep: (url) => {
      const p = partsOf(url);
      return p.length === 2 && KIND.test(words(p[1])) && !EXCLUDED.test(words(p[1])) && !/\b(ensemble|set|ambiance|dambiance)\b/.test(words(p[1]));
    },
    name: (url) => {
      const p = partsOf(url);
      return titleCase(tidy(words(`${p[0]} ${p[1].replace(/-\d{5,}$/, '').replace(/-(pour-(homme|femme)|mixte)$/, '')}`)));
    },
  },
  {
    // /parfum/parfum-femme/eau-de-parfum/chloe-nomade-eau-de-parfum-chloe/p/BP_101380911: gender and kind in the
    // folders, name, kind and brand in the last word; read with a browser (collect.ts)
    merchant: 'marionnaud',
    sitemaps: ['https://www.marionnaud.fr/sitemap.xml'],
    pick: /\/Product-fr_FR-EUR$/,
    keep: (url) => {
      const p = partsOf(url);
      return p[0] === 'parfum' && p.at(-2) === 'p' && /^BP_\d+$/.test(p.at(-1)!) &&
        !p.some((x) => /coffret|produit-complementaire/.test(x)) && KIND.test(words(p.at(-3)!)) && !EXCLUDED.test(words(p.at(-3)!));
    },
    name: (url) => titleCase(tidy(words(partsOf(url).at(-3)!))),
  },
  {
    // /parfums/parfum-femme/opium/opium-eau-de-parfum-spray/231YSL.html: the brand's own shop, read from the owner's
    // Mac (collect.ts, HOME_HOSTS); gender or collection, line, then name and kind (one folder less in Le Vestiaire)
    merchant: 'yslbeauty',
    sitemaps: ['https://www.yslbeauty.fr/sitemap_index.xml'],
    pick: /\/sitemap_0-product\.xml$/,
    keep: (url) => {
      const p = partsOf(url);
      const name = p.at(-2) ?? '';
      return p[0] === 'parfums' && p.length >= 4 && /YSL\.html$/.test(p.at(-1)!) && KIND.test(words(name)) &&
        !EXCLUDED.test(words(name)) && !/coffret|set/.test(name);
    },
    name: (url) => `Yves Saint Laurent ${titleCase(tidy(words(partsOf(url).at(-2)!)))}`,
  },
  {
    // /produit/786-eau-sauvage-christian-dior-eau-de-toilette-spray-100-ml.html: perfumes under /produit/,
    // care and gift sets under their own folders (/soin-du-visage/, /cadeaux/)
    merchant: 'parfumsmoinschers',
    sitemaps: ['https://www.parfumsmoinschers.com/sitemap.xml'],
    pick: /products_sitemap/,
    keep: (url) => /\/produit\/\d+-[^/]+\.html$/.test(url) && PERFUME.test(words(slugOf(url))) && !EXCLUDED.test(words(slugOf(url))),
    name: (url) => titleCase(tidy(words(slugOf(url).replace(/^\d+-/, '').replace(SIZE_END, '')))),
  },
];

/** The <url> entries of a sitemap: address, and the first image title when there is one. */
export function parseSitemap(xml: string): { loc: string; title: string | null }[] {
  const out: { loc: string; title: string | null }[] = [];
  for (const block of xml.split(/<url>/).slice(1)) {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/.exec(block)?.[1];
    if (!loc) continue;
    const title = /<image:title>\s*(?:<!\[CDATA\[)?([^<\]]*)/.exec(block)?.[1]?.trim() || null;
    out.push({ loc, title });
  }
  return out;
}

/** The sitemaps an index lists (<sitemap><loc>…), French ones only when the index has languages. */
export function parseSitemapIndex(xml: string): string[] {
  // Lookfantastic writes <lastmod> before <loc>
  const all = [...xml.matchAll(/<sitemap>(?:(?!<\/sitemap>)[\s\S])*?<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/g)].map((m) => m[1]);
  const fr = all.filter((u) => /[_/-]fr[_/.-]/.test(u));
  return fr.length > 0 && fr.length < all.length ? fr : all;
}

async function fetchXml(url: string): Promise<string> {
  if (needsBrowser(url)) {
    const res = await browserText(url);
    if (res.status >= 400) throw new Error(`${url}: HTTP ${res.status}`);
    return res.text;
  }
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const raw = new Uint8Array(await res.arrayBuffer());
  // .xml.gz files are served as gzip archives, not with a gzip transfer encoding
  const gz = raw[0] === 0x1f && raw[1] === 0x8b;
  const bytes = gz ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : raw;
  return new TextDecoder().decode(bytes);
}

export function entriesOf(shop: Shop, items: { loc: string; title: string | null }[]): IndexEntry[] {
  const seen = new Map<string, IndexEntry>();
  for (const { loc, title } of items) {
    if (seen.has(loc) || !shop.keep(loc, title)) continue;
    const name = shop.name(loc, title);
    if (name.length < 2) continue;
    seen.set(loc, { url: loc, name, search: searchText(name, slugOf(loc), title ?? '') });
  }
  return [...seen.values()];
}

/** Whether a fresh sitemap read may replace the index: never empty, never under half of what is indexed. */
export const keepsIndex = (known: number, read: number) => read > 0 && read >= known / 2;

/** Rebuilds the index of every tracked shop; a page absent for a week is dropped. */
export async function buildIndex(only?: string) {
  const today = new Date().toISOString().slice(0, 10);
  for (const shop of SHOPS) {
    if (only && shop.merchant !== only) continue;
    if (!indexedHere(shop.sitemaps[0])) continue; // read by the other run (collect.ts)
    const robots = await robotsFor(shop.sitemaps[0]);
    if (robots.refused) {
      console.log(`${shop.merchant}: index skipped, robots.txt refused`);
      continue;
    }
    const items: { loc: string; title: string | null }[] = [];
    const queue = [...shop.sitemaps];
    try {
      while (queue.length > 0) {
        const url = queue.shift()!;
        const xml = await fetchXml(url);
        if (/<sitemapindex/.test(xml)) queue.push(...parseSitemapIndex(xml).filter((u) => !shop.pick || shop.pick.test(u)));
        else items.push(...parseSitemap(xml));
        await new Promise((r) => setTimeout(r, 1500)); // a few sitemaps, spaced out
      }
    } catch (err) {
      // one shop refusing its sitemaps must not stop the others, nor the prices read after the index
      console.log(`${shop.merchant}: index skipped, ${(err as Error).message}`);
      // the tile says « interrompue depuis le … » (pp_shop_states, 0010); the first day of refusal is kept
      await update('pp_merchant', `id=eq.${shop.merchant}&index_refused_since=is.null`, { index_refused_since: today });
      continue;
    }
    await update('pp_merchant', `id=eq.${shop.merchant}&index_refused_since=not.is.null`, { index_refused_since: null });
    const entries = entriesOf(shop, items).filter((e) => robots.allowed(e.url));
    const known = (await selectAll<{ url: string }>(`pp_index?select=url&merchant_id=eq.${shop.merchant}&order=url`)).length;
    if (!keepsIndex(known, entries.length)) {
      // an empty or much shorter list is a refusal or a broken sitemap, not a shop that stopped selling: the index
      // stays as it is (Parfumdo, 12/11/2026: a week of empty lists from GitHub wiped its 2 175 references)
      console.log(`${shop.merchant}: index kept, ${entries.length} perfumes in the sitemaps against ${known} indexed`);
      continue;
    }
    for (let i = 0; i < entries.length; i += 500) {
      await upsert('pp_index', entries.slice(i, i + 500).map((e) => ({ ...e, merchant_id: shop.merchant, seen_on: today })), 'url');
    }
    // a shop indexed for the first time, or rebuilt after a loss, has no « new » references (added_on, 0010)
    if (entries.length > 0 && known < entries.length / 2) await update('pp_index', `merchant_id=eq.${shop.merchant}&added_on=eq.${today}`, { added_on: null });
    const week = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const stale = await select<{ url: string }>(`pp_index?select=url&merchant_id=eq.${shop.merchant}&seen_on=lt.${week}`);
    if (stale.length > 0) await remove('pp_index', `merchant_id=eq.${shop.merchant}&seen_on=lt.${week}`);
    console.log(`${shop.merchant}: ${items.length} pages in the sitemaps, ${entries.length} perfumes indexed, ${stale.length} dropped`);
  }
}

