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

export function completedPlayerHistory(historyRows, completedFixtureIds) {
  const completed = completedFixtureIds instanceof Set ? completedFixtureIds : new Set(completedFixtureIds || []);
  return [...(historyRows || [])]
    .filter(row => completed.has(number(row.fixture)))
    .sort((a, b) => number(a.round) - number(b.round));
}

function priceTimingLabel(dayOffset, approximate = false) {
  if (dayOffset <= 0) return "Tonight 00:00";
  if (dayOffset === 1) return "Tomorrow 00:00";
  return `${approximate ? "~" : "In "}${dayOffset} days · 00:00`;
}

export function priceForecast(currentPercent, projections = [], lockedUntil = null, now = new Date()) {
  const current = round(number(currentPercent), 1);
  const lockedDate = lockedUntil ? new Date(lockedUntil) : null;
  if (lockedDate && Number.isFinite(lockedDate.getTime()) && lockedDate > new Date(now)) {
    return {
      direction: "locked",
      currentPercent: current,
      midnightPercent: current,
      meterPercent: 0,
      timing: "Price locked",
      timingKind: "locked",
      lockedUntil: lockedDate.toISOString()
    };
  }

  const rows = projections
    .map(item => ({ offset: Math.max(0, Math.round(number(item.offset))), percent: round(number(item.projected_percent), 1) }))
    .filter(item => Number.isFinite(item.percent))
    .sort((a, b) => a.offset - b.offset);
  const tonight = rows.find(item => item.offset === 0)?.percent ?? current;
  const lastProjection = rows.at(-1)?.percent ?? tonight;
  const changingDirection = Math.abs(tonight) >= 2 && Math.abs(lastProjection) >= 2 && Math.sign(tonight) !== Math.sign(lastProjection);
  const signal = Math.abs(tonight) >= 2 ? tonight : Math.abs(lastProjection) >= 2 ? lastProjection : current;
  const direction = changingDirection ? "steady" : signal > 0 ? "rise" : signal < 0 ? "fall" : "steady";
  const target = direction === "rise" ? 100 : direction === "fall" ? -100 : 0;
  const crosses = value => direction === "rise" ? value >= target : direction === "fall" ? value <= target : false;
  const firstCrossing = rows.find(item => crosses(item.percent));

  let timing = "Not imminent";
  let timingKind = "not-imminent";
  let estimatedDays = null;
  if (changingDirection) {
    timing = "Direction changing";
    timingKind = "reversing";
  } else if (crosses(current) || firstCrossing) {
    estimatedDays = crosses(current) ? 0 : firstCrossing.offset;
    timing = priceTimingLabel(estimatedDays);
    timingKind = "official-projection";
  } else if (rows.length >= 2 && direction !== "steady") {
    const first = rows[0];
    const last = rows.at(-1);
    const daySpan = Math.max(1, last.offset - first.offset);
    const progressPerDay = (Math.abs(last.percent) - Math.abs(first.percent)) / daySpan;
    if (progressPerDay > 0.5 && Math.abs(last.percent) >= 25) {
      estimatedDays = Math.ceil(last.offset + (100 - Math.abs(last.percent)) / progressPerDay);
      if (estimatedDays <= 7) {
        timing = priceTimingLabel(estimatedDays, true);
        timingKind = "trend-estimate";
      } else {
        timing = "7+ days";
        timingKind = "trend-estimate";
      }
    } else if (rows.length) {
      timing = `Not within ${rows.at(-1).offset + 1} days`;
    }
  }

  return {
    direction,
    currentPercent: current,
    midnightPercent: round(tonight, 1),
    meterPercent: round(clamp(Math.abs(tonight), 0, 100), 1),
    timing,
    timingKind,
    estimatedDays,
    lockedUntil: null
  };
}

export function inferFreeTransfers(historyRows, chips = [], maxFreeTransfers = 5, startedEvent = 1) {
  const chipEvents = new Set(chips.filter(chip => ["wildcard", "freehit"].includes(chip.name)).map(chip => chip.event));
  let freeTransfers = 1;
  const rows = [...historyRows].sort((a, b) => a.event - b.event);
  for (const row of rows.filter(item => item.event > Math.max(1, number(startedEvent, 1)))) {
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

export function selectLineup(squad, fixtureIndex = 0) {
  const points = player => number(player.fixtures?.[fixtureIndex]?.xPts);
  const rank = (a, b) => points(b) - points(a) || number(b.expectedMinutes) - number(a.expectedMinutes);
  const byPosition = position => squad.filter(player => player.position === position).sort(rank);
  const goalkeepers = byPosition("GKP");
  if (!goalkeepers.length) return null;

  let best = null;
  for (let defenders = 3; defenders <= 5; defenders += 1) {
    for (let midfielders = 2; midfielders <= 5; midfielders += 1) {
      const forwards = 10 - defenders - midfielders;
      if (forwards < 1 || forwards > 3) continue;
      const starters = [
        goalkeepers[0],
        ...byPosition("DEF").slice(0, defenders),
        ...byPosition("MID").slice(0, midfielders),
        ...byPosition("FWD").slice(0, forwards)
      ].filter(Boolean);
      if (starters.length !== 11) continue;
      const starterPoints = starters.reduce((sum, player) => sum + points(player), 0);
      if (!best || starterPoints > best.starterPoints) {
        best = { starters, starterPoints, formation: `${defenders}-${midfielders}-${forwards}` };
      }
    }
  }
  if (!best) return null;

  const captainOrder = [...best.starters].sort(rank);
  const starterIds = new Set(best.starters.map(player => player.id));
  const benchOutfield = squad.filter(player => player.position !== "GKP" && !starterIds.has(player.id)).sort(rank);
  return {
    ...best,
    captain: captainOrder[0],
    viceCaptain: captainOrder[1],
    benchGoalkeeper: goalkeepers.find(player => !starterIds.has(player.id)) || null,
    benchOutfield,
    projectedPoints: best.starterPoints + points(captainOrder[0])
  };
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
