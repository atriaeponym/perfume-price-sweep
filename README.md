# perfume-price-sweep

Reads the public price of every perfume listed in the sitemaps of a few French online perfume shops, once a day,
for the Perfume Price Tracker app by Atria.Eponym. Only pages the shop's robots.txt allows, one page at a time,
2 seconds apart or the shop's crawl delay, under its own name; a shop that refuses is left alone until the next run.

Run by GitHub Actions (`.github/workflows/sweep.yml`): `node src/sweep-main.ts <shop> [minutes]`.

Contact: atria.eponym@gmail.com — Atria.Eponym, independent developer based in France.
