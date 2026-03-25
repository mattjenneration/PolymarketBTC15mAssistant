import { clamp } from "../utils.js";

export function scoreLongShortIndicator({ longShortRatio, longShortDelta }) {
  const name = "long_short";
  const maxAbsScore = 14;

  if (!Number.isFinite(Number(longShortRatio))) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "L/S unavailable"
    };
  }

  const ratio = Number(longShortRatio);
  const delta = Number.isFinite(Number(longShortDelta)) ? Number(longShortDelta) : 0;

  const overLong = clamp((ratio - 1) / 0.25, 0, 1);
  const overShort = clamp((1 - ratio) / 0.25, 0, 1);

  let score = 0;
  if (overLong > 0) score -= Math.round(4 + overLong * 10);
  if (overShort > 0) score += Math.round(4 + overShort * 10);

  if (delta > 0.04) score -= 2;
  if (delta < -0.04) score += 2;

  score = clamp(score, -maxAbsScore, maxAbsScore);

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: ratio,
    summary: `L/S ${ratio.toFixed(3)} (${delta >= 0 ? "+" : ""}${delta.toFixed(3)})`
  };
}
