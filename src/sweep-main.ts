// Entry point of the public sweep repository: node src/sweep-main.ts <shop id> [minutes]
import { closeBrowser } from './collect.ts';
import { sweep } from './sweep.ts';

await sweep(process.argv[2], Number(process.argv[3] ?? 330));
await closeBrowser();
