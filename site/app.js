const $ = selector => document.querySelector(selector);
const signed = value => `${value > 0 ? "+" : ""}${Number(value).toFixed(1)}`;
const money = value => `£${Number(value).toFixed(1)}m`;
const LOCAL_SYNC_KEY = "fpl-transfer-scout-manual-sync-v1";
const componentLabels = {
  appearance: "Appearance",
  goals: "Goals",
  assists: "Assists",
  cleanSheet: "Clean sheet",
  defensiveContribution: "DefCon",
  saves: "Saves",
  bonus: "Bonus",
  deductions: "Deductions",
  prior: "FPL prior"
};

function relativeTime(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 30 ? `${hours}h ago` : new Date(iso).toLocaleDateString("en-GB");
}

function planSignature(plan) {
  return (plan?.moves || []).map(move => `${move.out.id}-${move.in.id}`).sort().join("|");
}

function readManualSync(data) {
  try {
    const sync = JSON.parse(localStorage.getItem(LOCAL_SYNC_KEY));
    if (!sync) return null;
    if (sync.event !== data.recommendation.lineup?.event) {
      localStorage.removeItem(LOCAL_SYNC_KEY);
      return null;
    }
    return sync;
  } catch {
    return null;
  }
}

function recentForm(player) {
  const recent = player.recentSummary;
  const matches = player.recentMatches || [];
  if (!recent || !matches.length) {
    return '<section class="recent-form"><div class="subheading"><h3>Recent form</h3><span>No Premier League match sample yet</span></div><p class="quiet">This projection relies more heavily on positional rates and FPL’s temporary prior.</p></section>';
  }
  const defensiveLabel = player.position === "GKP" ? "Saves" : "DC";
  const rows = matches.map(match => {
    const defensiveValue = player.position === "GKP"
      ? match.saves
      : `${match.defensiveContributions}${match.defensiveContributionReturn ? " ✓" : ""}`;
    const pointsClass = match.points >= 6 ? "return-good" : match.points <= 1 ? "return-low" : "";
    return `<tr>
      <td data-label="Gameweek"><b>GW${match.event}</b></td>
      <td data-label="Fixture">${match.opponent} (${match.venue})</td>
      <td data-label="Minutes">${match.minutes}${match.started ? "" : "*"}</td>
      <td data-label="Points" class="${pointsClass}"><b>${match.points}</b></td>
      <td data-label="xG">${match.xG.toFixed(2)}</td>
      <td data-label="xA">${match.xA.toFixed(2)}</td>
      <td data-label="${defensiveLabel}">${defensiveValue}</td>
      <td data-label="Bonus">${match.bonus}</td>
    </tr>`;
  }).join("");
  const previous = player.previousSeason
    ? `<span>${player.previousSeason.season}: ${player.previousSeason.points} pts in ${player.previousSeason.minutes.toLocaleString()} min · ${(player.previousSeason.xG + player.previousSeason.xA).toFixed(1)} xGI</span>`
    : '<span>No previous-Premier-League-season evidence; FPL ep_next is used as a fading prior.</span>';
  return `<section class="recent-form">
    <div class="subheading"><h3>Recent form</h3><span>Latest match first · * substitute appearance</span></div>
    <div class="form-metrics">
      <div><span>Last ${recent.matches} points</span><strong>${recent.points}</strong></div>
      <div><span>Points / 90</span><strong>${recent.pointsPer90.toFixed(1)}</strong></div>
      <div><span>Minutes / match</span><strong>${recent.averageMinutes}</strong></div>
      <div><span>xGI</span><strong>${recent.xGI.toFixed(2)}</strong></div>
      <div><span>G + A</span><strong>${recent.goals + recent.assists}</strong></div>
      <div><span>Bonus</span><strong>${recent.bonus}</strong></div>
    </div>
    <div class="form-table-wrap">
      <table class="form-table">
        <thead><tr><th>GW</th><th>Fixture</th><th>Min</th><th>Pts</th><th>xG</th><th>xA</th><th>${defensiveLabel}</th><th>Bonus</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div class="evidence-line"><span>This season: ${player.seasonStats.points} pts in ${player.seasonStats.minutes} min · ${(player.seasonStats.xG + player.seasonStats.xA).toFixed(2)} xGI</span>${previous}</div>
  </section>`;
}

function priceMini(player) {
  const forecast = player.priceForecast;
  if (!forecast) return "";
  if (forecast.direction === "locked") {
    return `<div class="price-mini price-locked"><div class="price-mini-head"><span>Price locked</span><strong>Until ${new Date(forecast.lockedUntil).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</strong></div><div class="price-track"><span></span></div></div>`;
  }
  const symbol = forecast.direction === "rise" ? "↑" : forecast.direction === "fall" ? "↓" : "•";
  const sign = value => `${value > 0 ? "+" : ""}${Number(value).toFixed(0)}%`;
  const detail = `Official FPL price progress: ${sign(forecast.currentPercent)} now; ${sign(forecast.midnightPercent)} forecast for 00:00 UK. ${forecast.timingKind === "trend-estimate" ? "Timing beyond the official forecast window is extrapolated." : ""}`;
  return `<div class="price-mini price-${forecast.direction}" title="${detail.trim()}">
    <div class="price-mini-head"><span>Price ${symbol} ${sign(forecast.currentPercent)} → ${sign(forecast.midnightPercent)}</span><strong>${forecast.timing}</strong></div>
    <div class="price-track" role="progressbar" aria-label="${Math.abs(forecast.midnightPercent).toFixed(0)} percent toward a price ${forecast.direction}" aria-valuenow="${forecast.meterPercent}" aria-valuemin="0" aria-valuemax="100"><span style="width:${forecast.meterPercent}%"></span></div>
  </div>`;
}

function playerCard(player) {
  const fixtures = player.fixtures.map(fixture => `
    <div class="fixture" title="${fixture.label}: ${fixture.opponents}">
      <span>${fixture.opponents}</span><strong>${fixture.xPts.toFixed(1)}</strong>
    </div>`).join("");
  const breakdowns = player.fixtures.map(fixture => {
    const components = Object.entries(fixture.components || {})
      .filter(([, value]) => Math.abs(value) >= 0.01)
      .map(([key, value]) => `<div class="component"><span>${componentLabels[key] || key}</span><b>${signed(value)}</b></div>`).join("");
    return `<div class="gw-breakdown"><h4>${fixture.label} · ${fixture.opponents}</h4>${components || '<div class="component"><span>No fixture</span></div>'}</div>`;
  }).join("");
  return `
    <details class="player">
      <summary>
        <div class="player-name"><strong>${player.name}</strong><span>${player.position} · ${player.teamName} · ${money(player.nowCost / 10)}</span>${priceMini(player)}</div>
        <div class="fixtures">${fixtures}</div>
        <div class="player-total"><strong>${player.weighted5.toFixed(1)}</strong><span>weighted xPts</span></div>
      </summary>
      <div class="breakdown">
        ${recentForm(player)}
        <div class="subheading future-heading"><h3>Future xPts ingredients</h3><span>Each fixture modelled independently · swipe for later GWs</span></div>
        <div class="breakdown-grid">${breakdowns}</div>
        <p class="profile-note">${player.expectedMinutes} expected minutes · ${player.currentSeasonWeight}% current-season weighting · ${player.confidence} evidence confidence · xG/90 ${player.rates.xg} · xA/90 ${player.rates.xa} · DefCon/90 ${player.rates.defcon}</p>
      </div>
    </details>`;
}

function renderPlan(plan, lineup, manualSync) {
  if (manualSync) {
    const exact = manualSync.kind === "recommended" && manualSync.signature === planSignature(plan);
    return `<div class="plan-card plan-paused"><div class="move hold">${exact ? "Recommended transfer marked as made" : "Squad change logged locally"}</div><p class="quiet">FPL does not expose transfers made during an open gameweek, so further recommendations are paused until the next deadline refresh.</p><button class="action-button secondary" id="undo-manual-sync" type="button">Undo local mark</button></div>`;
  }
  if (!plan) {
    return `<div class="plan-card"><div class="move hold">Hold the squad and roll the transfer</div><p class="quiet">No legal move clears the minimum +0.75 net weighted-xPts threshold.</p></div>`;
  }
  const starters = new Set(lineup?.starters.map(player => player.id) || []);
  const bench = new Map(lineup?.bench.map(player => [player.id, player.order]) || []);
  const moves = plan.moves.map(move => {
    const role = starters.has(move.in.id) ? `Starts GW${lineup.event}` : bench.has(move.in.id) ? `Bench ${bench.get(move.in.id)}` : "Squad cover";
    return `<div class="move"><span class="out">${move.out.name}</span><span class="arrow">→</span><span class="in">${move.in.name}</span><span class="tag">${signed(move.xPtsGain)} xPts</span><span class="tag lineup-role">${role}</span></div>`;
  }).join("");
  const plural = plan.moves.length === 1 ? "transfer" : "transfers";
  return `<div class="plan-card">${moves}<div class="plan-stats"><span class="tag gain">${signed(plan.netGain)} net weighted xPts</span><span class="tag">${plan.hitCost ? `${plan.hitCost}-point hit` : "No hit"}</span><span class="tag">${money(plan.bankAfter)} bank after</span></div><div class="plan-actions"><button class="action-button" id="mark-plan-made" type="button">I made ${plan.moves.length === 1 ? "this" : "these"} ${plural}</button><button class="action-button secondary" id="mark-other-made" type="button">My change was different</button></div></div>`;
}

function lineupPlayer(player, captainId, viceCaptainId) {
  const badge = player.id === captainId ? '<b class="armband captain">C</b>' : player.id === viceCaptainId ? '<b class="armband vice">V</b>' : "";
  return `<div class="lineup-player" title="${player.name} · ${player.opponent} · ${player.xPts.toFixed(1)} xPts">
    <div><strong>${player.name}</strong>${badge}</div><span>${player.opponent} · ${player.xPts.toFixed(1)}</span>
  </div>`;
}

function renderLineup(lineup, manualSync) {
  if (manualSync?.kind === "different") return '<div class="model-warning">Lineup advice is paused because the public FPL squad no longer matches your real squad. It will resynchronise after the next deadline.</div>';
  if (!lineup) return '<p class="quiet">A legal starting XI could not be produced.</p>';
  const positions = [["GKP", "Goalkeeper"], ["DEF", "Defenders"], ["MID", "Midfielders"], ["FWD", "Forwards"]];
  const groups = positions.map(([position, label]) => `<div class="lineup-group"><span class="position-label">${label}</span><div class="lineup-players">${lineup.starters.filter(player => player.position === position).map(player => lineupPlayer(player, lineup.captain.id, lineup.viceCaptain.id)).join("")}</div></div>`).join("");
  const bench = lineup.bench.map(player => `<div class="bench-player"><span>${player.order === "GK" ? "GK" : `B${player.order}`}</span><strong>${player.name}</strong><small>${player.xPts.toFixed(1)} xPts</small></div>`).join("");
  return `<div class="lineup-summary"><span>${lineup.afterTransfers ? "After recommended transfers" : "With the current squad"}</span><strong>${lineup.projectedPoints.toFixed(1)} projected points incl. captain</strong></div>
    <div class="lineup-card">${groups}</div>
    <div class="captain-call"><div><span>Captain · risk-adjusted</span><strong>${lineup.captain.name}</strong><small>${lineup.captain.xPts.toFixed(1)} xPts doubled · ${lineup.captainRationale || "attacking ceiling prioritised"}</small></div><div><span>Vice-captain</span><strong>${lineup.viceCaptain.name}</strong><small>${lineup.viceCaptain.xPts.toFixed(1)} xPts</small></div></div>
    <div class="bench"><span class="position-label">Bench order</span><div class="bench-list">${bench}</div></div>`;
}

function render(data) {
  const manualSync = readManualSync(data);
  const manualSyncExact = manualSync?.kind === "recommended" && manualSync.signature === planSignature(data.recommendation.primary);
  const effectiveSync = manualSync && !manualSyncExact ? { ...manualSync, kind: "different" } : manualSync;
  const advice = data.actionAdvice || { level: "ready", label: data.decision.label, summary: data.decision.explanation, nextReview: data.nextDeadline.display, priceStatus: "Price status unavailable", evidence: [], gameweek: { coverage: "Coverage unavailable" } };
  const shownAdvice = manualSync ? {
    ...advice,
    level: "wait",
    label: "TRANSFER LOGGED — WAIT",
    summary: "Your real squad has changed, but FPL hides open-gameweek transfers from the public API. Do not act on another recommendation until the squad resynchronises after the deadline."
  } : advice;
  $("#freshness").textContent = `Updated ${relativeTime(data.generatedAt)}`;
  $("#decision-title").textContent = shownAdvice.label;
  $("#decision-copy").textContent = shownAdvice.summary;
  $("#decision-hero").className = `hero action-${shownAdvice.level}`;
  $("#decision-facts").innerHTML = [
    ["Data", shownAdvice.gameweek.coverage],
    ["Prices", shownAdvice.priceStatus],
    ["Review", shownAdvice.nextReview],
    ...(shownAdvice.evidence || []).slice(0, 2).map(item => ["Latest", item])
  ].map(([label, value]) => `<span class="decision-fact"><b>${label}</b>${value}</span>`).join("");
  $("#deadline-card").innerHTML = `<span class="kicker">${data.nextDeadline.name || "Next deadline"}</span><strong>${data.nextDeadline.display}</strong>`;
  const gain = data.recommendation.primary?.netGain || 0;
  const lineup = data.recommendation.lineup;
  $("#metrics").innerHTML = [
    ["Free transfers", manualSync ? "Used locally" : `${data.team.freeTransfers}${data.team.freeTransfersInferred ? "*" : ""}`],
    ["Bank after move", effectiveSync?.kind === "different" ? "Unknown" : data.recommendation.primary ? money(data.recommendation.primary.bankAfter) : money(data.team.bank)],
    ["Formation", effectiveSync?.kind === "different" ? "Paused" : lineup?.formation || "—"],
    ["Captain", effectiveSync?.kind === "different" ? "Paused" : lineup?.captain.name || "—"]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#primary-plan").innerHTML = renderPlan(data.recommendation.primary, data.recommendation.lineup, effectiveSync);
  $("#lineup-formation").textContent = data.recommendation.lineup ? `GW${data.recommendation.lineup.event} · ${data.recommendation.lineup.formation}` : "";
  $("#recommended-lineup").innerHTML = renderLineup(data.recommendation.lineup, effectiveSync);
  $("#squad-list").innerHTML = [...data.squad].sort((a, b) => a.pickPosition - b.pickPosition).map(playerCard).join("");
  $("#target-list").innerHTML = [...data.targets].sort((a, b) => b.weighted5 - a.weighted5).map(playerCard).join("") || '<p class="quiet">No eligible targets in today\'s shortlist.</p>';

  $("#price-risks").innerHTML = data.alert.priceRisks.length
    ? data.alert.priceRisks.map(risk => `<div class="risk"><strong>${risk.name} · ${risk.projectedPercent}%</strong><p>${risk.recommendation}. ${risk.rationale}</p><p>${risk.saleValueAtRisk ? `${money(risk.saleValueAtRisk)} sale value at risk.` : "A fall would not yet reduce the calculated selling price."}</p></div>`).join("")
    : '<p class="all-clear">No player in your squad is currently beyond the −90% threshold for tonight’s 00:00 UK price check.</p>';
  $("#roadmap").innerHTML = data.recommendation.roadmap.map(item => `<li><strong>${item.label}: ${item.action}</strong><span>${item.gain ? `${signed(item.gain)} xPts · ` : ""}${item.note}</span></li>`).join("");
  $("#model-notes").innerHTML = `
    <p class="quiet">${data.model.teamStrengthSource}. Learned from ${data.model.completedMatchesLearned} completed matches.</p>
    ${data.model.teamStrengthFallbackActive ? '<div class="model-warning">FPL currently publishes zeroes for its attack/defence split fields, so the documented overall-strength fallback is active.</div>' : ""}
    <ul class="notes">${data.model.notes.map(note => `<li>${note}</li>`).join("")}</ul>
    <p class="quiet">* Free transfers are inferred from public history and your GW${data.team.startedEvent} entry date; live transfers made after the last deadline are private.</p>`;

  $("#mark-plan-made")?.addEventListener("click", () => {
    localStorage.setItem(LOCAL_SYNC_KEY, JSON.stringify({ event: data.recommendation.lineup?.event, kind: "recommended", signature: planSignature(data.recommendation.primary), savedAt: new Date().toISOString() }));
    render(data);
  });
  $("#mark-other-made")?.addEventListener("click", () => {
    localStorage.setItem(LOCAL_SYNC_KEY, JSON.stringify({ event: data.recommendation.lineup?.event, kind: "different", savedAt: new Date().toISOString() }));
    render(data);
  });
  $("#undo-manual-sync")?.addEventListener("click", () => {
    localStorage.removeItem(LOCAL_SYNC_KEY);
    render(data);
  });
}

fetch("data/latest.json", { cache: "no-store" })
  .then(response => {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  })
  .then(render)
  .catch(error => {
    document.querySelector("main").innerHTML = `<div class="error"><p class="kicker">Data unavailable</p><h1>The latest model could not be loaded.</h1><p>${error.message}</p></div>`;
  });
