// One reader per shop. 'jsonld' is the generic reader used for shops the user
// adds himself (decision 16); the priority shops get tailored tweaks.
// Shop quirks were checked on real pages on 18/10/2026 (test/fixtures).

import { asArray, candidates, jsonLdBlocks, pageTitle, sizeFromText, type Candidate } from './jsonld.ts';

export type Reader = (html: string) => Candidate[];

const generic: Reader = (html) => candidates(jsonLdBlocks(html));

export const readers: Record<string, Reader> = {
  jsonld: generic,

  // Parfumdo (PrestaShop) emits invalid JSON: "unitPricingMeasure":""30 ml"".
  parfumdo: (html) => candidates(jsonLdBlocks(html, (raw) => raw.replace(/""([^",]*)""/g, '"$1"'))),

  // MyOrigines names its size offers "Sauvage 100" — a bare number, no "ml" — and says only in the
  // visible size list that one of them is a refill (« 100 ml Recharge 95,75 € », 24/10/2026): left out.
  // Since 02/11/2026 its JSON-LD carries only the size shown first, without a size: the size comes from
  // the list entry of the same sku, and the other sizes from the list itself.
  // « Rechargeable » is a refillable bottle, not a refill.
  // The stock of each size is in the page's tracking data: one EAN per size with « availability », in the order
  // of the size list (10/11/2026, Drakkar Noir and Sauvage: the default EAN is the size selected on the page). Used only
  // when the counts agree and the default EAN sits at the shown size, otherwise the stock stays unknown.
  myorigines: (html) => {
    const sizes = html.split(/Product-VariationCustom\?pid=/).slice(1).map((s) => {
      const text = s.slice(0, 1500).split('<input')[0].replace(/<[^>]+>/g, ' ').replace(/&#8364;|&euro;/g, '€').replace(/\s+/g, ' ');
      return { sku: s.match(/^\w+/)?.[0] ?? '', size: sizeFromText(text), refill: /\brecharge\b|\brefill\b/i.test(text),
        price: Number(text.match(/(\d+(?:,\d{2})?)\s*€/)?.[1].replace(',', '.')) };
    });
    const sku = html.match(/"@type":\s*"Product"[\s\S]*?"sku":\s*"(\w+)"/)?.[1];
    const eans = [...(html.match(/"eans":\s*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/\{[^}]*\}/g)].map((m) => ({
      ean: m[0].match(/"ean":\s*"(\d+)"/)?.[1] ?? null, inStock: /"availability":\s*true/.test(m[0]), main: /"default":\s*true/.test(m[0]) }));
    const aligned = eans.length > 0 && eans.length === sizes.length && eans.findIndex((e) => e.main) === sizes.findIndex((v) => v.sku === sku);
    const stockOf = (i: number) => aligned ? { ean: eans[i].ean, availability: eans[i].inStock ? 'available' as const : 'unavailable' as const }
      : { ean: null, availability: 'unknown' as const };
    const found = generic(html).map((c) => {
      if (c.sizeMl !== null) return c;
      const m = c.label.match(/\s(\d{1,4})$/);
      const size = m ? Number(m[1]) : sizeFromText(c.label) ?? sizes.find((v) => v.sku === sku)?.size ?? null;
      return { ...c, sizeMl: size };
    });
    // the size shown, when its JSON-LD offer has no EAN, takes the one of the tracking data
    const shown = sizes.findIndex((v) => v.sku === sku);
    if (found.length === 1 && found[0].ean === null && aligned) found[0] = { ...found[0], ean: eans[shown].ean };
    const first = found[0];
    const listed = first ? sizes.map((v, i) => ({ ...v, ...stockOf(i) }))
      .filter((v) => v.size !== null && v.price > 0 && !found.some((c) => c.sizeMl === v.size))
      .map((v) => ({ ...first, label: `${first.product} ${v.size} ml`, sizeMl: v.size, ean: v.ean, price: v.price, availability: v.availability }))
      : [];
    return [...found, ...listed].filter((c) => !sizes.some((v) => v.refill && v.size === c.sizeMl && v.price === c.price));
  },

  // Sabina publishes a ProductGroup with one variant per size, EAN included.
  sabina: generic,

  // Notino and Marionnaud refuse plain HTTP (HTTP 403) and are read with a browser since 04/11/2026
  // (browser.ts). Marionnaud: a ProductGroup with one variant per size, EAN included.
  // Notino: one Product with an offer per size, but a single gtin13, the one of the size shown first
  // (05/11/2026, Stronger With You Intensely: 5 sizes, one EAN); each offer's picture is named after its own
  // EAN (« …/armani/3614274347388_01-o/… »), which is taken instead. No picture EAN, no EAN.
  notino: (html) => candidates(jsonLdBlocks(html).map((node) => {
    const offers = asArray(node.offers);
    if (offers.length < 2) return node;
    const { gtin13: _one, ...rest } = node;
    return { ...rest, offers: offers.map((o) => {
      const ean = String(o.image ?? '').match(/\/(\d{13})_\d+-o\//)?.[1];
      return ean ? { ...o, gtin13: ean } : o;
    }) };
  })),
  marionnaud: generic,

  // Shops added on 02/11/2026, quirks checked on their real pages (test/fixtures).

  // Parfums et Moi: one Product per size page, EAN in gtin13.
  parfumsetmoi: generic,

  // Perfumes Club gives each size offer its EAN but writes the size only in a property
  // (« additionalProperty »: Contenido = "100 ml"), never in a name.
  perfumesclub: (html) => candidates(jsonLdBlocks(html).map((node) => !node.offers ? node : {
    ...node,
    offers: asArray(node.offers).map((o) => {
      const size = asArray(o.additionalProperty).find((p) => p.name === 'Contenido')?.value;
      return typeof size === 'string' ? { ...o, name: `${node.name ?? ''} ${size}` } : o;
    }),
  })),

  // Parfumdreams lists refills (« Recharge / 150 ml ») and sets (« … 50 ml + Travel Spray 10 ml »)
  // as variants of the perfume's ProductGroup: left out (decision 8).
  parfumdreams: (html) => generic(html).filter((c) => !/\b(recharge|refill|coffret|set|testeur|tester)\b|\+/i.test(c.label)),

  // Lookfantastic names every variant of its ProductGroup after the page's own size and leaves the
  // EAN and the brand out of its JSON-LD; the page data has them per sku ("sku":…,"title":…,"barcode":…).
  lookfantastic: (html) => {
    const unescape = (s: string) => { try { return JSON.parse(`"${s}"`) as string; } catch { return s; } };
    const data = new Map([...html.matchAll(/"sku":(\d+),"title":"((?:[^"\\]|\\.)*)","barcode":"(\d{8,14})"/g)]
      .map((m) => [m[1], { name: unescape(m[2]), gtin13: m[3] }]));
    const brands = new Map([...html.matchAll(/"item_id":(\d+),[^{}]*?"brand":"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => [m[1], unescape(m[2])]));
    return candidates(jsonLdBlocks(html).map((node) => {
      if (!node.hasVariant) return node;
      const variants = asArray(node.hasVariant);
      const brand = variants.map((v) => brands.get(String(v.sku))).find(Boolean);
      return { ...node, ...(brand ? { brand } : {}), hasVariant: variants.map((v) => ({ ...v, ...data.get(String(v.sku)) })) };
    }));
  },

  // YSL Beauté, the brand's own shop: a ProductGroup whose variants carry the size apart (« size »: "50 ml"),
  // the EAN as their sku, and the brand only as a reference to the site.
  yslbeauty: (html) => candidates(jsonLdBlocks(html).map((node) => !node.hasVariant ? node : {
    ...node,
    brand: 'Yves Saint Laurent',
    hasVariant: asArray(node.hasVariant).map((v) => ({ ...v, name: `${v.name ?? node.name ?? ''} ${v.size ?? ''}`.trim(),
      ...(typeof v.sku === 'string' && /^\d{13}$/.test(v.sku) ? { gtin13: v.sku } : {}) })),
  })),

  // Parfums Moins Chers names its Product after the line only (« Homme »): the size is in the page title
  // (« … en 75 ML pour Homme »), one size per page.
  parfumsmoinschers: (html) => {
    const size = sizeFromText(pageTitle(html));
    return generic(html).map((c) => (c.sizeMl === null ? { ...c, sizeMl: size } : c));
  },
};

export function readerFor(id: string): Reader {
  return readers[id] ?? generic;
}
