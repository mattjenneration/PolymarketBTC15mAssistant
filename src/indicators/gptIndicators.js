import { clamp } from "../utils.js";
import { scoreFundingIndicator } from "./gptFunding.js";
import { scoreOpenInterestIndicator } from "./gptOpenInterest.js";
import { scoreLongShortIndicator } from "./gptLongShort.js";
import { scoreBasisIndicator } from "./gptBasis.js";
import { scorePolymarketMicroIndicator } from "./gptPolymarketMicro.js";

function scoreMomentumDislocation({ spotDelta1m, spotDelta3m, polymarketSnapshot }) {
  const name = "momentum_dislocation";
  const maxAbsScore = 12;

  const d1 = Number.isFinite(Number(spotDelta1m)) ? Number(spotDelta1m) : null;
  const d3 = Number.isFinite(Number(spotDelta3m)) ? Number(spotDelta3m) : null;
  const up = Number(polymarketSnapshot?.prices?.up);
  const down = Number(polymarketSnapshot?.prices?.down);

  if ((d1 === null && d3 === null) || !Number.isFinite(up) || !Number.isFinite(down) || up + down <= 0) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "Dislocation unavailable"
    };
  }

  const spotBias = (d1 ?? 0) * 0.6 + (d3 ?? 0) * 0.4;
  const marketUp = up / (up + down);
  const marketDown = down / (up + down);

  let score = 0;
  if (spotBias > 0 && marketUp < 0.5) score += 12;
  if (spotBias < 0 && marketDown < 0.5) score -= 12;
  if (spotBias > 0 && marketUp > 0.58) score -= 4;
  if (spotBias < 0 && marketDown > 0.58) score += 4;

  score = clamp(score, -maxAbsScore, maxAbsScore);

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: spotBias,
    summary: `Dislocation ${score >= 0 ? "+" : ""}${score}`
  };
}

export function evaluateGptIndicators({ futuresSnapshot, polymarketSnapshot, spotDelta1m, spotDelta3m }) {
  const signals = [
    scoreFundingIndicator({ fundingRate: futuresSnapshot?.fundingRate ?? null }),
    scoreOpenInterestIndicator({
      openInterestDeltaPct: futuresSnapshot?.openInterestDeltaPct ?? null,
      spotDelta3m
    }),
    scoreLongShortIndicator({
      longShortRatio: futuresSnapshot?.longShortRatio ?? null,
      longShortDelta: futuresSnapshot?.longShortDelta ?? null
    }),
    scoreBasisIndicator({ basisPct: futuresSnapshot?.basisPct ?? null }),
    scorePolymarketMicroIndicator({ polymarketSnapshot }),
    scoreMomentumDislocation({ spotDelta1m, spotDelta3m, polymarketSnapshot })
  ];

  const totalScore = signals.reduce((acc, x) => acc + x.score, 0);
  const totalAbsMax = signals.reduce((acc, x) => acc + x.maxAbsScore, 0);
  const normalized = totalAbsMax > 0 ? clamp((totalScore / totalAbsMax) * 100, -100, 100) : 0;

  return {
    score: normalized,
    direction: normalized > 0 ? "UP" : normalized < 0 ? "DOWN" : "FLAT",
    confidence: Math.round(Math.abs(normalized)),
    indicators: signals,
    byName: Object.fromEntries(signals.map((x) => [x.name, x]))
  };
}
