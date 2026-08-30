# FPL Transfer Scout

An expected-points-first transfer adviser for FPL team **8927620**. It refreshes from the public FPL API every evening, deploys a phone-friendly dashboard to GitHub Pages, and assigns the repository owner a GitHub issue when a squad player is near a price fall.

## Decision order

1. Project each player independently across the next five gameweeks.
2. Optimise legal one-, two- and three-transfer plans using weighted xPts gain minus transfer-hit cost.
3. Select the best legal next-GW starting XI, captain, vice-captain and bench order after those transfers.
4. Use official FPL price projections only as an urgency layer.
5. Produce an indicative two-to-three-week roadmap, then rebuild it from scratch the next day.

Later fixtures are discounted with weights `1.00, 0.95, 0.90, 0.85, 0.80`. The dashboard exposes the appearance, goals, assists, clean-sheet, defensive-contribution, save, bonus and deduction components for every fixture.

## Data and model notes

- Current and previous-season per-90 rates are blended according to current minutes.
- Recent minutes and FPL availability data drive expected playing time.
- Live and unplayed fixtures are excluded from recent form until FPL marks them completed and publishes their player histories.
- Home/away opposition strength and completed results adjust attacking and clean-sheet projections.
- Defensive contribution thresholds are 10 actions for defenders and 12 for midfielders/forwards.
- New players with little or no Premier League history temporarily use `ep_next` as a partial prior.
- Team-specific attack/defence strength fields currently contain zeroes in the API, so the code automatically falls back to overall venue strength and completed results.

This is a transparent heuristic model, not a guarantee. Always check late injury and lineup news.

## Automation

The workflow runs at 20:05 Europe/London and again at 22:30 to capture late matches (using paired UTC schedules for BST/GMT). It tests the model, rebuilds `site/data/latest.json`, sends or resolves the 8pm GitHub issue alert, and deploys `site/` to Pages.

GitHub cannot see transfers made during an open gameweek through the public FPL API. Free transfers are therefore inferred from deadline history and the entry's actual starting Gameweek. If needed, add a repository Actions variable named `FPL_FREE_TRANSFERS` to override the inferred number temporarily.

The dashboard therefore lets the manager mark a recommended transfer—or a different squad change—as completed in that browser. Further advice is paused locally until the public squad resynchronises after the deadline.

## Local use

Requires Node.js 22 or newer.

```bash
npm test
npm run build
python3 -m http.server 8000 -d site
```

No FPL login or third-party price-change site is required. The app never makes transfers automatically.
