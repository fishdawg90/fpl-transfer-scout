import test from "node:test";
import assert from "node:assert/strict";
import {
  completedPlayerHistory,
  inferFreeTransfers,
  interpolateCurrentWeight,
  poissonExpectedFloor,
  priceForecast,
  selectLineup,
  sellingPrice,
  validatePlan,
  weightedTotal
} from "../scripts/model.mjs";

test("season blend follows the requested anchor points", () => {
  assert.equal(interpolateCurrentWeight(90), 0.1);
  assert.equal(interpolateCurrentWeight(270), 0.25);
  assert.equal(interpolateCurrentWeight(900), 0.5);
  assert.equal(interpolateCurrentWeight(1800), 0.67);
});

test("FPL selling price keeps half of rises, rounded down", () => {
  assert.equal(sellingPrice(50, 53), 51);
  assert.equal(sellingPrice(50, 49), 49);
});

test("unplayed fixtures are excluded from recent player evidence", () => {
  const rows = [
    { round: 1, fixture: 10, minutes: 90 },
    { round: 2, fixture: 20, minutes: 0 }
  ];
  assert.deepEqual(completedPlayerHistory(rows, new Set([10])), [rows[0]]);
});

test("price forecast reports the first official midnight threshold crossing", () => {
  const forecast = priceForecast(-89, [
    { offset: 0, projected_percent: "-98.6" },
    { offset: 1, projected_percent: "-126.8" },
    { offset: 2, projected_percent: "-155.1" }
  ]);
  assert.equal(forecast.direction, "fall");
  assert.equal(forecast.timing, "Tomorrow 00:00");
  assert.equal(forecast.timingKind, "official-projection");
});

test("price forecast can cautiously extend a consistent three-day trend", () => {
  const forecast = priceForecast(40, [
    { offset: 0, projected_percent: "45" },
    { offset: 1, projected_percent: "55" },
    { offset: 2, projected_percent: "65" }
  ]);
  assert.equal(forecast.timing, "~6 days · 00:00");
  assert.equal(forecast.timingKind, "trend-estimate");
});

test("price forecast does not extrapolate through a direction reversal", () => {
  const forecast = priceForecast(25, [
    { offset: 0, projected_percent: "17.8" },
    { offset: 1, projected_percent: "-2.3" },
    { offset: 2, projected_percent: "-16.3" }
  ]);
  assert.equal(forecast.direction, "steady");
  assert.equal(forecast.timing, "Direction changing");
});

test("free transfers roll and respect paid transfers", () => {
  const rows = [
    { event: 2, event_transfers: 0, event_transfers_cost: 0 },
    { event: 3, event_transfers: 2, event_transfers_cost: 0 }
  ];
  assert.equal(inferFreeTransfers(rows, [], 5), 1);
});

test("a team starting in GW2 does not receive a GW1 rollover", () => {
  const rows = [{ event: 2, event_transfers: 0, event_transfers_cost: 0 }];
  assert.equal(inferFreeTransfers(rows, [], 5, 2), 1);
});

test("lineup selection uses a legal formation and names the best captain", () => {
  let id = 0;
  const make = (position, xPts) => ({ id: ++id, name: `P${id}`, position, expectedMinutes: 90, fixtures: [{ xPts }] });
  const squad = [
    make("GKP", 4), make("GKP", 2),
    make("DEF", 5), make("DEF", 4), make("DEF", 3), make("DEF", 2), make("DEF", 1),
    make("MID", 10), make("MID", 8), make("MID", 6), make("MID", 2), make("MID", 1),
    make("FWD", 9), make("FWD", 7), make("FWD", 1)
  ];
  const lineup = selectLineup(squad);
  assert.equal(lineup.formation, "4-4-2");
  assert.equal(lineup.starters.length, 11);
  assert.equal(lineup.captain.position, "MID");
  assert.equal(lineup.benchOutfield.length, 3);
});

test("weighted total discounts later fixtures", () => {
  assert.equal(weightedTotal([1, 1, 1, 1, 1].map(xPts => ({ xPts }))), 4.5);
});

test("save and conceded expectations use scoring bands", () => {
  assert.ok(poissonExpectedFloor(4.2, 3) > 0.8);
});

test("plan validation enforces budget and club limits", () => {
  const squad = [{ id: 1, team: 1 }, { id: 2, team: 2 }, { id: 3, team: 3 }];
  const valid = [{ out: squad[0], in: { id: 4, team: 4, nowCost: 55 }, sellPrice: 50 }];
  assert.equal(validatePlan(valid, squad, 5), true);
});
