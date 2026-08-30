const $ = selector => document.querySelector(selector);
const signed = value => `${value > 0 ? "+" : ""}${Number(value).toFixed(1)}`;
const money = value => `£${Number(value).toFixed(1)}m`;
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
  const risk = player.priceChangePercent <= -90 ? " · price fall risk" : "";
  return `
    <details class="player">
      <summary>
        <div class="player-name"><strong>${player.name}</strong><span>${player.position} · ${player.teamName} · ${money(player.nowCost / 10)}${risk}</span></div>
        <div class="fixtures">${fixtures}</div>
        <div class="player-total"><strong>${player.weighted5.toFixed(1)}</strong><span>weighted xPts</span></div>
      </summary>
      <div class="breakdown">
        <div class="breakdown-grid">${breakdowns}</div>
        <p class="profile-note">${player.expectedMinutes} expected minutes · ${player.currentSeasonWeight}% current-season weighting · ${player.confidence} evidence confidence · xG/90 ${player.rates.xg} · xA/90 ${player.rates.xa} · DefCon/90 ${player.rates.defcon}</p>
      </div>
    </details>`;
}

function renderPlan(plan) {
  if (!plan) {
    return `<div class="plan-card"><div class="move hold">Hold the squad and roll the transfer</div><p class="quiet">No legal move clears the minimum +0.75 net weighted-xPts threshold.</p></div>`;
  }
  const moves = plan.moves.map(move => `<div class="move"><span class="out">${move.out.name}</span><span class="arrow">→</span><span class="in">${move.in.name}</span><span class="tag">${signed(move.xPtsGain)} xPts</span></div>`).join("");
  return `<div class="plan-card">${moves}<div class="plan-stats"><span class="tag gain">${signed(plan.netGain)} net weighted xPts</span><span class="tag">${plan.hitCost ? `${plan.hitCost}-point hit` : "No hit"}</span><span class="tag">${money(plan.bankAfter)} bank after</span></div></div>`;
}

function render(data) {
  $("#freshness").textContent = `Updated ${relativeTime(data.generatedAt)}`;
  $("#decision-title").textContent = data.decision.label;
  $("#decision-copy").textContent = data.decision.explanation;
  $("#deadline-card").innerHTML = `<span class="kicker">${data.nextDeadline.name || "Next deadline"}</span><strong>${data.nextDeadline.display}</strong>`;
  const gain = data.recommendation.primary?.netGain || 0;
  $("#metrics").innerHTML = [
    ["Free transfers", `${data.team.freeTransfers}${data.team.freeTransfersInferred ? "*" : ""}`],
    ["Bank", money(data.team.bank)],
    ["Squad value", money(data.team.squadValue)],
    ["Best net gain", `${signed(gain)} xPts`]
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#primary-plan").innerHTML = renderPlan(data.recommendation.primary);
  $("#squad-list").innerHTML = [...data.squad].sort((a, b) => a.pickPosition - b.pickPosition).map(playerCard).join("");
  $("#target-list").innerHTML = [...data.targets].sort((a, b) => b.weighted5 - a.weighted5).map(playerCard).join("") || '<p class="quiet">No eligible targets in today\'s shortlist.</p>';

  $("#price-risks").innerHTML = data.alert.priceRisks.length
    ? data.alert.priceRisks.map(risk => `<div class="risk"><strong>${risk.name} · ${risk.projectedPercent}%</strong><p>${risk.recommendation}. ${risk.rationale}</p><p>${risk.saleValueAtRisk ? `${money(risk.saleValueAtRisk)} sale value at risk.` : "A fall would not yet reduce the calculated selling price."}</p></div>`).join("")
    : '<p class="all-clear">No player in your squad is currently beyond the −90% evening risk threshold.</p>';
  $("#roadmap").innerHTML = data.recommendation.roadmap.map(item => `<li><strong>${item.label}: ${item.action}</strong><span>${item.gain ? `${signed(item.gain)} xPts · ` : ""}${item.note}</span></li>`).join("");
  $("#model-notes").innerHTML = `
    <p class="quiet">${data.model.teamStrengthSource}. Learned from ${data.model.completedMatchesLearned} completed matches.</p>
    ${data.model.teamStrengthFallbackActive ? '<div class="model-warning">FPL currently publishes zeroes for its attack/defence split fields, so the documented overall-strength fallback is active.</div>' : ""}
    <ul class="notes">${data.model.notes.map(note => `<li>${note}</li>`).join("")}</ul>
    <p class="quiet">* Free transfers are inferred from public history; live transfers made after the last deadline are private.</p>`;
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
