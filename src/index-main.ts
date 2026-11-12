// Entry point of the public sweep repository: rebuilds the search index from the shops' sitemaps (sitemaps.ts)
import { closeBrowser } from './collect.ts';
import { buildIndex } from './sitemaps.ts';

await buildIndex(process.argv[2]);
await closeBrowser();
