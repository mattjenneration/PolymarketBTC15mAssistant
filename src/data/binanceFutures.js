import { CONFIG } from "../config.js";

function toNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(url, label) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${label} error: ${res.status} ${await res.text()}`);
  }
  return await res.json();
}

export async function fetchBinanceFuturesSnapshot({ symbol = CONFIG.symbol } = {}) {
  const fundingUrl = new URL("/fapi/v1/fundingRate", CONFIG.binanceBaseUrl);
  fundingUrl.searchParams.set("symbol", symbol);
  fundingUrl.searchParams.set("limit", "1");

  const openInterestHistUrl = new URL("/futures/data/openInterestHist", CONFIG.binanceBaseUrl);
  openInterestHistUrl.searchParams.set("symbol", symbol);
  openInterestHistUrl.searchParams.set("period", "5m");
  openInterestHistUrl.searchParams.set("limit", "3");

  const longShortUrl = new URL("/futures/data/globalLongShortAccountRatio", CONFIG.binanceBaseUrl);
  longShortUrl.searchParams.set("symbol", symbol);
  longShortUrl.searchParams.set("period", "5m");
  longShortUrl.searchParams.set("limit", "3");

  const premiumIndexUrl = new URL("/fapi/v1/premiumIndex", CONFIG.binanceBaseUrl);
  premiumIndexUrl.searchParams.set("symbol", symbol);

  const [fundingData, oiHistData, longShortData, premiumIndexData] = await Promise.all([
    fetchJson(fundingUrl, "Binance futures funding").catch(() => null),
    fetchJson(openInterestHistUrl, "Binance futures open interest").catch(() => null),
    fetchJson(longShortUrl, "Binance futures long short").catch(() => null),
    fetchJson(premiumIndexUrl, "Binance futures premium index").catch(() => null)
  ]);

  const fundingRow = Array.isArray(fundingData) ? fundingData[fundingData.length - 1] : null;

  const oiRows = Array.isArray(oiHistData) ? oiHistData : [];
  const oiLast = oiRows.length ? oiRows[oiRows.length - 1] : null;
  const oiPrev = oiRows.length >= 2 ? oiRows[oiRows.length - 2] : null;

  const longShortRows = Array.isArray(longShortData) ? longShortData : [];
  const longShortLast = longShortRows.length ? longShortRows[longShortRows.length - 1] : null;
  const longShortPrev = longShortRows.length >= 2 ? longShortRows[longShortRows.length - 2] : null;

  const markPrice = toNumber(premiumIndexData?.markPrice);
  const indexPrice = toNumber(premiumIndexData?.indexPrice);
  const basisPct = markPrice !== null && indexPrice !== null && indexPrice !== 0
    ? (markPrice - indexPrice) / indexPrice
    : null;

  const openInterestLast = toNumber(oiLast?.sumOpenInterestValue);
  const openInterestPrev = toNumber(oiPrev?.sumOpenInterestValue);
  const openInterestDeltaPct = openInterestLast !== null && openInterestPrev !== null && openInterestPrev !== 0
    ? (openInterestLast - openInterestPrev) / openInterestPrev
    : null;

  const longShortRatio = toNumber(longShortLast?.longShortRatio);
  const longShortPrevRatio = toNumber(longShortPrev?.longShortRatio);
  const longShortDelta = longShortRatio !== null && longShortPrevRatio !== null
    ? longShortRatio - longShortPrevRatio
    : null;

  return {
    ok: Boolean(fundingRow || oiLast || longShortLast || premiumIndexData),
    fundingRate: toNumber(fundingRow?.fundingRate),
    nextFundingTime: fundingRow?.fundingTime ?? premiumIndexData?.nextFundingTime ?? null,
    openInterestValue: openInterestLast,
    openInterestDeltaPct,
    longShortRatio,
    longShortDelta,
    markPrice,
    indexPrice,
    basisPct
  };
}
