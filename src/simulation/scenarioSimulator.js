import { appendCsvRow, formatNumber } from "../utils.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toMoney(n) {
  return Number.isFinite(Number(n)) ? Number(n).toFixed(4) : "";
}

function normalizeRiskAppetite(value, fallback = 0.5) {
  const x = Number(value);
  if (!Number.isFinite(x)) return clamp(fallback, 0, 1);
  return clamp(x, 0, 1);
}

function scenarioThreshold(baseThreshold, scenarioRisk, baseRisk) {
  const sensitivityPoints = 40;
  const adjusted = Number(baseThreshold) - (Number(scenarioRisk) - Number(baseRisk)) * sensitivityPoints;
  return clamp(adjusted, 1, 100);
}

function computeDefinitions(baseRisk, step) {
  return [
    { key: "optimistic", label: "Optimistic", riskAppetite: clamp(baseRisk + step, 0, 1) },
    { key: "normal", label: "Normal", riskAppetite: baseRisk },
    { key: "cautious", label: "Cautious", riskAppetite: clamp(baseRisk - step, 0, 1) }
  ];
}

export function createScenarioSimulator(tradingConfig) {
  const knobs = {
    baseRisk: normalizeRiskAppetite(tradingConfig?.riskAppetite, 0.5),
    step: clamp(Number(tradingConfig?.riskAppetiteStep ?? 0.2), 0, 0.5),
    fixedBidPrice: clamp(Number(tradingConfig?.maxBidPrice ?? 0.95), 0.01, 0.99),
    budgetResetAmount: Math.max(0, Number(tradingConfig?.simBudgetUsd ?? 0)),
    betAmountUsd: Math.max(0, Number(tradingConfig?.simBetAmountUsd ?? 0)),
    baseThreshold: clamp(Number(tradingConfig?.tradeThreshold ?? 75), 1, 100),
    entryMaxTimeLeftMin: clamp(Number(tradingConfig?.simEntryMaxTimeLeftMin ?? 2), 0.1, 20),
    entryMinTimeLeftMin: clamp(Number(tradingConfig?.simEntryMinTimeLeftMin ?? 1.5), 0, 20)
  };

  if (knobs.entryMinTimeLeftMin > knobs.entryMaxTimeLeftMin) {
    const tmp = knobs.entryMinTimeLeftMin;
    knobs.entryMinTimeLeftMin = knobs.entryMaxTimeLeftMin;
    knobs.entryMaxTimeLeftMin = tmp;
  }

  const definitions = computeDefinitions(knobs.baseRisk, knobs.step);
  const scenarios = {};
  for (const d of definitions) {
    scenarios[d.key] = {
      ...d,
      threshold: scenarioThreshold(knobs.baseThreshold, d.riskAppetite, knobs.baseRisk),
      balanceUsd: knobs.budgetResetAmount,
      totalPnlUsd: 0,
      rounds: 0,
      resets: 0,
      totalBids: 0
    };
  }

  const roundsBySlug = {};
  const tradeByScenarioAndSlug = {};
  const recentSettlements = [];
  const recentDecisions = [];

  function logStrategyDecision(decision) {
    recentDecisions.unshift(decision);
    if (recentDecisions.length > 200) recentDecisions.length = 200;
    try {
      appendCsvRow("./logs/sim_strategy_decisions.csv", [
        "timestamp",
        "market_slug",
        "scenario",
        "action",
        "reason",
        "side",
        "confidence_score",
        "abs_confidence",
        "threshold",
        "time_left_min",
        "max_bid_price",
        "bet_amount_usd",
        "balance_before_usd",
        "balance_after_usd",
        "budget_reset_amount_usd",
        "risk_appetite",
        "risk_step",
        "base_threshold"
      ], [
        decision.timestamp ?? new Date().toISOString(),
        decision.marketSlug ?? "",
        decision.scenario ?? "",
        decision.action ?? "",
        decision.reason ?? "",
        decision.side ?? "",
        Number.isFinite(Number(decision.confidenceScore)) ? Number(decision.confidenceScore).toFixed(4) : "",
        Number.isFinite(Number(decision.absConfidence)) ? Number(decision.absConfidence).toFixed(4) : "",
        Number.isFinite(Number(decision.threshold)) ? Number(decision.threshold).toFixed(4) : "",
        Number.isFinite(Number(decision.timeLeftMin)) ? Number(decision.timeLeftMin).toFixed(4) : "",
        knobs.fixedBidPrice.toFixed(4),
        knobs.betAmountUsd.toFixed(4),
        Number.isFinite(Number(decision.balanceBeforeUsd)) ? Number(decision.balanceBeforeUsd).toFixed(4) : "",
        Number.isFinite(Number(decision.balanceAfterUsd)) ? Number(decision.balanceAfterUsd).toFixed(4) : "",
        knobs.budgetResetAmount.toFixed(4),
        knobs.baseRisk.toFixed(4),
        knobs.step.toFixed(4),
        knobs.baseThreshold.toFixed(4)
      ]);
    } catch {
      // ignore logging failures
    }
  }

  function ensureRound(marketSlug) {
    if (!marketSlug) return null;
    const existing = roundsBySlug[marketSlug];
    if (existing) return existing;
    const created = {
      marketSlug,
      openedAt: new Date().toISOString(),
      bidsByScenario: Object.fromEntries(definitions.map((d) => [d.key, 0])),
      settled: false
    };
    roundsBySlug[marketSlug] = created;
    return created;
  }

  function maybePlaceScenarioTrades({ marketSlug, confidenceScore, confidenceDirection, timeLeftMin, now = new Date() }) {
    if (!marketSlug) return [];
    if (!Number.isFinite(Number(timeLeftMin))) return [];
    if (knobs.betAmountUsd <= 0 || knobs.budgetResetAmount <= 0) return [];
    if (!Number.isFinite(Number(confidenceScore)) || confidenceDirection === "FLAT") return [];
    if (Number(timeLeftMin) > knobs.entryMaxTimeLeftMin || Number(timeLeftMin) < knobs.entryMinTimeLeftMin) return [];

    const side = Number(confidenceScore) >= 0 ? "UP" : "DOWN";
    const round = ensureRound(marketSlug);
    const fills = [];
    const absConf = Math.abs(Number(confidenceScore));

    for (const def of definitions) {
      const state = scenarios[def.key];
      const roundKey = `${def.key}:${marketSlug}`;
      if (tradeByScenarioAndSlug[roundKey]) {
        logStrategyDecision({
          timestamp: now.toISOString(),
          marketSlug,
          scenario: def.key,
          action: "skip",
          reason: "already_has_trade_for_round",
          side,
          confidenceScore,
          absConfidence: absConf,
          threshold: state.threshold,
          timeLeftMin,
          balanceBeforeUsd: state.balanceUsd,
          balanceAfterUsd: state.balanceUsd
        });
        continue;
      }
      if (absConf < state.threshold) {
        logStrategyDecision({
          timestamp: now.toISOString(),
          marketSlug,
          scenario: def.key,
          action: "skip",
          reason: "below_threshold",
          side,
          confidenceScore,
          absConfidence: absConf,
          threshold: state.threshold,
          timeLeftMin,
          balanceBeforeUsd: state.balanceUsd,
          balanceAfterUsd: state.balanceUsd
        });
        continue;
      }
      if (state.balanceUsd < knobs.betAmountUsd) {
        logStrategyDecision({
          timestamp: now.toISOString(),
          marketSlug,
          scenario: def.key,
          action: "skip",
          reason: "insufficient_balance",
          side,
          confidenceScore,
          absConfidence: absConf,
          threshold: state.threshold,
          timeLeftMin,
          balanceBeforeUsd: state.balanceUsd,
          balanceAfterUsd: state.balanceUsd
        });
        continue;
      }

      const shares = knobs.betAmountUsd / knobs.fixedBidPrice;
      const balanceBeforeUsd = state.balanceUsd;
      const trade = {
        placedAt: now.toISOString(),
        marketSlug,
        scenarioKey: def.key,
        scenarioLabel: def.label,
        side,
        confidenceScore: Number(confidenceScore),
        confidenceDirection,
        bidPrice: knobs.fixedBidPrice,
        amountUsd: knobs.betAmountUsd,
        shares
      };

      state.balanceUsd -= knobs.betAmountUsd;
      state.totalBids += 1;
      round.bidsByScenario[def.key] += 1;
      tradeByScenarioAndSlug[roundKey] = trade;
      fills.push(trade);
      logStrategyDecision({
        timestamp: now.toISOString(),
        marketSlug,
        scenario: def.key,
        action: "bid",
        reason: "threshold_passed",
        side,
        confidenceScore,
        absConfidence: absConf,
        threshold: state.threshold,
        timeLeftMin,
        balanceBeforeUsd,
        balanceAfterUsd: state.balanceUsd
      });
    }

    return fills;
  }

  function settleRound({ marketSlug, finalPrice, priceToBeat, settledAtMs = Date.now() }) {
    if (!marketSlug) return null;
    if (!Number.isFinite(Number(finalPrice)) || !Number.isFinite(Number(priceToBeat))) return null;
    const round = ensureRound(marketSlug);
    if (!round || round.settled) return null;

    const winnerSide = Number(finalPrice) > Number(priceToBeat)
      ? "UP"
      : Number(finalPrice) < Number(priceToBeat)
        ? "DOWN"
        : null;

    const scenarioOutcomes = [];
    let aggregateRoundPnl = 0;
    let aggregateRoundBids = 0;
    let aggregateResets = 0;

    for (const def of definitions) {
      const state = scenarios[def.key];
      const roundKey = `${def.key}:${marketSlug}`;
      const trade = tradeByScenarioAndSlug[roundKey] ?? null;
      const bidsInRound = round.bidsByScenario[def.key] ?? 0;
      let pnlUsd = 0;
      let win = null;

      if (trade && winnerSide) {
        win = trade.side === winnerSide;
        pnlUsd = win ? (trade.shares * (1 - trade.bidPrice)) : -trade.amountUsd;
        state.balanceUsd += trade.amountUsd + pnlUsd;
        state.totalPnlUsd += pnlUsd;
      }

      if (state.balanceUsd <= 0 && knobs.budgetResetAmount > 0) {
        state.resets += 1;
        aggregateResets += 1;
        state.balanceUsd = knobs.budgetResetAmount;
      }

      state.rounds += 1;
      aggregateRoundPnl += pnlUsd;
      aggregateRoundBids += bidsInRound;

      scenarioOutcomes.push({
        scenarioKey: def.key,
        scenarioLabel: def.label,
        marketSlug,
        settledAt: new Date(settledAtMs).toISOString(),
        bidsInRound,
        roundPnlUsd: pnlUsd,
        totalPnlUsd: state.totalPnlUsd,
        balanceUsd: state.balanceUsd,
        rounds: state.rounds,
        totalBids: state.totalBids,
        resets: state.resets,
        riskAppetite: state.riskAppetite,
        threshold: state.threshold,
        side: trade?.side ?? "",
        winnerSide: winnerSide ?? "",
        win
      });

      try {
        appendCsvRow("./logs/sim_scenarios_rounds.csv", [
          "settled_at",
          "market_slug",
          "scenario",
          "risk_appetite",
          "threshold",
          "bids_in_round",
          "round_pnl_usd",
          "scenario_total_pnl_usd",
          "scenario_balance_usd",
          "scenario_rounds",
          "scenario_total_bids",
          "scenario_resets",
          "trade_side",
          "winner_side",
          "win"
        ], [
          new Date(settledAtMs).toISOString(),
          marketSlug,
          def.key,
          state.riskAppetite.toFixed(4),
          state.threshold.toFixed(2),
          String(bidsInRound),
          toMoney(pnlUsd),
          toMoney(state.totalPnlUsd),
          toMoney(state.balanceUsd),
          String(state.rounds),
          String(state.totalBids),
          String(state.resets),
          trade?.side ?? "",
          winnerSide ?? "",
          win === null ? "" : String(win)
        ]);
      } catch {
        // ignore logging errors
      }
      delete tradeByScenarioAndSlug[roundKey];
    }

    try {
      const totalPnl = definitions.reduce((acc, d) => acc + scenarios[d.key].totalPnlUsd, 0);
      appendCsvRow("./logs/sim_scenarios_overall.csv", [
        "settled_at",
        "market_slug",
        "round_total_bids",
        "round_total_pnl_usd",
        "overall_total_pnl_usd",
        "total_rounds_each",
        "total_resets_this_round"
      ], [
        new Date(settledAtMs).toISOString(),
        marketSlug,
        String(aggregateRoundBids),
        toMoney(aggregateRoundPnl),
        toMoney(totalPnl),
        String(definitions.map((d) => scenarios[d.key].rounds).join("|")),
        String(aggregateResets)
      ]);
    } catch {
      // ignore logging errors
    }

    round.settled = true;
    const settlement = {
      marketSlug,
      settledAt: new Date(settledAtMs).toISOString(),
      finalPrice: Number(finalPrice),
      priceToBeat: Number(priceToBeat),
      winnerSide,
      roundTotalBids: aggregateRoundBids,
      roundPnlUsd: aggregateRoundPnl,
      overallPnlUsd: definitions.reduce((acc, d) => acc + scenarios[d.key].totalPnlUsd, 0),
      scenarioOutcomes
    };
    recentSettlements.unshift(settlement);
    if (recentSettlements.length > 50) recentSettlements.length = 50;
    return settlement;
  }

  function getSummaryLine() {
    const bits = definitions.map((d) => {
      const s = scenarios[d.key];
      const sign = s.totalPnlUsd >= 0 ? "+" : "";
      return `${d.label}: rounds=${s.rounds} bids=${s.totalBids} pnl=${sign}$${formatNumber(s.totalPnlUsd, 2)} bal=$${formatNumber(s.balanceUsd, 2)} resets=${s.resets}`;
    });
    const total = definitions.reduce((acc, d) => acc + scenarios[d.key].totalPnlUsd, 0);
    const totalSign = total >= 0 ? "+" : "";
    bits.push(`Overall PnL=${totalSign}$${formatNumber(total, 2)}`);
    return bits.join(" | ");
  }

  function applyRuntimeControls(next = {}) {
    let changed = false;
    const parsed = {
      baseRisk: next.riskAppetite,
      step: next.riskAppetiteStep,
      fixedBidPrice: next.maxBidPrice,
      budgetResetAmount: next.budgetUsd,
      betAmountUsd: next.betAmountUsd,
      baseThreshold: next.tradeThreshold,
      entryMaxTimeLeftMin: next.entryMaxTimeLeftMin,
      entryMinTimeLeftMin: next.entryMinTimeLeftMin
    };
    for (const [k, raw] of Object.entries(parsed)) {
      if (raw === undefined || raw === null || raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      const before = knobs[k];
      if (k === "baseRisk") knobs[k] = normalizeRiskAppetite(n, knobs.baseRisk);
      else if (k === "step") knobs[k] = clamp(n, 0, 0.5);
      else if (k === "fixedBidPrice") knobs[k] = clamp(n, 0.01, 0.99);
      else if (k === "budgetResetAmount") knobs[k] = Math.max(0, n);
      else if (k === "betAmountUsd") knobs[k] = Math.max(0, n);
      else if (k === "baseThreshold") knobs[k] = clamp(n, 1, 100);
      else if (k === "entryMaxTimeLeftMin") knobs[k] = clamp(n, 0.1, 20);
      else if (k === "entryMinTimeLeftMin") knobs[k] = clamp(n, 0, 20);
      if (knobs[k] !== before) changed = true;
    }
    if (knobs.entryMinTimeLeftMin > knobs.entryMaxTimeLeftMin) {
      const tmp = knobs.entryMinTimeLeftMin;
      knobs.entryMinTimeLeftMin = knobs.entryMaxTimeLeftMin;
      knobs.entryMaxTimeLeftMin = tmp;
      changed = true;
    }
    if (!changed) return false;

    const nextDefs = computeDefinitions(knobs.baseRisk, knobs.step);
    for (const def of nextDefs) {
      const state = scenarios[def.key];
      state.riskAppetite = def.riskAppetite;
      state.threshold = scenarioThreshold(knobs.baseThreshold, def.riskAppetite, knobs.baseRisk);
      if (state.balanceUsd <= 0 && knobs.budgetResetAmount > 0) {
        state.balanceUsd = knobs.budgetResetAmount;
      }
    }
    return true;
  }

  function resetSimulationState({ clearOpenTrades = true } = {}) {
    for (const def of definitions) {
      const state = scenarios[def.key];
      state.balanceUsd = knobs.budgetResetAmount;
      state.totalPnlUsd = 0;
      state.rounds = 0;
      state.resets = 0;
      state.totalBids = 0;
      state.threshold = scenarioThreshold(knobs.baseThreshold, state.riskAppetite, knobs.baseRisk);
    }
    for (const key of Object.keys(roundsBySlug)) delete roundsBySlug[key];
    if (clearOpenTrades) {
      for (const key of Object.keys(tradeByScenarioAndSlug)) delete tradeByScenarioAndSlug[key];
    }
    recentSettlements.length = 0;
    recentDecisions.length = 0;
  }

  function getSnapshot() {
    const scenariosList = definitions.map((d) => {
      const s = scenarios[d.key];
      return {
        key: d.key,
        label: d.label,
        riskAppetite: s.riskAppetite,
        threshold: s.threshold,
        balanceUsd: s.balanceUsd,
        totalPnlUsd: s.totalPnlUsd,
        rounds: s.rounds,
        totalBids: s.totalBids,
        resets: s.resets
      };
    });
    return {
      summaryLine: getSummaryLine(),
      knobs: {
        maxBidPrice: knobs.fixedBidPrice,
        budgetUsd: knobs.budgetResetAmount,
        betAmountUsd: knobs.betAmountUsd,
        tradeThreshold: knobs.baseThreshold,
        riskAppetite: knobs.baseRisk,
        riskAppetiteStep: knobs.step,
        entryMinTimeLeftMin: knobs.entryMinTimeLeftMin,
        entryMaxTimeLeftMin: knobs.entryMaxTimeLeftMin
      },
      scenarios: scenariosList,
      overallPnlUsd: scenariosList.reduce((acc, x) => acc + x.totalPnlUsd, 0),
      recentSettlements: recentSettlements.slice(0, 20),
      recentDecisions: recentDecisions.slice(0, 60)
    };
  }

  return {
    definitions,
    maybePlaceScenarioTrades,
    settleRound,
    getSummaryLine,
    getSnapshot,
    applyRuntimeControls,
    resetSimulationState
  };
}
