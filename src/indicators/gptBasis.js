import { clamp } from "../utils.js";

export function scoreBasisIndicator({ basisPct }) {
  const name = "basis";
  const maxAbsScore = 12;

  if (!Number.isFinite(Number(basisPct))) {
    return {
      name,
      score: 0,
      maxAbsScore,
      confidence: 0,
      direction: "FLAT",
      value: null,
      summary: "Basis unavailable"
    };
  }

  const basis = Number(basisPct);
  const intensity = clamp(Math.abs(basis) / 0.0008, 0, 1);

  let score = 0;
  if (basis > 0) score = -Math.round(2 + intensity * 10);
  else if (basis < 0) score = Math.round(2 + intensity * 10);

  score = clamp(score, -maxAbsScore, maxAbsScore);

  return {
    name,
    score,
    maxAbsScore,
    confidence: Math.round((Math.abs(score) / maxAbsScore) * 100),
    direction: score > 0 ? "UP" : score < 0 ? "DOWN" : "FLAT",
    value: basis,
    summary: `Basis ${(basis * 100).toFixed(3)}%`
  };
}
