// One perfume, one entry: shops write the same brand their own way (« Giorgio Armani » / « Armani » /
// « Emporio Armani », « Tom Ford Beauty », « Yves St Laurent » / « YSL »). Two pages are the same perfume
// when the name and concentration are the same and the brands match by this rule (24/10/2026).

import { searchText } from './sitemaps.ts';

/** Short forms and house lines that the shops use for the same brand. */
const ALIASES: Record<string, string> = {
  'giorgio armani': 'armani', 'emporio armani': 'armani',
  ysl: 'yves saint laurent', jpg: 'jean paul gaultier', mfk: 'maison francis kurkdjian',
  ck: 'calvin klein', 'thierry mugler': 'mugler', 'paco rabanne': 'rabanne', 'hugo boss': 'boss',
  'd g': 'dolce gabbana',
};

/** The brand as compared: lower case, no accents, « st » = « saint », generic words left out. */
export function brandKey(brand: string): string {
  const k = searchText(brand).replace(/\bst\b/g, 'saint')
    .replace(/\b(beauty|parfums?|perfumes?|paris|fragrances?|cosmetics|the|de)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return ALIASES[k] ?? k;
}

/** Same brand: same key, or every word of one is in the other (« Armani » / « Armani Code » is not
 *  decided here: the perfume names must also be equal). */
export function sameBrand(a: string, b: string): boolean {
  const x = brandKey(a), y = brandKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const wx = x.split(' '), wy = y.split(' ');
  const [short, long] = wx.length <= wy.length ? [wx, wy] : [wy, wx];
  return short.every((w) => long.includes(w));
}

/** House line words some shops put before the name (Maison Margiela « Replica By The Fireplace »,
 *  Notino's « Armani Emporio Stronger With You Intensely », 05/11/2026). */
const LINE_WORDS = /\b(replica|emporio)\b/g;

/** The name as compared: lower case, no accents, without the line words. */
export function nameKey(name: string): string {
  return searchText(name).replace(LINE_WORDS, ' ').replace(/\s+/g, ' ').trim();
}

/** The name's words in alphabetical order: shops put the words of a long name in their own order
 *  (« Born In Roma Purple Melancholia Uomo » / « Uomo Born In Roma Purple Melancholia », 07/11/2026). */
const wordsKey = (name: string) => nameKey(name).split(' ').sort().join(' ');

/** Same perfume: same name words in any order, same concentration, matching brands. */
export function samePerfume(a: { brand: string; name: string; concentration: string },
  b: { brand: string; name: string; concentration: string }): boolean {
  return a.concentration === b.concentration && wordsKey(a.name) === wordsKey(b.name) && sameBrand(a.brand, b.brand);
}

// How names are written (10/11/2026, a user: « Terre D' », « K By Dolce&gabbana », « Ck One »): the shop's
// capitals are kept for short words written in capitals (CK, YSL, MYSLF) unless the shop wrote the whole title in capitals,
// small linking words stay in lower case except at the start, a letter after « & » or « - » is a capital.
const SMALL = new Set(['de', 'du', 'des', 'd', 'l', 'sur', 'by', 'for', 'of', 'and', 'et', 'in', 'en', 'pour', 'à']);
const ARTICLES = new Set(['le', 'la', 'les', 'the']);

// names the houses write in capitals, whatever the shop did
const CAPITALS = new Set(['ck', 'ysl', 'myslf', 'dkny', 'jpg', 'mfk']);

/** `shouting`: the shop wrote the whole title in capitals, so its capitals say nothing. */
export function nameCase(text: string, shouting = false): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  words.forEach((w, i) => {
    if (CAPITALS.has(w.toLowerCase())) return out.push(w.toUpperCase());
    if (!shouting && /^\p{Lu}{2,5}$/u.test(w)) return out.push(w);
    const low = w.toLowerCase();
    const prev = out[i - 1] ?? '';
    if (i > 0 && (SMALL.has(low) || (ARTICLES.has(low) && SMALL.has(prev)))) return out.push(low);
    const elided = low.match(/^([dl])['’](.+)$/);
    if (elided) return out.push((i > 0 ? elided[1] : elided[1].toUpperCase()) + "'" + capitals(elided[2]));
    out.push(capitals(low));
  });
  return out.join(' ');
}

const capitals = (w: string) => w.replace(/(^|[-&(])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());

/** One spelling per house: the brand as the house writes it. */
const BRAND_NAMES: Record<string, string> = {
  armani: 'Giorgio Armani', 'yves saint laurent': 'Yves Saint Laurent', 'dolce gabbana': 'Dolce & Gabbana',
  'jean paul gaultier': 'Jean Paul Gaultier', 'calvin klein': 'Calvin Klein', marly: 'Parfums de Marly',
  'maison francis kurkdjian': 'Maison Francis Kurkdjian',
};

export function brandName(brand: string): string {
  return BRAND_NAMES[brandKey(brand)] ?? nameCase(brand, !/\p{Ll}/u.test(brand));
}

const LEADING_SHORT = new Set(['ysl', 'jpg', 'mfk']);

/** Collection titles some shops put before the name (Notino « Parfums Jardins Collection Un Jardin Sur Le Nil »). */
const COLLECTIONS = /^(parfums? )?jardins? collection\s+/i;

/** A stored or cleaned name as shown: collection title and a leading short form of the brand removed, cased. */
export function tidyName(name: string, brand: string, shouting = false): string {
  const words = name.replace(COLLECTIONS, '').trim().split(/\s+/);
  // only a short form (« YSL Myslf »): « Dior Homme » keeps its first word, and CK is part of « CK One »
  while (words.length > 1 && LEADING_SHORT.has(searchText(words[0])) && sameBrand(words[0], brand)) words.shift();
  return nameCase(words.join(' '), shouting);
}

// real perfumes whose whole name is shorter than three letters (Yves Saint Laurent « Y », 2017)
const SHORT_NAMES = new Set(['Yves Saint Laurent|Y']);

/** What a user must never see in a name (the audit and tools/verify.py print these). */
export function nameProblems(rows: { brand: string; name: string; concentration: string }[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const shown = `${r.brand} | ${r.name}`;
    if (/['’\-–&]$/.test(r.name) || SMALL.has(r.name.split(' ').at(-1)!.toLowerCase())) out.push(`name cut short: ${shown}`);
    if ((r.name.match(/\p{L}/gu) ?? []).length < 3 && !/\d/.test(r.name) && !SHORT_NAMES.has(`${r.brand}|${r.name}`)) out.push(`name too short: ${shown}`);
    if (brandName(r.brand) !== r.brand) out.push(`brand written « ${r.brand} », expected « ${brandName(r.brand)} »`);
    if (tidyName(r.name, r.brand) !== r.name) out.push(`name written « ${r.name} », expected « ${tidyName(r.name, r.brand)} » (${r.brand})`);
    // a collection title before a known name: the same perfume entered twice
    const twin = rows.find((o) => o !== r && o.concentration === r.concentration && sameBrand(o.brand, r.brand) &&
      nameKey(r.name).endsWith(' ' + nameKey(o.name)));
    if (twin) out.push(`same perfume twice: ${shown} / ${twin.name}`);
  }
  return out;
}
