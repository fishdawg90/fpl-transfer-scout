export const GW_WEIGHTS = [1, 0.95, 0.9, 0.85, 0.8];
export const POSITION = { 1: "GKP", 2: "DEF", 3: "MID", 4: "FWD" };

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
export const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export function interpolateCurrentWeight(minutes) {
  const anchors = [[0, 0.05], [90, 0.1], [270, 0.25], [600, 0.4], [900, 0.5], [1800, 0.67], [2700, 0.82]];
  const value = Math.max(0, number(minutes));
  for (let i = 1; i < anchors.length; i += 1) {
    const [rightMinutes, rightWeight] = anchors[i];
    const [leftMinutes, leftWeight] = anchors[i - 1];
    if (value <= rightMinutes) {
      const progress = (value - leftMinutes) / (rightMinutes - leftMinutes);
      return leftWeight + progress * (rightWeight - leftWeight);
    }
  }
  return 0.85;
}

export function poissonExpectedFloor(lambda, divisor, max = 18) {
  const safeLambda = Math.max(0, number(lambda));
  let probability = Math.exp(-safeLambda);
  let expected = 0;
  for (let n = 0; n <= max; n += 1) {
    if (n > 0) probability *= safeLambda / n;
    expected += Math.floor(n / divisor) * probability;
  }
  return expected;
}

export function poissonTail(lambda, threshold, max = 45) {
  const safeLambda = Math.max(0, number(lambda));
  let probability = Math.exp(-safeLambda);
  let below = 0;
  for (let n = 0; n < Math.min(threshold, max); n += 1) {
    if (n > 0) probability *= safeLambda / n;
    below += probability;
  }
  return clamp(1 - below, 0, 1);
}

export function sellingPrice(purchasePrice, nowCost) {
  const bought = number(purchasePrice, nowCost);
  const current = number(nowCost);
  if (current <= bought) return current;
  return bought + Math.floor((current - bought) / 2);
}

export function inferFreeTransfers(historyRows, chips = [], maxFreeTransfers = 5) {
  const chipEvents = new Set(chips.filter(chip => ["wildcard", "freehit"].includes(chip.name)).map(chip => chip.event));
  let freeTransfers = 1;
  const rows = [...historyRows].sort((a, b) => a.event - b.event);
  for (const row of rows.filter(item => item.event >= 2)) {
    if (!chipEvents.has(row.event)) {
      const transfers = number(row.event_transfers);
      const paid = Math.floor(number(row.event_transfers_cost) / 4);
      const freeUsed = Math.max(0, transfers - paid);
      freeTransfers = Math.max(0, freeTransfers - freeUsed);
    }
    freeTransfers = Math.min(maxFreeTransfers, freeTransfers + 1);
  }
  return freeTransfers;
}

export function weightedTotal(fixtures, offset = 0) {
  return fixtures.slice(offset, offset + 5).reduce((total, fixture, index) => {
    return total + number(fixture.xPts) * GW_WEIGHTS[index];
  }, 0);
}

export function validatePlan(edges, squad, bank, teamLimit = 3) {
  const outgoing = new Set();
  const incoming = new Set();
  const teams = new Map();
  for (const player of squad) teams.set(player.team, (teams.get(player.team) || 0) + 1);
  let remaining = number(bank);
  for (const edge of edges) {
    if (outgoing.has(edge.out.id) || incoming.has(edge.in.id)) return false;
    if (squad.some(player => player.id === edge.in.id) && !outgoing.has(edge.in.id)) return false;
    outgoing.add(edge.out.id);
    incoming.add(edge.in.id);
    remaining += edge.sellPrice - edge.in.nowCost;
    teams.set(edge.out.team, (teams.get(edge.out.team) || 0) - 1);
    teams.set(edge.in.team, (teams.get(edge.in.team) || 0) + 1);
  }
  return remaining >= 0 && [...teams.values()].every(count => count <= teamLimit);
}
