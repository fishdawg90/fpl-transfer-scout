# FPL Transfer Scout

An expected-points-first transfer adviser for FPL team **8927620**. It refreshes from the public FPL API every evening, deploys a phone-friendly dashboard to GitHub Pages, and assigns the repository owner a GitHub issue when a squad player is near a price fall.

## Decision order

1. Project each player independently across the next five gameweeks.
2. Optimise legal one-, two- and three-transfer plans using weighted xPts gain minus transfer-hit cost.
3. Use official FPL price projections only as an urgency layer.
4. Produce an indicative two-to-three-week roadmap, then rebuild it from scratch the next day.

Later fixtures are discounted with weights `1.00, 0.95, 0.90, 0.85, 0.80`. The dashboard exposes the appearance, goals, assists, clean-sheet, defensive-contribution, save, bonus and deduction components for every fixture.

## Data and model notes

- Current and previous-season per-90 rates are blended according to current minutes.
- Recent minutes and FPL availability data drive expected playing time.
- Home/away opposition strength and completed results adjust attacking and clean-sheet projections.
- Defensive contribution thresholds are 10 actions for defenders and 12 for midfielders/forwards.
- New players with little or no Premier League history temporarily use `ep_next` as a partial prior.
- Team-specific attack/defence strength fields currently contain zeroes in the API, so the code automatically falls back to overall venue strength and completed results.

This is a transparent heuristic model, not a guarantee. Always check late injury and lineup news.

## Automation

The workflow runs at 20:05 Europe/London (using paired UTC schedules for BST/GMT), tests the model, rebuilds `site/data/latest.json`, sends or resolves a deduplicated GitHub issue alert, and deploys `site/` to Pages.

GitHub cannot see transfers made during an open gameweek through the public FPL API. Free transfers are therefore inferred from deadline history. If needed, add a repository Actions variable named `FPL_FREE_TRANSFERS` to override the inferred number temporarily.

## Local use

Requires Node.js 22 or newer.

```bash
npm test
npm run build
python3 -m http.server 8000 -d site
```

No FPL login or third-party price-change site is required. The app never makes transfers automatically.
