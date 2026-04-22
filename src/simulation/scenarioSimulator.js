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

export function createScenarioSimulator(tradingConfig) {
  const baseRisk = normalizeRiskAppetite(tradingConfig?.riskAppetite, 0.5);
  const step = clamp(Number(tradingConfig?.riskAppetiteStep ?? 0.2), 0, 0.5);
  const fixedBidPrice = clamp(Number(tradingConfig?.maxBidPrice ?? 0.95), 0.01, 0.99);
  const budgetResetAmount = Math.max(0, Number(tradingConfig?.simBudgetUsd ?? 0));
  const betAmountUsd = Math.max(0, Number(tradingConfig?.simBetAmountUsd ?? 0));
  const baseThreshold = clamp(Number(tradingConfig?.tradeThreshold ?? 75), 1, 100);

  const definitions = [
    { key: "optimistic", label: "Optimistic", riskAppetite: clamp(baseRisk + step, 0, 1) },
    { key: "normal", label: "Normal", riskAppetite: baseRisk },
    { key: "cautious", label: "Cautious", riskAppetite: clamp(baseRisk - step, 0, 1) }
  ];

  const scenarios = Object.fromEntries(
    definitions.map((d) => [d.key, {
      ...d,
      threshold: scenarioThreshold(baseThreshold, d.riskAppetite, baseRisk),
      balanceUsd: budgetResetAmount,
      totalPnlUsd: 0,
      rounds: 0,
      resets: 0,
      totalBids: 0
    }])
  );

  const roundsBySlug = {};
  const tradeByScenarioAndSlug = {};
  const recentSettlements = [];

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
    if (betAmountUsd <= 0 || budgetResetAmount <= 0) return [];
    if (!Number.isFinite(Number(confidenceScore)) || confidenceDirection === "FLAT") return [];
    if (!Number.isFinite(Number(timeLeftMin)) || Number(timeLeftMin) > 2 || Number(timeLeftMin) < 1.5) return [];

    const side = Number(confidenceScore) >= 0 ? "UP" : "DOWN";
    const round = ensureRound(marketSlug);
    const fills = [];

    for (const def of definitions) {
      const state = scenarios[def.key];
      const roundKey = `${def.key}:${marketSlug}`;
      if (tradeByScenarioAndSlug[roundKey]) continue;

      const absConf = Math.abs(Number(confidenceScore));
      if (absConf < state.threshold) continue;
      if (state.balanceUsd < betAmountUsd) continue;

      const shares = betAmountUsd / fixedBidPrice;
      const trade = {
        placedAt: now.toISOString(),
        marketSlug,
        scenarioKey: def.key,
        scenarioLabel: def.label,
        side,
        confidenceScore: Number(confidenceScore),
        confidenceDirection,
        bidPrice: fixedBidPrice,
        amountUsd: betAmountUsd,
        shares
      };

      state.balanceUsd -= betAmountUsd;
      state.totalBids += 1;
      round.bidsByScenario[def.key] += 1;
      tradeByScenarioAndSlug[roundKey] = trade;
      fills.push(trade);
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

      if (state.balanceUsd <= 0 && budgetResetAmount > 0) {
        state.resets += 1;
        aggregateResets += 1;
        state.balanceUsd = budgetResetAmount;
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
      scenarios: scenariosList,
      overallPnlUsd: scenariosList.reduce((acc, x) => acc + x.totalPnlUsd, 0),
      recentSettlements: recentSettlements.slice(0, 20)
    };
  }

  return {
    definitions,
    maybePlaceScenarioTrades,
    settleRound,
    getSummaryLine,
    getSnapshot
  };
}
