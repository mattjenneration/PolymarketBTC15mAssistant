import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.resolve(process.cwd(), "logs");
const ROUNDS_CSV = path.join(LOG_DIR, "sim_scenarios_rounds.csv");
const OVERALL_CSV = path.join(LOG_DIR, "sim_scenarios_overall.csv");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { hours: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--hours") {
      const next = Number(args[i + 1]);
      if (Number.isFinite(next) && next > 0) {
        out.hours = next;
        i += 1;
      }
    }
  }
  return out;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cur += c;
      }
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else if (c === '"') {
      inQ = true;
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j += 1) {
      row[header[j]] = cells[j] ?? "";
    }
    rows.push(row);
  }
  return rows;
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function fmtUsd(n) {
  const sign = n >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n) {
  if (!Number.isFinite(n)) return "n/a";
  return `${(n * 100).toFixed(1)}%`;
}

function printRow(cols) {
  console.log(cols.join(" | "));
}

function main() {
  const { hours } = parseArgs();
  const rounds = readCsv(ROUNDS_CSV);
  const overall = readCsv(OVERALL_CSV);

  if (!rounds.length) {
    console.log("No simulation rounds found in logs/sim_scenarios_rounds.csv");
    console.log("Run the bot in simulation mode first.");
    process.exit(0);
  }

  const cutoffMs = Number.isFinite(hours) ? Date.now() - hours * 3600_000 : null;
  const inRange = (iso) => {
    if (!cutoffMs) return true;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) && t >= cutoffMs;
  };

  const scopedRounds = rounds.filter((r) => inRange(r.settled_at));
  const scopedOverall = overall.filter((r) => inRange(r.settled_at));

  if (!scopedRounds.length) {
    console.log(`No scenario rows found for last ${hours} hour(s).`);
    process.exit(0);
  }

  const byScenario = new Map();
  for (const row of scopedRounds) {
    const key = String(row.scenario || "unknown");
    if (!byScenario.has(key)) {
      byScenario.set(key, {
        rounds: 0,
        bids: 0,
        roundPnl: 0,
        wins: 0,
        losses: 0,
        resets: 0,
        latestBalance: 0,
        riskAppetite: toNum(row.risk_appetite),
        threshold: toNum(row.threshold)
      });
    }
    const s = byScenario.get(key);
    s.rounds += 1;
    s.bids += toNum(row.bids_in_round);
    s.roundPnl += toNum(row.round_pnl_usd);
    s.resets = Math.max(s.resets, toNum(row.scenario_resets));
    s.latestBalance = toNum(row.scenario_balance_usd);
    const win = String(row.win).toLowerCase();
    if (win === "true") s.wins += 1;
    if (win === "false") s.losses += 1;
  }

  const aggregatePnl = scopedOverall.reduce((acc, r) => acc + toNum(r.round_total_pnl_usd), 0);
  const aggregateBids = scopedOverall.reduce((acc, r) => acc + toNum(r.round_total_bids), 0);
  const aggregateRounds = scopedOverall.length;

  console.log("");
  console.log("=== Scenario Post-Run Report ===");
  console.log(`Window: ${hours ? `last ${hours}h` : "all available logs"}`);
  console.log(`Rounds: ${aggregateRounds} | Total bids: ${aggregateBids} | Overall PnL: ${fmtUsd(aggregatePnl)}`);
  console.log("");
  printRow(["Scenario", "Risk", "Threshold", "Rounds", "Bids", "Wins", "Losses", "Win rate", "PnL", "Avg/round", "Resets", "Balance"]);
  printRow(["--------", "----", "---------", "------", "----", "----", "------", "--------", "---", "---------", "------", "-------"]);

  const ordered = [...byScenario.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, s] of ordered) {
    const decisions = s.wins + s.losses;
    const winRate = decisions > 0 ? s.wins / decisions : NaN;
    const avgRoundPnl = s.rounds > 0 ? s.roundPnl / s.rounds : 0;
    printRow([
      name,
      s.riskAppetite.toFixed(2),
      s.threshold.toFixed(1),
      String(s.rounds),
      String(s.bids),
      String(s.wins),
      String(s.losses),
      fmtPct(winRate),
      fmtUsd(s.roundPnl),
      fmtUsd(avgRoundPnl),
      String(s.resets),
      `$${s.latestBalance.toFixed(2)}`
    ]);
  }

  console.log("");
  console.log("Tip: run with --hours 24 after each tuning cycle for apples-to-apples comparisons.");
}

main();
