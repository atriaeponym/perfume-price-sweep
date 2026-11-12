// Product data from schema.org JSON-LD.
// Origin: 19-parfum-tracker/server/src/scraping/extract.ts (JSON-LD first,
// AggregateOffer, @graph, "refuse rather than record a wrong price"), rewritten
// without Playwright: pages are plain HTML strings here.

export type Availability = 'available' | 'unavailable' | 'unknown';

/** One buyable size found on a page. */
export interface Candidate {
  label: string;
  /** Product name and brand as the page publishes them, to file a new perfume. */
  product: string;
  brand: string | null;
  sizeMl: number | null;
  ean: string | null;
  price: number;
  currency: string;
  availability: Availability;
}

type Node = Record<string, unknown>;

export function parsePrice(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  const m = raw.replace(/\s/g, '').replace(',', '.').match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function sizeFromText(text: string): number | null {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*ml\b/i);
  return m ? Number(m[1].replace(',', '.')) : null;
}

function availabilityOf(raw: unknown): Availability {
  const s = String(raw ?? '');
  if (!s) return 'unknown';
  if (/InStock|LimitedAvailability|OnlineOnly|PreOrder/i.test(s)) return 'available';
  if (/OutOfStock|SoldOut|Discontinued/i.test(s)) return 'unavailable';
  return 'unknown';
}

function isType(node: Node, type: string): boolean {
  const t = node['@type'];
  return t === type || (Array.isArray(t) && t.includes(type));
}

export function asArray(v: unknown): Node[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is Node => !!x && typeof x === 'object');
}

function gtinOf(node: Node): string | null {
  for (const key of ['gtin13', 'gtin', 'gtin14', 'gtin12', 'gtin8', 'ean']) {
    const v = node[key];
    if (typeof v === 'string' && /^\d{8,14}$/.test(v)) return v;
  }
  // PrestaShop shops often put the EAN in the offer sku
  const sku = node.sku;
  if (typeof sku === 'string' && /^\d{12,14}$/.test(sku)) return sku;
  return null;
}

export function jsonLdBlocks(html: string, repair: (raw: string) => string = (s) => s): Node[] {
  const out: Node[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(repair(m[1]));
    } catch {
      continue;
    }
    const queue = asArray(parsed);
    while (queue.length) {
      const node = queue.shift()!;
      out.push(node);
      queue.push(...asArray(node['@graph']));
    }
  }
  return out;
}

function brandOf(node: Node): string | null {
  const b = node.brand;
  const name = typeof b === 'string' ? b : b && typeof b === 'object' ? (b as Node).name : null;
  return typeof name === 'string' && name.trim() ? name.replace(/\s+/g, ' ').trim() : null;
}

function offerCandidates(offers: unknown, parentLabel: string, parentEan: string | null,
  product = parentLabel, brand: string | null = null): Candidate[] {
  const out: Candidate[] = [];
  for (const offer of asArray(offers)) {
    if (isType(offer, 'AggregateOffer') && offer.offers) {
      out.push(...offerCandidates(offer.offers, parentLabel, parentEan, product, brand));
      continue;
    }
    const price = parsePrice(offer.price ?? offer.lowPrice);
    if (price === null) continue;
    const label = String(offer.name ?? parentLabel).replace(/\s+/g, ' ').trim();
    const sizeText = [offer.name, offer.unitPricingMeasure, parentLabel].map((x) => String(x ?? '')).join(' ');
    out.push({
      label,
      product,
      brand,
      sizeMl: sizeFromText(sizeText),
      ean: gtinOf(offer) ?? parentEan,
      price,
      currency: String(offer.priceCurrency ?? ''),
      availability: availabilityOf(offer.availability),
    });
  }
  return out;
}

/** Every buyable size of the page, from Product and ProductGroup nodes. */
export function candidates(nodes: Node[]): Candidate[] {
  const out: Candidate[] = [];
  for (const node of nodes) {
    const label = String(node.name ?? '').replace(/\s+/g, ' ').trim();
    if (isType(node, 'ProductGroup')) {
      for (const v of asArray(node.hasVariant)) {
        const vLabel = String(v.name ?? label).replace(/\s+/g, ' ').trim();
        out.push(...offerCandidates(v.offers, vLabel, gtinOf(v), label, brandOf(v) ?? brandOf(node)));
      }
    } else if (isType(node, 'Product')) {
      out.push(...offerCandidates(node.offers, label, gtinOf(node), label, brandOf(node)));
    }
  }
  return out;
}

export function pageTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

function imageUrl(raw: unknown): string | null {
  for (const v of Array.isArray(raw) ? raw : [raw]) {
    const url = typeof v === 'string' ? v : v && typeof v === 'object' ? ((v as Node).contentUrl ?? (v as Node).url) : null;
    if (typeof url === 'string' && /^https:\/\//.test(url) && !/logo/i.test(url)) return url;
  }
  return null;
}

/** The product's picture as the shop publishes it (the tile shows the bottle, owner's choice, 10/11/2026): the Product's
 *  image, else its first variant's, else the page's og:image, else the first picture named « image » in the page. */
export function pictureOf(html: string): string | null {
  for (const node of jsonLdBlocks(html)) {
    if (!isType(node, 'Product') && !isType(node, 'ProductGroup')) continue;
    const url = imageUrl(node.image) ?? asArray(node.hasVariant).map((v) => imageUrl(v.image)).find(Boolean);
    if (url) return url;
  }
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og && /^https:\/\//.test(og[1]) && !/logo/i.test(og[1])) return og[1].replace(/&amp;/g, '&');
  const any = [...html.matchAll(/"image"\s*:\s*\[?\s*"(https:(?:\\\/|[^"])+)"/g)].map((m) => m[1].replace(/\\\//g, '/'))
    .find((u) => !/logo/i.test(u));
  return any ?? null;
}
