import { clamp } from "../utils.js";

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

export function scorePolymarketMicroIndicator({ polymarketSnapshot }) {
  const name = "polymarket_micro";
  const maxAbsScore = 22;

  if (!polymarketSnapshot?.ok) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "Polymarket snapshot unavailable"
    };
  }

  const upBidLiq = safeNumber(polymarketSnapshot.orderbook?.up?.bidLiquidity);
  const downBidLiq = safeNumber(polymarketSnapshot.orderbook?.down?.bidLiquidity);
  const upSpread = safeNumber(polymarketSnapshot.orderbook?.up?.spread);
  const downSpread = safeNumber(polymarketSnapshot.orderbook?.down?.spread);
  const upPrice = safeNumber(polymarketSnapshot.prices?.up);
  const downPrice = safeNumber(polymarketSnapshot.prices?.down);

  let score = 0;

  if (upBidLiq !== null && downBidLiq !== null) {
    const ratio = (upBidLiq + 1) / (downBidLiq + 1);
    const balance = clamp((ratio - 1) / 0.4, -1, 1);
    score += Math.round(balance * 9);
  }

  if (upSpread !== null && downSpread !== null) {
    if (upSpread < downSpread * 0.8) score += 5;
    else if (downSpread < upSpread * 0.8) score -= 5;
  }

  if (upPrice !== null && downPrice !== null) {
    const mktUpProb = upPrice / (upPrice + downPrice);
    const mktDownProb = downPrice / (upPrice + downPrice);
    if (mktUpProb > 0.56) score += 8;
    else if (mktDownProb > 0.56) score -= 8;
  }

  score = clamp(score, -maxAbsScore, maxAbsScore);

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: score,
    summary: `Micro score ${score >= 0 ? "+" : ""}${score}`
  };
}
