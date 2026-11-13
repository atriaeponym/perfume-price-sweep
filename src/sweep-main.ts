// Entry point of the public sweep repository: node src/sweep-main.ts <shop id>[.<k>of<n>] [minutes]
// « notino.0of3 »: the first of three parts of Notino, read side by side (sweep.ts, Part)
import { closeBrowser } from './collect.ts';
import { sweep } from './sweep.ts';

const [, shop, k, n] = /^([a-z0-9]+)(?:\.(\d+)of(\d+))?$/.exec(process.argv[2] ?? '') ?? [];
if (!shop) throw new Error(`shop expected, got ${process.argv[2]}`);
await sweep(shop, Number(process.argv[3] ?? 330), k ? { k: Number(k), n: Number(n) } : undefined);
await closeBrowser();
