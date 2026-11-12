// Decisions 7 and 8: pick the exact variant or refuse, flag blocked pages and
// outliers. A refused price is recorded with its reason, never shown as a price.

import type { Candidate } from './jsonld.ts';

export interface Wanted {
  sizeMl: number;
  ean: string | null;
  concentration: string; // EDT, EDP, ...
}

export type Pick =
  | { ok: true; candidate: Candidate; by: 'ean' | 'size' }
  | { ok: false; reason: string };

const CONCENTRATION_WORDS: Record<string, RegExp> = {
  EDC: /eau de cologne|\bcologne\b/i,
  EDT: /eau de toilette|\bedt\b/i,
  EDP: /eau de parfum|\bedp\b/i,
  EXTRAIT: /extrait|elixir/i,
  PARFUM: /\bparfum\b(?! ?(de|-))/i,
};

/** Concentrations named in a text, e.g. a page title. */
export function concentrationsIn(text: string): string[] {
  return Object.entries(CONCENTRATION_WORDS)
    .filter(([key, re]) => key !== 'PARFUM' && re.test(text))
    .map(([key]) => key);
}

export function pickVariant(list: Candidate[], wanted: Wanted, title: string): Pick {
  if (list.length === 0) return { ok: false, reason: 'no product data on the page' };

  const named = concentrationsIn(title);
  if (named.length > 0 && !named.includes(wanted.concentration)) {
    return { ok: false, reason: `page is ${named.join('/')}, wanted ${wanted.concentration}` };
  }

  if (wanted.ean) {
    const byEan = list.filter((c) => c.ean === wanted.ean);
    if (byEan.length === 1) return { ok: true, candidate: byEan[0], by: 'ean' };
    // the page lists EANs and ours is not among them: another product
    if (list.some((c) => c.ean)) return { ok: false, reason: `EAN ${wanted.ean} not on the page` };
  }

  const bySize = list.filter((c) => c.sizeMl === wanted.sizeMl);
  if (bySize.length === 1) return { ok: true, candidate: bySize[0], by: 'size' };
  if (bySize.length > 1) return { ok: false, reason: `${bySize.length} offers for ${wanted.sizeMl} ml` };
  return { ok: false, reason: `no ${wanted.sizeMl} ml offer (${list.map((c) => c.sizeMl ?? '?').join(', ')} ml)` };
}

/** Anti-bot or access refusal: never bypassed, reported as blocked. A reCAPTCHA site key set up for the
 *  shop's forms is not a challenge (Perfumes Club, « RecaptchaKey » on every product page, 02/11/2026). */
export function isBlocked(status: number, html: string): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  return /just a moment|<title>un instant|enable javascript and cookies|cf_chl_opt|captcha(?!Key)|access denied/i.test(html.slice(0, 5000));
}

/** The shop says the product no longer exists, while the page may still carry its old JSON-LD
 *  (Sabina, 24/10/2026: « Le produit n'a pas été trouvé » above a priced ProductGroup). */
export function isGone(html: string): boolean {
  const text = html.replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&eacute;/g, 'é');
  return /alert-danger[\s\S]{0,600}?(produit n'a pas été trouvé|product (?:was )?not found|produit introuvable)/i.test(text) ||
    /<title>[^<]*(page introuvable|page not found|erreur 404|error 404)/i.test(text);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * A price far from this listing's own history, or from the other shops' current
 * prices for the same variant, is held back as an outlier.
 */
export function outlierReason(price: number, ownHistory: number[], otherShops: number[]): string | null {
  if (ownHistory.length >= 3) {
    const m = median(ownHistory);
    if (price < 0.5 * m || price > 2 * m) return `price ${price} vs own median ${m}`;
  }
  if (otherShops.length >= 2) {
    const m = median(otherShops);
    if (price < 0.4 * m || price > 2.5 * m) return `price ${price} vs other shops median ${m}`;
  }
  return null;
}
