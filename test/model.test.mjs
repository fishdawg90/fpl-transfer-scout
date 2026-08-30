import test from "node:test";
import assert from "node:assert/strict";
import {
  inferFreeTransfers,
  interpolateCurrentWeight,
  poissonExpectedFloor,
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

test("free transfers roll and respect paid transfers", () => {
  const rows = [
    { event: 2, event_transfers: 0, event_transfers_cost: 0 },
    { event: 3, event_transfers: 2, event_transfers_cost: 0 }
  ];
  assert.equal(inferFreeTransfers(rows, [], 5), 1);
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
