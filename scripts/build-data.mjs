import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import {
  GW_WEIGHTS,
  POSITION,
  clamp,
  inferFreeTransfers,
  interpolateCurrentWeight,
  number,
  poissonExpectedFloor,
  poissonTail,
  priceForecast,
  round,
  sellingPrice,
  validatePlan,
  weightedTotal
} from "./model.mjs";

const API = "https://fantasy.premierleague.com/api";
const ENTRY_ID = number(process.env.FPL_ENTRY_ID, 8927620);
const FETCH_CONCURRENCY = number(process.env.FPL_FETCH_CONCURRENCY, 18);
const OUTPUT = new URL("../site/data/latest.json", import.meta.url);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fetchJson(path, optional = false) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        headers: { "User-Agent": "fpl-transfer-scout/1.0 (+https://github.com/fishdawg90/fpl-transfer-scout)" }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      await delay(350 * (2 ** attempt));
    }
  }
  if (optional) return null;
  throw new Error(`FPL request failed for ${path}: ${lastError?.message}`);
}

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function makeTeamModels(teams, fixtures) {
  const finished = fixtures.filter(fixture => fixture.finished && fixture.team_h_score != null && fixture.team_a_score != null);
  const homeGoalAverage = finished.length ? finished.reduce((sum, fixture) => sum + fixture.team_h_score, 0) / finished.length : 1.55;
  const awayGoalAverage = finished.length ? finished.reduce((sum, fixture) => sum + fixture.team_a_score, 0) / finished.length : 1.25;
  const stats = new Map(teams.map(team => [team.id, { home: { games: 0, gf: 0, ga: 0 }, away: { games: 0, gf: 0, ga: 0 } }]));
  for (const fixture of finished) {
    const home = stats.get(fixture.team_h).home;
    const away = stats.get(fixture.team_a).away;
    home.games += 1;
    home.gf += fixture.team_h_score;
    home.ga += fixture.team_a_score;
    away.games += 1;
    away.gf += fixture.team_a_score;
    away.ga += fixture.team_h_score;
  }
  const specificAvailable = teams.some(team => number(team.strength_attack_home) > 0 && number(team.strength_defence_home) > 0);
  const specificAttackAverage = specificAvailable
    ? teams.reduce((sum, team) => sum + number(team.strength_attack_home) + number(team.strength_attack_away), 0) / (teams.length * 2)
    : 1;
  const specificDefenceAverage = specificAvailable
    ? teams.reduce((sum, team) => sum + number(team.strength_defence_home) + number(team.strength_defence_away), 0) / (teams.length * 2)
    : 1;

  const models = new Map();
  for (const team of teams) {
    const venues = {};
    for (const venue of ["home", "away"]) {
      const sample = stats.get(team.id)[venue];
      const baseline = venue === "home" ? homeGoalAverage : awayGoalAverage;
      const overall = number(team[`strength_overall_${venue}`], 3);
      const attackPrior = specificAvailable
        ? number(team[`strength_attack_${venue}`]) / specificAttackAverage
        : 0.68 + overall * 0.105;
      const vulnerabilityPrior = specificAvailable
        ? specificDefenceAverage / Math.max(1, number(team[`strength_defence_${venue}`]))
        : 1.32 - overall * 0.105;
      const sampleWeight = sample.games / (sample.games + 6);
      const actualAttack = sample.games ? (sample.gf / sample.games) / baseline : attackPrior;
      const actualVulnerability = sample.games ? (sample.ga / sample.games) / (venue === "home" ? awayGoalAverage : homeGoalAverage) : vulnerabilityPrior;
      venues[venue] = {
        attack: clamp(attackPrior * (1 - sampleWeight) + actualAttack * sampleWeight, 0.62, 1.42),
        vulnerability: clamp(vulnerabilityPrior * (1 - sampleWeight) + actualVulnerability * sampleWeight, 0.62, 1.42),
        sample: sample.games
      };
    }
    models.set(team.id, venues);
  }
  return { models, specificAvailable, homeGoalAverage, awayGoalAverage, finishedMatches: finished.length };
}

function aggregate(rows, field) {
  return rows.reduce((sum, row) => sum + number(row[field]), 0);
}

function playerProfile(element, summary) {
  const history = [...(summary?.history || [])].sort((a, b) => a.round - b.round);
  const past = (summary?.history_past || []).find(row => row.season_name === "2025/26") || null;
  const currentMinutes = number(element.minutes);
  const pastMinutes = number(past?.minutes);
  const currentWeight = interpolateCurrentWeight(currentMinutes);
  const position = POSITION[element.element_type];
  const positionPriors = {
    GKP: { expected_goals: 0.005, expected_assists: 0.01, bonus: 0.22, defensive_contribution: 0, saves: 3.1 },
    DEF: { expected_goals: 0.055, expected_assists: 0.075, bonus: 0.25, defensive_contribution: 8.2, saves: 0 },
    MID: { expected_goals: 0.22, expected_assists: 0.19, bonus: 0.3, defensive_contribution: 6.5, saves: 0 },
    FWD: { expected_goals: 0.39, expected_assists: 0.16, bonus: 0.32, defensive_contribution: 3.5, saves: 0 }
  }[position];

  const rate = field => {
    const prior = positionPriors[field] || 0;
    const currentRate = currentMinutes > 0 ? number(element[field]) * 90 / currentMinutes : prior;
    const rawPastRate = pastMinutes > 0 ? number(past[field]) * 90 / pastMinutes : prior;
    const pastCredibility = pastMinutes / (pastMinutes + 450);
    const pastRate = rawPastRate * pastCredibility + prior * (1 - pastCredibility);
    return currentRate * currentWeight + pastRate * (1 - currentWeight);
  };

  const recent = history.slice(-5);
  const weights = recent.map((_, index) => index + 1);
  const weightSum = weights.reduce((sum, value) => sum + value, 0) || 1;
  const weighted = getter => recent.reduce((sum, row, index) => sum + getter(row) * weights[index], 0) / weightSum;
  const availability = element.chance_of_playing_next_round != null
    ? number(element.chance_of_playing_next_round) / 100
    : ({ a: 1, d: 0.72, i: 0.2, s: 0.35, u: 0.05, n: 0.05 }[element.status] ?? 0.8);
  let expectedMinutes;
  const pastStarts = number(past?.starts);
  const pastAppearancesEstimate = pastStarts > 0 ? pastStarts : pastMinutes / 78;
  const pastRoleMinutes = pastMinutes >= 180
    ? clamp(pastMinutes / Math.max(1, pastAppearancesEstimate), 20, 90)
    : null;
  const currentRoleMinutes = currentMinutes > 0
    ? clamp(currentMinutes / Math.max(1, number(element.starts) + Math.max(0, history.filter(row => number(row.minutes) > 0 && !number(row.starts)).length)), 15, 90)
    : null;
  const rolePrior = pastRoleMinutes ?? currentRoleMinutes ?? (number(element.ep_next) >= 2.5 ? 65 : 20);
  if (recent.length) {
    const recentMinutes = weighted(row => number(row.minutes));
    const recentWeight = recent.length / (recent.length + 2.5);
    expectedMinutes = recentMinutes * recentWeight + rolePrior * (1 - recentWeight);
  } else if (currentMinutes > 0) {
    expectedMinutes = rolePrior;
  } else {
    expectedMinutes = rolePrior;
  }
  expectedMinutes = clamp(expectedMinutes * availability, 0, 90);
  const recentPlay = recent.length ? weighted(row => number(row.minutes) > 0 ? 1 : 0) : expectedMinutes / 70;
  const recentSixty = recent.length ? weighted(row => number(row.minutes) >= 60 ? 1 : 0) : (expectedMinutes - 20) / 55;
  const evidenceWeight = recent.length / (recent.length + 2.5);
  const playProbability = clamp((recentPlay * availability) * evidenceWeight + (expectedMinutes / 70) * (1 - evidenceWeight), 0, 1);
  const sixtyProbability = clamp((recentSixty * availability) * evidenceWeight + ((expectedMinutes - 20) / 55) * (1 - evidenceWeight), 0, playProbability);

  return {
    position,
    history,
    past,
    currentWeight,
    expectedMinutes,
    playProbability,
    sixtyProbability,
    availability,
    rates: {
      xg: rate("expected_goals"),
      xa: rate("expected_assists"),
      bonus: rate("bonus"),
      defcon: rate("defensive_contribution"),
      saves: rate("saves"),
      yellows: rate("yellow_cards"),
      reds: rate("red_cards"),
      ownGoals: rate("own_goals"),
      penaltiesMissed: rate("penalties_missed"),
      penaltiesSaved: rate("penalties_saved")
    },
    confidence: pastMinutes >= 900 ? "high" : currentMinutes >= 600 ? "medium" : currentMinutes >= 180 || pastMinutes > 0 ? "medium" : "low"
  };
}

function projectFixture(element, profile, fixture, teams, teamModels, index, scoring) {
  const isHome = fixture.team_h === element.team;
  const opponentId = isHome ? fixture.team_a : fixture.team_h;
  const opponent = teams.get(opponentId);
  const opponentVenue = isHome ? "away" : "home";
  const ownVenue = isHome ? "home" : "away";
  const opponentModel = teamModels.models.get(opponentId)[opponentVenue];
  const ownModel = teamModels.models.get(element.team)[ownVenue];
  const attackModifier = clamp(opponentModel.vulnerability, 0.65, 1.35);
  const minutes = profile.expectedMinutes;
  const minutesShare = minutes / 90;
  const position = profile.position;
  const goalPoints = number(scoring.goals_scored?.[position], { GKP: 10, DEF: 6, MID: 5, FWD: 4 }[position]);
  const csPoints = number(scoring.clean_sheets?.[position], { GKP: 4, DEF: 4, MID: 1, FWD: 0 }[position]);
  const opponentBaseline = opponentVenue === "home" ? teamModels.homeGoalAverage : teamModels.awayGoalAverage;
  const expectedConceded = clamp(opponentBaseline * opponentModel.attack * ownModel.vulnerability, 0.35, 2.8);
  const cleanSheetProbability = Math.exp(-expectedConceded);
  const threshold = position === "DEF" ? 10 : 12;
  const components = {
    appearance: profile.playProbability + profile.sixtyProbability,
    goals: profile.rates.xg * minutesShare * attackModifier * goalPoints,
    assists: profile.rates.xa * minutesShare * attackModifier * number(scoring.assists, 3),
    cleanSheet: csPoints * cleanSheetProbability * profile.sixtyProbability,
    defensiveContribution: position === "GKP" ? 0 : number(scoring.defensive_contribution?.[position], 2) * poissonTail(profile.rates.defcon * minutesShare, threshold),
    saves: position === "GKP" ? number(scoring.saves, 1) * poissonExpectedFloor(profile.rates.saves * minutesShare * clamp(opponentModel.attack, 0.75, 1.3), 3) : 0,
    bonus: clamp(profile.rates.bonus * minutesShare * (0.88 + 0.12 * (position === "GKP" || position === "DEF" ? 1 + cleanSheetProbability : attackModifier)), 0, 2.2),
    deductions: 0,
    prior: 0
  };
  components.deductions -= profile.rates.yellows * minutesShare * Math.abs(number(scoring.yellow_cards, -1));
  components.deductions -= profile.rates.reds * minutesShare * Math.abs(number(scoring.red_cards, -3));
  components.deductions -= profile.rates.ownGoals * minutesShare * Math.abs(number(scoring.own_goals, -2));
  components.deductions -= profile.rates.penaltiesMissed * minutesShare * Math.abs(number(scoring.penalties_missed, -2));
  components.deductions += profile.rates.penaltiesSaved * minutesShare * number(scoring.penalties_saved, 5);
  if (["GKP", "DEF"].includes(position)) {
    components.deductions -= poissonExpectedFloor(expectedConceded * minutesShare, 2) * Math.abs(number(scoring.goals_conceded?.[position], -1));
  }
  let xPts = Object.values(components).reduce((sum, value) => sum + value, 0);
  if (!profile.past && number(element.ep_next) > 0) {
    const priorWeight = clamp(0.55 * (1 - number(element.minutes) / 600), 0, 0.55) * (0.35 ** index);
    const fplPrior = number(element.ep_next);
    components.prior = (fplPrior - xPts) * priorWeight;
    xPts += components.prior;
  }
  return {
    event: fixture.event,
    opponent: opponent.short_name,
    venue: isHome ? "H" : "A",
    kickoff: fixture.kickoff_time,
    expectedMinutes: round(minutes, 0),
    attackModifier: round(attackModifier, 2),
    cleanSheetProbability: round(cleanSheetProbability * 100, 0),
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, round(value, 2)])),
    xPts: round(xPts, 2)
  };
}

function combineGameweekFixtures(projected, eventId) {
  const rows = projected.filter(fixture => fixture.event === eventId);
  if (!rows.length) return { event: eventId, label: `GW${eventId}`, opponents: "—", expectedMinutes: 0, components: {}, xPts: 0 };
  const components = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row.components)) components[key] = (components[key] || 0) + value;
  }
  return {
    event: eventId,
    label: `GW${eventId}`,
    opponents: rows.map(row => `${row.opponent} (${row.venue})`).join(" + "),
    expectedMinutes: rows.reduce((sum, row) => sum + row.expectedMinutes, 0),
    attackModifier: round(rows.reduce((sum, row) => sum + row.attackModifier, 0) / rows.length, 2),
    cleanSheetProbability: rows.length === 1 ? rows[0].cleanSheetProbability : null,
    components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, round(value, 2)])),
    xPts: round(rows.reduce((sum, row) => sum + row.xPts, 0), 2)
  };
}

function formatMove(edge) {
  return `${edge.out.name} → ${edge.in.name}`;
}

function projectedSquadScore(squad, offset = 0) {
  let total = 0;
  for (let gwIndex = offset; gwIndex < Math.min(offset + 5, 5); gwIndex += 1) {
    const points = player => number(player.fixtures[gwIndex]?.xPts);
    const byPosition = position => squad.filter(player => player.position === position).sort((a, b) => points(b) - points(a));
    const goalkeepers = byPosition("GKP");
    let best = -Infinity;
    let bestSelected = [];
    for (let defenders = 3; defenders <= 5; defenders += 1) {
      for (let midfielders = 2; midfielders <= 5; midfielders += 1) {
        const forwards = 10 - defenders - midfielders;
        if (forwards < 1 || forwards > 3) continue;
        const selected = [goalkeepers[0], ...byPosition("DEF").slice(0, defenders), ...byPosition("MID").slice(0, midfielders), ...byPosition("FWD").slice(0, forwards)].filter(Boolean);
        if (selected.length !== 11) continue;
        const score = selected.reduce((sum, player) => sum + points(player), 0);
        if (score > best) { best = score; bestSelected = selected; }
      }
    }
    if (!bestSelected.length) continue;
    const selectedIds = new Set(bestSelected.map(player => player.id));
    const benchCover = squad.filter(player => !selectedIds.has(player.id)).reduce((sum, player) => sum + points(player) * 0.1, 0);
    const captainBonus = Math.max(...bestSelected.map(points));
    total += (best + benchCover + captainBonus) * GW_WEIGHTS[gwIndex - offset];
  }
  return total;
}

function optimiseTransfers(squad, allPlayers, bank, freeTransfers, teamLimit) {
  const edges = [];
  for (const outgoing of squad) {
    const candidates = allPlayers
      .filter(player => player.position === outgoing.position && !squad.some(member => member.id === player.id))
      .filter(player => player.canTransact && !["u", "n"].includes(player.status))
      .filter(player => player.expectedMinutes >= 25 || player.epNext >= 2.5)
      .map(incoming => ({
        out: outgoing,
        in: incoming,
        sellPrice: outgoing.sellPrice,
        delta: incoming.weighted5 - outgoing.weighted5
      }))
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 6);
    edges.push(...candidates);
  }
  const pool = edges.sort((a, b) => b.delta - a.delta).slice(0, 70);
  const plans = [];
  const baseSquadScore = projectedSquadScore(squad);
  function visit(start, chosen, size) {
    if (chosen.length === size) {
      if (!validatePlan(chosen, squad, bank, teamLimit)) return;
      const outgoingIds = new Set(chosen.map(edge => edge.out.id));
      const resultingSquad = [
        ...squad.filter(player => !outgoingIds.has(player.id)),
        ...chosen.map(edge => edge.in)
      ];
      const rawGain = projectedSquadScore(resultingSquad) - baseSquadScore;
      const hitCost = Math.max(0, size - freeTransfers) * 4;
      const spend = chosen.reduce((sum, edge) => sum + edge.in.nowCost - edge.sellPrice, 0);
      plans.push({ edges: [...chosen], rawGain, hitCost, netGain: rawGain - hitCost, spend });
      return;
    }
    for (let index = start; index < pool.length; index += 1) {
      const edge = pool[index];
      if (chosen.some(item => item.out.id === edge.out.id || item.in.id === edge.in.id)) continue;
      visit(index + 1, [...chosen, edge], size);
    }
  }
  for (let size = 1; size <= 3; size += 1) visit(0, [], size);
  plans.sort((a, b) => b.netGain - a.netGain || a.edges.length - b.edges.length);
  const bestSingle = plans.find(plan => plan.edges.length === 1);
  const bestMulti = plans.find(plan => plan.edges.length > 1);
  let chosen = bestSingle;
  if (bestMulti && (!bestSingle || bestMulti.netGain >= bestSingle.netGain + 2)) chosen = bestMulti;
  if (!chosen || chosen.netGain < 0.75) chosen = null;
  const serialise = plan => plan ? {
    moves: plan.edges.map(edge => ({
      out: { id: edge.out.id, name: edge.out.name, price: edge.sellPrice / 10, xPts: round(edge.out.weighted5) },
      in: { id: edge.in.id, name: edge.in.name, price: edge.in.nowCost / 10, xPts: round(edge.in.weighted5) },
      xPtsGain: round(edge.delta)
    })),
    rawGain: round(plan.rawGain),
    hitCost: plan.hitCost,
    netGain: round(plan.netGain),
    bankAfter: round((bank - plan.spend) / 10)
  } : null;
  return { chosen: serialise(chosen), alternatives: plans.slice(0, 5).map(serialise), edges: pool };
}

function makeRoadmap(chosen, edges, squad, bank, events) {
  const roadmap = [];
  const usedOut = new Set();
  const usedIn = new Set();
  if (chosen) {
    roadmap.push({ event: events[0]?.id, label: `GW${events[0]?.id}`, action: chosen.moves.map(move => `${move.out.name} → ${move.in.name}`).join("; "), gain: chosen.netGain, note: chosen.hitCost ? `Includes ${chosen.hitCost}-point hit` : "Uses available free transfers" });
    chosen.moves.forEach(move => { usedOut.add(move.out.id); usedIn.add(move.in.id); });
  } else {
    roadmap.push({ event: events[0]?.id, label: `GW${events[0]?.id}`, action: "Roll the transfer", gain: 0, note: "No move clears the expected-points threshold" });
  }
  for (let offset = 1; offset <= 2; offset += 1) {
    const next = edges
      .filter(edge => !usedOut.has(edge.out.id) && !usedIn.has(edge.in.id))
      .map(edge => ({ edge, gain: weightedTotal(edge.in.fixtures, offset) - weightedTotal(edge.out.fixtures, offset) }))
      .filter(item => item.gain >= 0.8)
      .sort((a, b) => b.gain - a.gain)[0];
    if (next) {
      usedOut.add(next.edge.out.id);
      usedIn.add(next.edge.in.id);
      roadmap.push({ event: events[offset]?.id, label: `GW${events[offset]?.id}`, action: formatMove(next.edge), gain: round(next.gain), note: "Re-check minutes, injuries and prices first" });
    } else {
      roadmap.push({ event: events[offset]?.id, label: `GW${events[offset]?.id}`, action: "Reassess / roll", gain: 0, note: "Indicative—daily model will re-optimise" });
    }
  }
  return roadmap;
}

function priceRisk(player, edgePool) {
  const tonightProjected = (player.priceProjections || []).find(item => number(item.offset) === 0)?.projected_percent;
  const lowest = Math.min(number(player.priceChangePercent), number(tonightProjected, player.priceChangePercent));
  if (lowest > -90) return null;
  const afterFall = sellingPrice(player.purchasePrice, player.nowCost - 1);
  const valueLoss = Math.max(0, player.sellPrice - afterFall);
  const replacement = edgePool.filter(edge => edge.out.id === player.id && edge.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  return {
    id: player.id,
    name: player.name,
    price: player.nowCost / 10,
    sellPrice: player.sellPrice / 10,
    projectedPercent: round(lowest),
    saleValueAtRisk: valueLoss / 10,
    recommendation: replacement ? `${player.name} → ${replacement.in.name}` : "Hold unless team news changes",
    xPtsTradeGain: replacement ? round(replacement.delta) : 0,
    rationale: replacement
      ? `A positive five-GW xPts replacement exists${valueLoss ? " and a fall would reduce sale value" : ""}.`
      : `No replacement currently improves weighted five-GW xPts${valueLoss ? ", despite sale value being at risk" : ""}.`
  };
}

function makeIssueMarkdown(data) {
  const risks = data.alert.priceRisks;
  const plan = data.recommendation.primary;
  const lines = [
    "<!-- fpl-transfer-scout -->",
    `<!-- fingerprint:${data.alert.fingerprint} -->`,
    `## ${data.alert.headline}`,
    "",
    "@fishdawg90 — your scheduled FPL price and transfer check is ready.",
    "",
    `**Team:** ${data.team.name} · **Next deadline:** ${data.nextDeadline.display} · **Free transfers:** ${data.team.freeTransfers} (inferred)`,
    "",
    "### Price risks tonight",
    "",
    ...risks.map(risk => `- **${risk.name}** — ${risk.projectedPercent}% toward a fall; ${risk.saleValueAtRisk ? `£${risk.saleValueAtRisk.toFixed(1)}m sale value at risk` : "no immediate sale-price loss"}. **${risk.recommendation}** (${risk.xPtsTradeGain >= 0 ? "+" : ""}${risk.xPtsTradeGain} weighted xPts).`),
    "",
    "### Expected-points decision",
    "",
    plan
      ? `${plan.moves.map(move => `**${move.out.name} → ${move.in.name}**`).join(" and ")} · +${plan.netGain} net weighted xPts${plan.hitCost ? ` after a ${plan.hitCost}-point hit` : ""}.`
      : "**Hold / roll.** No legal move currently improves weighted five-GW xPts enough to justify acting.",
    "",
    "Price only changes urgency; the recommendation is ranked by expected points first.",
    "",
    `[Open the full dashboard](https://fishdawg90.github.io/fpl-transfer-scout/)`
  ];
  return lines.join("\n");
}

async function main() {
  const [bootstrap, fixtures, entry, history] = await Promise.all([
    fetchJson("/bootstrap-static/"),
    fetchJson("/fixtures/"),
    fetchJson(`/entry/${ENTRY_ID}/`),
    fetchJson(`/entry/${ENTRY_ID}/history/`)
  ]);
  const currentEvent = bootstrap.events.find(event => event.is_current) || bootstrap.events.filter(event => new Date(event.deadline_time) <= new Date()).at(-1);
  if (!currentEvent) throw new Error("Could not determine the current FPL event.");
  const picks = await fetchJson(`/entry/${ENTRY_ID}/event/${currentEvent.id}/picks/`);
  const pickEvents = await mapLimit(Array.from({ length: currentEvent.id }, (_, index) => index + 1), 4, event => fetchJson(`/entry/${ENTRY_ID}/event/${event}/picks/`, true));
  const elements = bootstrap.elements.filter(element => !element.removed);
  process.stdout.write(`Fetching ${elements.length} player summaries…\n`);
  const summaries = await mapLimit(elements, FETCH_CONCURRENCY, element => fetchJson(`/element-summary/${element.id}/`, true));
  const summaryById = new Map(elements.map((element, index) => [element.id, summaries[index] || { history: [], history_past: [], fixtures: [] }]));
  const teams = new Map(bootstrap.teams.map(team => [team.id, team]));
  const teamModels = makeTeamModels(bootstrap.teams, fixtures);
  const projectionEvents = bootstrap.events.filter(event => event.id > currentEvent.id).slice(0, 5);
  const futureFixtures = fixtures.filter(fixture => projectionEvents.some(event => event.id === fixture.event));
  const scoring = bootstrap.game_config?.scoring || {};
  const earliestPickEvent = new Map();
  for (const eventPicks of pickEvents.filter(Boolean)) {
    for (const pick of eventPicks.picks || []) {
      if (!earliestPickEvent.has(pick.element)) earliestPickEvent.set(pick.element, eventPicks.entry_history?.event);
    }
  }
  const playerRows = elements.map(element => {
    const summary = summaryById.get(element.id);
    const profile = playerProfile(element, summary);
    const recentHistory = profile.history.slice(-5);
    const recentMinutes = aggregate(recentHistory, "minutes");
    const recentThreshold = profile.position === "DEF" ? 10 : 12;
    const recentMatches = [...recentHistory].reverse().map(row => ({
      event: row.round,
      opponent: teams.get(row.opponent_team)?.short_name || "—",
      venue: row.was_home ? "H" : "A",
      kickoff: row.kickoff_time,
      minutes: number(row.minutes),
      started: number(row.starts) > 0,
      points: number(row.total_points),
      goals: number(row.goals_scored),
      assists: number(row.assists),
      xG: round(number(row.expected_goals), 2),
      xA: round(number(row.expected_assists), 2),
      cleanSheet: number(row.clean_sheets) > 0,
      defensiveContributions: number(row.defensive_contribution),
      defensiveContributionReturn: profile.position !== "GKP" && number(row.defensive_contribution) >= recentThreshold,
      saves: number(row.saves),
      bonus: number(row.bonus),
      bps: number(row.bps),
      yellow: number(row.yellow_cards),
      red: number(row.red_cards)
    }));
    const recentSummary = {
      matches: recentHistory.length,
      starts: recentHistory.filter(row => number(row.starts) > 0).length,
      minutes: recentMinutes,
      averageMinutes: recentHistory.length ? round(recentMinutes / recentHistory.length, 0) : 0,
      points: aggregate(recentHistory, "total_points"),
      pointsPer90: recentMinutes ? round(aggregate(recentHistory, "total_points") * 90 / recentMinutes, 1) : 0,
      xG: round(aggregate(recentHistory, "expected_goals"), 2),
      xA: round(aggregate(recentHistory, "expected_assists"), 2),
      xGI: round(aggregate(recentHistory, "expected_goals") + aggregate(recentHistory, "expected_assists"), 2),
      goals: aggregate(recentHistory, "goals_scored"),
      assists: aggregate(recentHistory, "assists"),
      bonus: aggregate(recentHistory, "bonus"),
      defensiveContributionReturns: profile.position === "GKP" ? 0 : recentHistory.filter(row => number(row.defensive_contribution) >= recentThreshold).length
    };
    const fixtureRows = futureFixtures
      .filter(fixture => fixture.team_h === element.team || fixture.team_a === element.team)
      .map((fixture, index) => projectFixture(element, profile, fixture, teams, teamModels, index, scoring));
    const gameweeks = projectionEvents.map(event => combineGameweekFixtures(fixtureRows, event.id));
    const firstEvent = earliestPickEvent.get(element.id);
    const firstValue = firstEvent ? number(profile.history.find(row => row.round === firstEvent)?.value, NaN) : NaN;
    const purchasePrice = Number.isFinite(firstValue) ? firstValue : Math.max(0, number(element.now_cost) - number(element.cost_change_start));
    const sale = sellingPrice(purchasePrice, element.now_cost);
    return {
      id: element.id,
      name: element.web_name,
      fullName: [element.first_name, element.second_name].filter(Boolean).join(" "),
      team: element.team,
      teamName: teams.get(element.team)?.short_name,
      position: profile.position,
      nowCost: number(element.now_cost),
      purchasePrice,
      sellPrice: sale,
      status: element.status,
      news: element.news || "",
      canTransact: element.can_transact !== false,
      expectedMinutes: round(profile.expectedMinutes, 0),
      availability: round(profile.availability * 100, 0),
      currentSeasonWeight: round(profile.currentWeight * 100, 0),
      confidence: profile.confidence,
      rates: Object.fromEntries(Object.entries(profile.rates).map(([key, value]) => [key, round(value, 2)])),
      recentSummary,
      recentMatches,
      seasonStats: {
        minutes: number(element.minutes),
        starts: number(element.starts),
        points: number(element.total_points),
        goals: number(element.goals_scored),
        assists: number(element.assists),
        xG: round(number(element.expected_goals), 2),
        xA: round(number(element.expected_assists), 2),
        cleanSheets: number(element.clean_sheets),
        bonus: number(element.bonus)
      },
      previousSeason: profile.past ? {
        season: profile.past.season_name,
        minutes: number(profile.past.minutes),
        points: number(profile.past.total_points),
        goals: number(profile.past.goals_scored),
        assists: number(profile.past.assists),
        xG: round(number(profile.past.expected_goals), 2),
        xA: round(number(profile.past.expected_assists), 2)
      } : null,
      epNext: round(number(element.ep_next), 1),
      form: round(number(element.form), 1),
      selectedBy: round(number(element.selected_by_percent), 1),
      priceChangePercent: round(number(element.price_change_percent), 1),
      priceHourlyRate: round(number(element.price_change_hourly_rate), 1),
      priceProjections: element.price_change_projections || [],
      priceLockedUntil: element.price_change_locked_until,
      priceForecast: priceForecast(element.price_change_percent, element.price_change_projections, element.price_change_locked_until),
      fixtures: gameweeks,
      weighted5: round(weightedTotal(gameweeks), 2),
      raw5: round(gameweeks.reduce((sum, fixture) => sum + fixture.xPts, 0), 2)
    };
  });
  const playersById = new Map(playerRows.map(player => [player.id, player]));
  const squad = picks.picks.map(pick => ({ ...playersById.get(pick.element), pickPosition: pick.position, captain: pick.is_captain, multiplier: pick.multiplier }));
  const currentHistory = history.current || [];
  const latestHistory = currentHistory.at(-1) || picks.entry_history || {};
  const override = process.env.FPL_FREE_TRANSFERS;
  const freeTransfers = override ? number(override) : inferFreeTransfers(currentHistory, history.chips || [], number(bootstrap.game_settings?.max_extra_free_transfers, 4) + 1);
  const bank = number(latestHistory.bank ?? picks.entry_history?.bank);
  const optimisation = optimiseTransfers(squad, playerRows, bank, freeTransfers, number(bootstrap.game_settings?.squad_team_limit, 3));
  const priceRisks = squad.map(player => priceRisk(player, optimisation.edges)).filter(Boolean).sort((a, b) => a.projectedPercent - b.projectedPercent);
  const roadmap = makeRoadmap(optimisation.chosen, optimisation.edges, squad, bank, projectionEvents);
  const nextEvent = projectionEvents[0];
  const generatedAt = new Date();
  const deadline = nextEvent ? new Date(nextEvent.deadline_time) : null;
  const displayDeadline = deadline ? new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(deadline) : "TBC";
  const decision = optimisation.chosen
    ? (priceRisks.some(risk => optimisation.chosen.moves.some(move => move.out.id === risk.id)) ? "Act tonight" : "Best xPts move")
    : (priceRisks.length ? "Price watch—hold for now" : "Roll / monitor");
  const targetIds = new Set([
    ...squad.map(player => player.id),
    ...(optimisation.alternatives.flatMap(plan => plan?.moves.flatMap(move => [move.out.id, move.in.id]) || []))
  ]);
  const targets = playerRows
    .filter(player => !squad.some(member => member.id === player.id))
    .sort((a, b) => b.weighted5 - a.weighted5)
    .filter(player => {
      const positionCount = [...targetIds].map(id => playersById.get(id)).filter(item => item?.position === player.position).length;
      if (positionCount >= 12) return false;
      targetIds.add(player.id);
      return true;
    });
  const alertSeed = JSON.stringify({ day: generatedAt.toISOString().slice(0, 10), risks: priceRisks.map(risk => [risk.id, risk.projectedPercent, risk.recommendation]), plan: optimisation.chosen });
  const fingerprint = createHash("sha256").update(alertSeed).digest("hex").slice(0, 16);
  const data = {
    generatedAt: generatedAt.toISOString(),
    season: "2026/27",
    entryId: ENTRY_ID,
    team: {
      name: entry.name,
      manager: [entry.player_first_name, entry.player_last_name].filter(Boolean).join(" "),
      overallPoints: number(entry.summary_overall_points),
      bank: bank / 10,
      squadValue: number(latestHistory.value) / 10,
      freeTransfers,
      freeTransfersInferred: !override
    },
    nextDeadline: { event: nextEvent?.id, name: nextEvent?.name, iso: nextEvent?.deadline_time, display: displayDeadline },
    decision: {
      label: decision,
      explanation: "Weighted five-GW expected points chooses the move. Price-change risk only determines whether waiting until the deadline could cost value."
    },
    recommendation: { primary: optimisation.chosen, alternatives: optimisation.alternatives, roadmap },
    alert: {
      shouldNotify: priceRisks.length > 0,
      headline: priceRisks.length ? `${priceRisks.length} squad price ${priceRisks.length === 1 ? "risk" : "risks"} tonight` : "No squad price falls projected tonight",
      priceRisks,
      fingerprint
    },
    model: {
      horizonWeights: GW_WEIGHTS,
      teamStrengthSource: teamModels.specificAvailable ? "FPL attack/defence venue strengths + live results" : "FPL overall venue strengths + live home/away results",
      teamStrengthFallbackActive: !teamModels.specificAvailable,
      completedMatchesLearned: teamModels.finishedMatches,
      notes: [
        "Current and previous-season per-90 rates are blended progressively by current-season minutes.",
        "Expected minutes favour the five most recent fixtures and are reduced by FPL availability data.",
        "Every fixture is projected separately for goals, assists, clean sheets, defensive contributions, saves, bonus and deductions.",
        "Price progress and forward projections come from FPL's official predictor. Changes are assessed at 00:00 UK time; forecasts remain a guide, not a guarantee.",
        "The 8pm alert uses a cautious -90% threshold against tonight's forecast only.",
        "Future-week roadmap moves are indicative and are re-optimised from fresh data every day."
      ]
    },
    squad: squad.map(player => ({ ...player, priceProjections: undefined })),
    targets: [...targetIds].filter(id => !squad.some(player => player.id === id)).map(id => playersById.get(id)).filter(Boolean).map(player => ({ ...player, priceProjections: undefined }))
  };
  data.alert.issueMarkdown = makeIssueMarkdown(data);
  await mkdir(new URL("../site/data/", import.meta.url), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(data, null, 2)}\n`);
  process.stdout.write(`Built ${OUTPUT.pathname} for ${data.team.name}: ${decision}; ${priceRisks.length} price risks.\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
