/**
 * Lightweight tests for the relayer-based trading flow.
 * Run with: npm run test:trading
 * (Uses env without POLYMARKET_FUNDER_ADDRESS so CONFIG loads with no funder.)
 */
import { describe, it } from "node:test";
import assert from "node:assert";

describe("executeTradeIfEnabled with relayer/smart wallet", () => {
  it("returns skipped with missing_funder_address when POLYMARKET_FUNDER_ADDRESS is not set", async () => {
    const { executeTradeIfEnabled } = await import("./polymarketTrade.js");
    const { CONFIG } = await import("../config.js");
    if (CONFIG.polymarket?.funderAddress?.trim()) {
      console.warn("Skip: POLYMARKET_FUNDER_ADDRESS is set; run with npm run test:trading so funder is unset");
      return;
    }
    const result = await executeTradeIfEnabled({
      side: "UP",
      amountUsd: 10,
      marketSnapshot: { ok: true, tokens: { upTokenId: "1", downTokenId: "2" }, prices: { up: 50, down: 50 } },
      confidenceScore: 80
    });
    assert.strictEqual(result.status, "skipped");
    assert.strictEqual(result.reason, "missing_funder_address");
  });
});

describe("getUsdcBalanceUsd", () => {
  it("returns null when funder address is not set", async () => {
    const { getUsdcBalanceUsd } = await import("./polymarketTrade.js");
    const { CONFIG } = await import("../config.js");
    if (CONFIG.polymarket?.funderAddress?.trim()) {
      console.warn("Skip: POLYMARKET_FUNDER_ADDRESS is set");
      return;
    }
    const balance = await getUsdcBalanceUsd();
    assert.strictEqual(balance, null);
  });
});
