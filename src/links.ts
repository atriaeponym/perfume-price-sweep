// Decision 16: a shop added by pasting a product link. The page is accepted when
// robots.txt allows it and its JSON-LD publishes a price with its availability;
// otherwise the request is refused with a reason code the app translates.

import { brandName, tidyName } from './brands.ts';
import { isBlocked, isGone, concentrationsIn } from './checks.ts';
import type { Fetcher } from './collect.ts';
import { pageTitle, pictureOf, type Candidate } from './jsonld.ts';
import { readers } from './readers.ts';
import type { Robots } from './robots.ts';

export type RefusalCode =
  | 'bad_url' // not an https link
  | 'robots' // the shop's robots.txt forbids this page
  | 'blocked' // anti-bot page or access refused: never bypassed (decision 8)
  | 'unreachable' // network error or HTTP error
  | 'no_product_data' // no schema.org Product with an offer
  | 'no_availability' // offers without availability
  | 'no_size' // no offer with a size in ml or an EAN (or only testers, sets, refills)
  | 'gone' // the shop says the product no longer exists
  | 'not_perfume'; // found through the search, but the page sells no perfume (decision 9)

/** One buyable size of the page, ready to be filed as a perfume variant. */
export interface LinkProduct {
  brand: string;
  name: string;
  concentration: string;
  sizeMl: number | null;
  ean: string | null;
  candidate: Candidate;
}

export interface LinkShop {
  host: string; // without www
  origin: string;
  name: string;
  currency: string;
  country: string; // ISO 3166-1 from the domain, 'ZZ' when the domain says nothing
}

export type LinkResult = { ok: true; shop: LinkShop; products: LinkProduct[]; image?: string | null } | { ok: false; reason: RefusalCode };

// testers, gift sets, refills and samples are excluded (decision 8)
const EXCLUDED = /\b(testeur|tester|coffret|gift ?set|recharge|refill|[eé]chantillon|sample|miniature)\b/i;

const COUNTRY_BY_TLD: Record<string, string> = {
  fr: 'FR', be: 'BE', ch: 'CH', de: 'DE', at: 'AT', es: 'ES', it: 'IT', nl: 'NL', pt: 'PT', uk: 'GB',
  ie: 'IE', pl: 'PL', se: 'SE', dk: 'DK', fi: 'FI', no: 'NO', cz: 'CZ', gr: 'GR', ro: 'RO', hu: 'HU',
  ca: 'CA', us: 'US', br: 'BR', jp: 'JP', kr: 'KR', in: 'IN', ae: 'AE', sa: 'SA', tr: 'TR', ru: 'RU',
};

const titleCase = (s: string) =>
  s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());

/** Product name without its brand, concentration, size and spray words. */
export function cleanName(product: string, brand: string): string {
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = product
    // never inside the name: « Terre d'Hermès », « K by Dolce&Gabbana » (10/11/2026)
    .replace(new RegExp(`(?<!\\b(?:[dl]['’]|de |by |of ))\\b${escaped}\\b`, 'i'), ' ')
    .replace(/eau de parfum|eau de toilette|eau de cologne|extrait de parfum|\bextrait\b|\bedp\b|\bedt\b|\bedc\b/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*ml\b/gi, ' ')
    // « Eau de toilette envoûtante »: Parfumdo's adjective after the concentration is not part of the name
    .replace(/(^|\s)(vaporisateur|spray|mixte|unisex|envo[uû]tante?)(?=\s|$)/gi, ' ')
    .replace(/[\s\-–|,]+/g, ' ')
    .trim();
  return tidyName(name, brand, !/\p{Ll}/u.test(product));
}

function concentrationOf(c: Candidate, title: string, address = ''): string {
  // the page address last: some shops name the concentration only there (…-eau-de-parfum-lattafa.html)
  for (const text of [c.label, c.product, title, address]) {
    const found = concentrationsIn(text);
    if (found.length === 1) return found[0];
  }
  return /\bparfum\b/i.test(c.label + ' ' + c.product) ? 'PARFUM' : 'OTHER';
}

function shopName(host: string): string {
  const parts = host.split('.');
  const label = parts.length > 1 ? parts[parts.length - 2] : parts[0];
  return titleCase(label.replace(/-/g, ' '));
}

/** The priority shops (decision 6), by host: their pages are read as the collector reads them. */
const SHOP_READERS: Record<string, string> = {
  'my-origines.com': 'myorigines', 'parfumdo.com': 'parfumdo', 'sabina.com': 'sabina',
  'parfumsetmoi.fr': 'parfumsetmoi', 'perfumesclub.fr': 'perfumesclub', 'parfumdreams.fr': 'parfumdreams',
  'lookfantastic.fr': 'lookfantastic', 'parfumsmoinschers.com': 'parfumsmoinschers',
  'notino.fr': 'notino', 'marionnaud.fr': 'marionnaud', 'yslbeauty.fr': 'yslbeauty',
};

export async function examineLink(raw: string, robots: Robots, fetcher: Fetcher): Promise<LinkResult> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'bad_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'bad_url' };
  if (robots.refused) return { ok: false, reason: 'blocked' };
  if (!robots.allowed(url.href)) return { ok: false, reason: 'robots' };

  let page: { status: number; body: string };
  try {
    page = await fetcher(url.href);
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (isBlocked(page.status, page.body)) return { ok: false, reason: 'blocked' };
  if (page.status === 404 || page.status === 410 || isGone(page.body)) return { ok: false, reason: 'gone' };
  if (page.status >= 400) return { ok: false, reason: 'unreachable' };

  // a priority shop keeps its tailored reader (MyOrigines sizes are bare numbers); otherwise strict
  // JSON first, then the Parfumdo repair for shops that publish broken JSON-LD
  const host = url.hostname.replace(/^www\./, '');
  let list = readers[SHOP_READERS[host] ?? 'jsonld'](page.body);
  if (list.length === 0) list = readers.parfumdo(page.body);
  if (list.length === 0) return { ok: false, reason: 'no_product_data' };
  if (list.every((c) => c.availability === 'unknown')) return { ok: false, reason: 'no_availability' };

  const title = pageTitle(page.body);
  const products = list
    .filter((c) => c.brand && (c.sizeMl !== null || c.ean !== null) && !EXCLUDED.test(`${c.label} ${c.product}`))
    .map((c) => ({
      brand: brandName(c.brand!),
      name: cleanName(c.product, c.brand!),
      concentration: concentrationOf(c, title, decodeURIComponent(url.pathname).replace(/[-_/]+/g, ' ')),
      sizeMl: c.sizeMl,
      ean: c.ean,
      candidate: c,
    }))
    .filter((p) => p.name.length > 0);
  if (products.length === 0) return { ok: false, reason: 'no_size' };

  // the price must say its currency: never guessed
  const currency = list.find((c) => /^[A-Z]{3}$/.test(c.currency))?.currency;
  if (!currency) return { ok: false, reason: 'no_product_data' };

  const tld = host.split('.').pop() ?? '';
  return {
    ok: true,
    shop: {
      host,
      origin: url.origin,
      name: shopName(host),
      currency,
      country: COUNTRY_BY_TLD[tld] ?? 'ZZ',
    },
    products,
    image: pictureOf(page.body),
  };
}
