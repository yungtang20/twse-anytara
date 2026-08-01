import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import express from "express";
import { calcATR, calcRSI, type PriceData } from "../src/lib/indicators";
import { clampSidebarWidth } from "../src/components/Layout";
import { SupportResistanceEngine } from "../src/lib/strategy-engine";
import apiRouter from "../server/routes";
import {
  isLoopbackAddress,
  validateEnvValue,
} from "../server/lib/security";
import { buildStockSnapshot, formatSnapshotForPrompt } from "../server/lib/stockSnapshot";
import { validateEvidenceReport } from "../server/lib/evidenceReport";
import { runMigrations } from "../server/lib/migrations";
import { fetchWithOneRetry } from "../server/lib/fetchRetry";
import { withAbortSignal } from "../server/lib/mcpClient";
import { createJobDedupeKey, mapWithConcurrency } from "../server/lib/jobQueue";
import { selectFinMindDatasetNames } from "../server/mvpMcpRoutes";
import { parseTdccCSV, saveTdccToSQLite } from "../server/lib/tdccDownload";
import { isOrdinaryStockId } from "../server/lib/stockUniverse";
import { describeSupabaseError } from "../server/lib/supabaseDiagnostics";
import { ensureCanonicalSchema } from "../server/lib/sqliteSchema";
import { hasUsableLocalPriceRows } from "../server/lib/marketDataRepository";
import { resolveDatabasePath } from "../server/db";
import { listPendingCalendarDates } from "../scripts/lib/syncDates";
import { sortTrustBuyByDays } from "../server/routes/dashboard";
import { buildSimulatedPriceProjection } from "../server/lib/priceProjection";
import { analyzeChartPattern } from "../server/lib/patternStrategy";
import { DEFAULT_NVIDIA_MODEL, NVIDIA_BASE_URL, nvidiaModel } from "../server/lib/nvidiaAi";
import { appViewHash, parseAppView } from "../src/lib/navigation";
import { buildIntegratedMarketData } from "../src/lib/integratedMarketData";
import {
  buildSupportResistanceLines,
  selectExtremeAnchors,
  selectTrendAnchors,
} from "../src/lib/trendLines";
import {
  formatPriceAxisTick,
  formatTrendLegendLabel,
  mondayTicks,
} from "../src/lib/chartFormatting";

const rising = Array.from({ length: 20 }, (_, index) => 100 + index);
assert.equal(NVIDIA_BASE_URL, "https://integrate.api.nvidia.com/v1");
assert.equal(DEFAULT_NVIDIA_MODEL, "z-ai/glm-5.2");
assert.equal(nvidiaModel(), process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL);

function patternFixture(kind: "bottom" | "top", secondIndex = 50, confirmed = true) {
  const rows = Array.from({ length: 60 }, (_, index) => {
    const base = kind === "bottom" ? 100 : 120;
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    return {
      stock_id: "TEST", date, open: base, high: base + 2, low: base - 2,
      close: base, volume: index === 59 ? 2_000 : 1_000,
    };
  });
  if (kind === "bottom") {
    rows[30].low = 90;
    rows[40].high = 110;
    rows[secondIndex].low = 91;
    rows[59].close = confirmed ? 112 : 105;
    rows[59].high = Math.max(rows[59].high, rows[59].close + 1);
  } else {
    rows[30].high = 130;
    rows[40].low = 108;
    rows[secondIndex].high = 129;
    rows[59].close = confirmed ? 106 : 115;
    rows[59].low = Math.min(rows[59].low, rows[59].close - 1);
  }
  return rows;
}

const confirmedBottom = analyzeChartPattern(patternFixture("bottom"));
assert.equal(confirmedBottom.patternName, "W底");
assert.equal(confirmedBottom.stage, "confirmed");
assert.equal(confirmedBottom.secondPivot?.price, 91);
assert.equal(confirmedBottom.breakoutDate, "2026-03-01");
assert.ok(confirmedBottom.confidence >= 0.7);
const formingBottom = analyzeChartPattern(patternFixture("bottom", 50, false));
assert.equal(formingBottom.patternName, "W底");
assert.equal(formingBottom.stage, "forming");
const confirmedTop = analyzeChartPattern(patternFixture("top"));
assert.equal(confirmedTop.patternName, "M頂");
assert.equal(confirmedTop.stage, "confirmed");
assert.equal(
  analyzeChartPattern(patternFixture("bottom", 45)).stage,
  "none",
  "patterns whose second pivot is older than ten bars must not be shown",
);
const syncRouteSource = readFileSync(
  path.join(process.cwd(), "server", "routes", "syncBackfill.ts"),
  "utf8",
);
const settingsRouteSource = readFileSync(
  path.join(process.cwd(), "server", "routes", "settings.ts"),
  "utf8",
);
const cloudSyncSource = readFileSync(
  path.join(process.cwd(), "scripts", "syncData.ts"),
  "utf8",
);
const retentionMigrationSource = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20260731030000_align_market_retention.sql"),
  "utf8",
);
const volumeUnitMigrationSource = readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260731043043_normalize_stock_price_volume_units.sql",
  ),
  "utf8",
);
const chipsChartSource = readFileSync(
  path.join(process.cwd(), "src", "components", "ChipsBarChart.tsx"),
  "utf8",
);
const klineChartSource = readFileSync(
  path.join(process.cwd(), "src", "components", "KlineChart.tsx"),
  "utf8",
);
const integratedPanelsSource = readFileSync(
  path.join(process.cwd(), "src", "components", "IntegratedMarketPanels.tsx"),
  "utf8",
);
const marketsViewSource = readFileSync(
  path.join(process.cwd(), "src", "components", "views", "MarketsView.tsx"),
  "utf8",
);
const marketWorkflowSource = readFileSync(
  path.join(process.cwd(), ".github", "workflows", "supabase-market-sync.yml"),
  "utf8",
);
const tdccWorkflowSource = readFileSync(
  path.join(process.cwd(), ".github", "workflows", "supabase-tdcc-sync.yml"),
  "utf8",
);
const triggerUpdateSource = syncRouteSource.split('router.post("/api/trigger-update"')[1]
  ?.split('// GET Endpoint to poll sync progress')[0] || "";
assert.match(
  triggerUpdateSource,
  /scripts[\\/]syncData\.ts/,
  "the web update action must upload the latest market data to Supabase",
);
assert.doesNotMatch(
  triggerUpdateSource,
  /complete_and_fetch_today|pull_from_supabase/,
  "the Supabase web update action must remain independent from local SQLite sync",
);
assert.match(
  settingsRouteSource,
  /router\.post\("\/api\/settings\/sync-bridge"[\s\S]*?status\(410\)/,
  "the retired bidirectional bridge must not mix Supabase and local SQLite",
);
assert.match(cloudSyncSource, /INITIAL_INSTITUTIONAL_DATES = 60/);
assert.match(cloudSyncSource, /INSTITUTIONAL_RETENTION = 512/);
assert.match(cloudSyncSource, /TDCC_RETENTION = 512/);
assert.match(cloudSyncSource, /PRICE_RETENTION - status\.price_dates/);
assert.match(cloudSyncSource, /SYNC_SCOPE !== "tdcc"/);
assert.match(cloudSyncSource, /SYNC_SCOPE !== "market"/);
assert.match(marketWorkflowSource, /cron: "0 10 \* \* 1-5"/);
assert.match(marketWorkflowSource, /SYNC_SCOPE: market/);
assert.match(tdccWorkflowSource, /cron: "0 10 \* \* 6"/);
assert.match(tdccWorkflowSource, /SYNC_SCOPE: tdcc/);
assert.doesNotMatch(marketsViewSource, /\/api\/sync-status|\/api\/trigger-update/);
assert.match(marketsViewSource, /Supabase 資料庫日期/);
assert.equal(isOrdinaryStockId("2330"), true);
assert.equal(isOrdinaryStockId("9910"), true);
assert.equal(isOrdinaryStockId("0050"), false);
assert.equal(isOrdinaryStockId("9103"), false);
assert.equal(isOrdinaryStockId("2881A"), false);
assert.deepEqual(
  sortTrustBuyByDays([
    { stock_id: "2886", trust_days: 10 },
    { stock_id: "2027", trust_days: 6 },
    { stock_id: "1326", trust_days: 6 },
  ]),
  [
    { stock_id: "1326", trust_days: 6 },
    { stock_id: "2027", trust_days: 6 },
    { stock_id: "2886", trust_days: 10 },
  ],
);
assert.deepEqual(
  buildIntegratedMarketData(
    ["2026-07-31"],
    [{ date: "2026-07-31", foreign_net: -3_957_455, trust_net: 7_046_889 }],
    [],
  )[0],
  { date: "2026-07-31", foreign: -3957, trust: 7046, whaleRatio: null },
  "institutional shares must use the same whole-lot truncation in every chart and table",
);
assert.deepEqual(
  mondayTicks(["2026-07-24", "2026-07-27", "2026-07-31", "2026-08-03"]),
  ["2026-07-27", "2026-08-03"],
);
assert.equal(parseAppView(""), "markets");
assert.equal(parseAppView("#/ai-analysis"), "ai-analysis");
assert.equal(parseAppView("#/unknown"), "markets");
assert.equal(appViewHash("markets"), "#/markets");
const simulatedProjection = buildSimulatedPriceProjection(
  Array.from({ length: 20 }, (_, index) => ({ close: 100 + index })),
);
assert.equal(simulatedProjection.isSimulated, true);
assert.equal(simulatedProjection.predictions.length, 5);
assert.match(simulatedProjection.disclaimer, /不代表未來價格/);
assert.deepEqual(
  buildIntegratedMarketData(
    ["2026-07-23", "2026-07-24", "2026-07-27", "T+1", "T+5"],
    [
      { date: "2026-07-24", foreign_net: 1_500_000, trust_net: -250_000 },
      { date: "2026-07-27", foreign_net: -500_000, trust_net: 100_000 },
    ],
    [
      { date: "2026-07-18", ratio: 60.5 },
      { date: "2026-07-25", ratio: 61.25 },
    ],
  ),
  [
    { date: "2026-07-23", foreign: null, trust: null, whaleRatio: 60.5 },
    { date: "2026-07-24", foreign: 1500, trust: -250, whaleRatio: 60.5 },
    { date: "2026-07-27", foreign: -500, trust: 100, whaleRatio: 61.25 },
    { date: "T+1", foreign: null, trust: null, whaleRatio: null },
    { date: "T+5", foreign: null, trust: null, whaleRatio: null },
  ],
);
const trendRows: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `D${index + 1}`,
  open: 100,
  high: index === 5 ? 200 : index === 10 ? 190 : index === 40 ? 180 : index === 50 ? 170 : 120,
  low: index === 6 ? 40 : index === 11 ? 45 : index === 41 ? 50 : index === 51 ? 55 : 80,
  close: index === 5
    ? 160
    : index === 6
      ? 60
      : index === 10
        ? 150
        : index === 11
          ? 65
          : index === 40
            ? 150
            : index === 41
              ? 70
              : index === 50
                ? 140
                : index === 51
                  ? 75
                  : 100,
  volume: 1_000,
}));
const trendLines = buildSupportResistanceLines(trendRows, 59);
trendRows.forEach((row, index) => {
  if (index >= 35) {
    assert.ok(
      trendLines.shortResistance[index] !== null
        && trendLines.shortResistance[index] >= row.high,
      `short resistance must stay above the high at index ${index}`,
    );
    assert.ok(
      trendLines.shortSupport[index] !== null
        && trendLines.shortSupport[index] <= row.low,
      `short support must stay below the low at index ${index}`,
    );
  }
  assert.ok(
    trendLines.longResistance[index] !== null
      && trendLines.longResistance[index] >= row.close,
    `long resistance must stay above the close at index ${index}`,
  );
  assert.ok(
    trendLines.longSupport[index] !== null
      && trendLines.longSupport[index] <= row.close,
    `long support must stay below the close at index ${index}`,
  );
});
const adjacentExtremes: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `A${index + 1}`,
  open: 300,
  high: index === 59 ? 550 : index === 40 ? 500 : index === 46 ? 490 : 400 + index * 0.1,
  low: index === 0 ? 90 : index === 10 ? 100 : index === 30 ? 150 : 300 + index * 0.1,
  close: 300,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(adjacentExtremes, 59, 60, "high", true).map(({ index }) => index),
  [59, 46],
  "anchors must use the two most recent distinct highs when scanning newest-first",
);
assert.deepEqual(
  selectTrendAnchors(adjacentExtremes, 59, 60, "low", false).map(({ index }) => index),
  [30, 10],
  "support anchors must use the two strongest distinct lows and remain newest-first",
);
const edgeAwareSwings: PriceData[] = Array.from({ length: 30 }, (_, index) => ({
  date: `S${index + 1}`,
  open: 100,
  high: index === 12 ? 150 : index === 29 ? 140 : 100 + index * 0.01,
  low: index === 4 ? 30 : index === 5 ? 40 : index === 15 ? 50 : index === 29 ? 45 : 80 + index * 0.01,
  close: 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(edgeAwareSwings, 29, 25, "high", true).map(({ index }) => index),
  [29, 12],
  "the latest candle may be a visually confirmed one-sided swing",
);
assert.deepEqual(
  selectTrendAnchors(edgeAwareSwings, 29, 25, "low", false).map(({ index }) => index),
  [29, 15],
  "the window start must use earlier candles for confirmation while the latest low remains selectable",
);
const plateauSwings: PriceData[] = Array.from({ length: 25 }, (_, index) => ({
  date: `P${index + 1}`,
  open: 100,
  high: index === 10 || index === 11
    ? 150
    : index >= 18
      ? 140 - (index - 18)
      : 100 + index * 0.01,
  low: 80 + index * 0.01,
  close: 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(plateauSwings, 24, 25, "high", true).map(({ index }) => index),
  [18, 11],
  "adjacent candles on the same plateau must count as one swing high",
);
const mixedPriceBasis: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `M${index + 1}`,
  open: 100,
  high: index === 10 ? 500 : index === 40 ? 400 : 110,
  low: index === 15 ? 1 : index === 45 ? 2 : 90,
  close: index === 20 ? 160 : index === 50 ? 150 : 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectTrendAnchors(mixedPriceBasis, 59, 60, "close", true).map(({ index }) => index),
  [50, 20],
  "long-term pressure anchors must be selectable from closes instead of intraday highs",
);
assert.deepEqual(
  selectTrendAnchors(mixedPriceBasis, 59, 60, "close", false).map(({ index }) => index),
  [52, 22],
  "long-term support anchors must follow closing-price valleys instead of intraday lows",
);
const longCloseExtremes: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `L${index + 1}`,
  open: 100,
  high: 120,
  low: 80,
  close: index === 10
    ? 200
    : index === 20
      ? 190
      : index === 30
        ? 40
        : index === 40
          ? 50
          : index === 50
            ? 180
            : index === 55
              ? 60
              : 100,
  volume: 1_000,
}));
assert.deepEqual(
  selectExtremeAnchors(longCloseExtremes, 59, 60, "close", true).map(({ index }) => index),
  [20, 10],
  "long resistance must start from the two highest distinct closing-price peaks",
);
assert.deepEqual(
  selectExtremeAnchors(longCloseExtremes, 59, 60, "close", false).map(({ index }) => index),
  [40, 30],
  "long support must start from the two lowest distinct closing-price valleys",
);
const clusteredLongPeaks: PriceData[] = Array.from({ length: 60 }, (_, index) => ({
  date: `P${index + 1}`,
  open: 70,
  high: 100,
  low: 40,
  close: index === 20 ? 88.7 : index === 21 ? 87 : index === 37 ? 85.7 : 70,
  volume: 1_000,
}));
assert.deepEqual(
  selectExtremeAnchors(clusteredLongPeaks, 59, 60, "close", true).map(({ index }) => index),
  [37, 20],
  "an adjacent candle from the same peak must not replace the second distinct peak",
);
const latestDayBoundaryBreak: PriceData[] = Array.from({ length: 25 }, (_, index) => ({
  date: `R${index + 1}`,
  open: 100,
  high: index === 5 ? 200 : index === 15 ? 190 : index === 24 ? 189 : 100,
  low: index === 5 ? 50 : index === 15 ? 60 : index === 24 ? 61 : 100,
  close: 100,
  volume: 1_000,
}));
const latestDayLines = buildSupportResistanceLines(latestDayBoundaryBreak, 24);
assert.ok(
  Number(latestDayLines.shortResistance[24]) >= latestDayBoundaryBreak[24].high,
  "short resistance must restart from the latest day when a later high crosses the line",
);
assert.ok(
  Number(latestDayLines.shortSupport[24]) <= latestDayBoundaryBreak[24].low,
  "short support must restart from the latest day when a later low crosses the line",
);
assert.equal(formatPriceAxisTick(49.999999999), "50.00");
assert.equal(formatPriceAxisTick(277.5), "277.50");
assert.equal(formatTrendLegendLabel("長壓60", 81.6), "長壓60 81.60");
assert.match(klineChartSource, /label: '均線'/);
assert.doesNotMatch(
  klineChartSource,
  /useState\(true\)/,
  "chart indicators must be opt-in rather than enabled on first load",
);
assert.doesNotMatch(klineChartSource, /均線 MA25\/60\/200/);
assert.match(klineChartSource, /\(\[26, 61, 201\] as const\)/);
assert.doesNotMatch(klineChartSource, /\[30, 60, 120, 250, 512\]/);
assert.doesNotMatch(klineChartSource, /institutionalLayer/);
assert.match(klineChartSource, /aria-pressed=\{item\.state\}/);
assert.match(klineChartSource, /showForeign/);
assert.match(klineChartSource, /showTrust/);
assert.match(klineChartSource, /showShareholding/);
assert.match(klineChartSource, /visibleDates=\{chartData\.map/);
assert.doesNotMatch(klineChartSource, /Kronos|kronos/);
assert.doesNotMatch(klineChartSource, /const drift =/);
assert.equal(klineChartSource.split("<Tooltip content={<CustomTooltip />} />").length - 1, 0);
assert.match(klineChartSource, /function CandlestickShape/);
assert.match(klineChartSource, /aria-live="polite"/);
assert.match(klineChartSource, /onMouseMove=\{handleChartMouseMove\}/);
assert.match(klineChartSource, /domain=\{priceDomain\}/);
assert.match(klineChartSource, /tickFormatter=\{formatPriceAxisTick\}/);
assert.match(klineChartSource, /<IndicatorValue label="短壓25"/);
assert.match(klineChartSource, /<VolumeDataStrip datum=\{displayDatum\} showVolMAs=\{showVolMAs\}/);
assert.match(klineChartSource, /<IndicatorValue label="VolMA5"/);
assert.match(klineChartSource, /<IndicatorValue label="VolMA60"/);
assert.match(klineChartSource, /activeDate=\{displayDatum\?\.date\}/);
assert.doesNotMatch(klineChartSource, /function LineLegend/);
assert.match(integratedPanelsSource, /selectedDate = hoveredDate \?\? activeDate/);
assert.match(integratedPanelsSource, /<InvisibleTooltip \/>/);
assert.doesNotMatch(integratedPanelsSource, /function PanelTooltip/);
assert.match(klineChartSource, /allowDataOverflow/);
assert.doesNotMatch(klineChartSource, /dataKey="wickRange"/);
assert.doesNotMatch(klineChartSource, /dataKey="boxRange"/);
assert.doesNotMatch(klineChartSource, /const CustomTooltip/);
assert.match(klineChartSource, /<IndicatorValue label="MA25"/);
assert.match(klineChartSource, /<IndicatorValue label="MA60"/);
assert.match(klineChartSource, /<IndicatorValue label="MA200"/);
const mvpRouteSource = readFileSync(
  path.join(process.cwd(), "server", "mvpMcpRoutes.ts"),
  "utf8",
);
assert.match(mvpRouteSource, /return token && failed \? request\(""\) : first/);
assert.doesNotMatch(mvpRouteSource, /error: "missing_api_key"/);
assert.match(retentionMigrationSource, /offset \(price_rows - 1\)/);
assert.match(volumeUnitMigrationSource, /set volume = volume \* 1000/);
assert.match(volumeUnitMigrationSource, /volume < 1000000/);
const finMindCacheMigrationSource = readFileSync(
  path.join(process.cwd(), "supabase", "migrations", "20260731040000_expand_finmind_cache.sql"),
  "utf8",
);
for (const dataset of ["institutional", "margin", "dividend", "foreign_shareholding"]) {
  assert.match(finMindCacheMigrationSource, new RegExp(`'${dataset}'`));
}
for (const table of ["stock_price", "stock_institutional", "tdcc_shareholding"]) {
  assert.match(
    retentionMigrationSource,
    new RegExp(`delete from public\\.${table} where date < shared_cutoff`),
    `${table} must use the shared 512-price-date cutoff`,
  );
}
assert.doesNotMatch(chipsChartSource, /slice\(-20\)/, "chip charts must use the full retained API range");
assert.deepEqual(
  listPendingCalendarDates("2026-07-24", "2026-07-31"),
  [
    "2026-07-25", "2026-07-26", "2026-07-27", "2026-07-28",
    "2026-07-29", "2026-07-30", "2026-07-31",
  ],
  "Supabase catch-up must not skip dates between the cloud maximum and today",
);
assert.equal(
  resolveDatabasePath("D:\\app", "fixtures\\smoke.db"),
  "D:\\app\\fixtures\\smoke.db",
  "configured SQLite paths must resolve relative to the process directory",
);
const freshLocalRows = Array.from({ length: 30 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, "0")}`,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
}));
assert.equal(
  hasUsableLocalPriceRows(freshLocalRows, new Date("2026-08-01T00:00:00+08:00").getTime()),
  true,
  "explicit local mode may use sufficiently fresh local prices",
);
assert.equal(
  hasUsableLocalPriceRows(freshLocalRows, new Date("2026-08-15T00:00:00+08:00").getTime()),
  false,
  "explicit local mode must reject stale local prices",
);
assert.equal(clampSidebarWidth(100, 1200), 132, "sidebar width must keep navigation usable");
assert.equal(clampSidebarWidth(500, 800), 288, "sidebar width must preserve responsive content space");
assert.equal(clampSidebarWidth(300, 1200), 300, "sidebar width must retain a valid user size");
assert.equal(calcRSI(rising, 14).at(-1), 100, "RSI must be 100 when average loss is zero");
assert.equal(calcRSI(Array(20).fill(100), 14).at(-1), 50, "flat RSI must be neutral");
assert.throws(() => calcRSI(rising, 0), RangeError);

const atrRows: PriceData[] = Array.from({ length: 15 }, (_, index) => ({
  date: `2026-01-${String(index + 1).padStart(2, "0")}`,
  open: 100 + index,
  high: 101 + index,
  low: 99 + index,
  close: 100 + index,
  volume: 1_000,
}));
const atr = calcATR(atrRows, 14);
assert.equal(atr.length, atrRows.length, "ATR output must align with input rows");
assert.deepEqual(atr.slice(0, 14), Array(14).fill(null));
assert.equal(atr[14], 2);
assert.throws(() => calcATR(atrRows, -1), RangeError);

const engineRows = Array.from({ length: 20 }, (_, index) => ({
  date: 20260101 + index,
  open: 100,
  high: index < 6 ? 120 : 101,
  low: index < 6 ? 80 : 99,
  close: 100,
  volume: 1_000,
}));
assert.equal(new SupportResistanceEngine(engineRows).atr14, 2, "strategy ATR must use only the latest period");


assert.equal(isLoopbackAddress("127.0.0.1"), true);
assert.equal(isLoopbackAddress("::1"), true);
assert.equal(isLoopbackAddress("192.168.1.10"), false);
assert.equal(validateEnvValue("key", "  abc=123  "), "abc=123");
assert.throws(() => validateEnvValue("key", "abc\nINJECTED=value"));
assert.equal(createJobDedupeKey("2330", ["goldman", "berkshire", "goldman"]), "2330:berkshire,goldman");
assert.deepEqual(selectFinMindDatasetNames(["deshaw"]), ["TaiwanStockPrice"], "single framework must fetch only required FinMind datasets");
const allFrameworkDatasets = selectFinMindDatasetNames([
  "berkshire", "goldman", "morgan_stanley", "bridgewater", "jpmorgan", "blackrock", "citadel",
  "renaissance", "vanguard", "deshaw", "twosigma", "hedge_fund", "industry",
]);
assert.equal(allFrameworkDatasets.includes("TaiwanStockMarginPurchaseShortSale"), false, "unused FinMind data must not be fetched");
assert.equal(allFrameworkDatasets.includes("TaiwanStockShareholding"), false, "unused FinMind data must not be fetched");

let activeWorkers = 0;
let peakWorkers = 0;
await mapWithConcurrency([1, 2, 3, 4, 5], 3, async () => {
  activeWorkers++;
  peakWorkers = Math.max(peakWorkers, activeWorkers);
  await new Promise((resolve) => setTimeout(resolve, 5));
  activeWorkers--;
});
assert.equal(peakWorkers, 3, "AI worker pool must honor its concurrency limit");

const pgrst002 = describeSupabaseError(
  { code: "PGRST002", message: "Could not query the database for the schema cache. Retrying." },
  "https://example-ref.supabase.co",
);
assert.equal(pgrst002.code, "PGRST002");
assert.match(pgrst002.message, /不是 URL 或 anon key/);
assert.equal(pgrst002.dashboardUrl, "https://supabase.com/dashboard/project/example-ref/integrations/data_api/overview");
assert.equal(pgrst002.steps.length, 4);

let retryAttempts = 0;
const retryServer = createServer((_request, response) => {
  retryAttempts++;
  response.statusCode = retryAttempts === 1 ? 503 : 200;
  response.end(retryAttempts === 1 ? "retry" : "ok");
});
retryServer.listen(0, "127.0.0.1");
await once(retryServer, "listening");
try {
  const address = retryServer.address();
  assert(address && typeof address === "object");
  const response = await fetchWithOneRetry(`http://127.0.0.1:${address.port}`, {}, undefined, 2_000);
  assert.equal(response.status, 200);
  assert.equal(retryAttempts, 2, "transient HTTP failures should retry exactly once");
} finally {
  retryServer.close();
  await once(retryServer, "close");
}

let timeoutAttempts = 0;
const timeoutServer = createServer((_request, response) => {
  timeoutAttempts++;
  setTimeout(() => response.end("late"), 40);
});
timeoutServer.listen(0, "127.0.0.1");
await once(timeoutServer, "listening");
try {
  const address = timeoutServer.address();
  assert(address && typeof address === "object");
  const requestSeen = once(timeoutServer, "request");
  const timedRequest = fetchWithOneRetry(`http://127.0.0.1:${address.port}`, {}, undefined, 20);
  await requestSeen;
  await assert.rejects(
    timedRequest,
    (error: any) => error?.name === "TimeoutError",
  );
  assert.equal(timeoutAttempts, 1, "request timeouts must not silently double the total wait");
  await new Promise((resolve) => setTimeout(resolve, 50));
} finally {
  timeoutServer.close();
  await once(timeoutServer, "close");
}

const connectAbort = new AbortController();
setTimeout(() => connectAbort.abort(new DOMException("Timed out", "TimeoutError")), 5);
await assert.rejects(
  withAbortSignal(new Promise(() => {}), connectAbort.signal),
  (error: any) => error?.name === "TimeoutError",
  "MCP connection waits must obey their abort signal",
);

const snapshotPrices = Array.from({ length: 15 }, (_, index) => ({
  date: `2026-07-${String(index + 1).padStart(2, "0")}`,
  open: 100 + index,
  max: 101 + index,
  min: 99 + index,
  close: 100 + index,
}));
const snapshot = buildStockSnapshot("2330", [
  { dataset: "TaiwanStockPrice", rows: snapshotPrices },
  { dataset: "TaiwanStockMonthRevenue", rows: [
    { date: "2025-06-01", revenue_year: 2025, revenue_month: 6, revenue: 100 },
    { date: "2026-06-01", revenue_year: 2026, revenue_month: 6, revenue: 110 },
  ] },
  { dataset: "TaiwanStockFinancialStatements", rows: [
    { date: "2026-03-31", type: "Revenue", value: 200 },
  ] },
], { companyName: "台積電" }, "2026-07-22T00:00:00.000Z");
assert.equal(snapshot.metrics.latest_close.value, 114);
assert.equal(snapshot.metrics.atr14.value, 2);
assert.ok(Math.abs(snapshot.metrics.monthly_revenue_yoy.value - 10) < 1e-10);
assert.equal(snapshot.quality.staleDatasets.includes("TaiwanStockFinancialStatements"), false, "fresh quarterly filings must not use the daily stale threshold");
const priceOnlyPrompt = formatSnapshotForPrompt(snapshot, {
  datasets: ["TaiwanStockPrice"],
  metrics: ["latest_close", "atr14"],
});
assert.match(priceOnlyPrompt, /TaiwanStockPrice/);
assert.doesNotMatch(priceOnlyPrompt, /TaiwanStockMonthRevenue/);
assert.doesNotMatch(priceOnlyPrompt, /monthly_revenue_yoy/);

const validatedReport = validateEvidenceReport([
  "最新收盤價為 114 元 [[metric:latest_close]]",
  "未經證實的目標價為 999 元",
  "錯誤引用的 ROE 為 20% [[metric:not_real]]",
].join("\n"), snapshot);
assert.equal(validatedReport.summary.numericClaimLines, 3);
assert.equal(validatedReport.summary.supportedClaimLines, 1);
assert.equal(validatedReport.summary.redactedLines, 2);
assert.match(validatedReport.markdown, /〔metric:latest_close〕/);
assert.doesNotMatch(validatedReport.markdown, /999/);
assert.equal(validatedReport.evidence["metric:latest_close"].value, 114);

const migrationDb = new Database(":memory:");
try {
  ensureCanonicalSchema(migrationDb);
  const compatibilityInsert = migrationDb.prepare(`
    INSERT OR REPLACE INTO stock_price
      (stock_id, date, open, high, low, close, volume, amount, trade_count, spread, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  compatibilityInsert.run("2330", "2026-07-22", 100, 105, 99, 103, 1_000, 100_000, 10, 4, "contract_test");
  compatibilityInsert.run("2330", "2026-07-22", 101, 106, 100, 104, 2_000, 200_000, 20, 5, "contract_test");
  assert.equal(
    (migrationDb.prepare("SELECT close FROM stock_history WHERE stock_id = '2330'").get() as { close: number }).close,
    104,
    "stock_price compatibility writes must land in canonical stock_history",
  );
  runMigrations(migrationDb);
  runMigrations(migrationDb);
  assert.equal((migrationDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get() as { count: number }).count, 5, "migrations must be idempotent");
  assert.throws(
    () => migrationDb.prepare(
      "INSERT INTO stock_meta (stock_id, stock_name) VALUES ('0050', 'ETF must be rejected')",
    ).run(),
    /only ordinary stock IDs are allowed/,
  );
  for (const table of ["analysis_snapshots", "analysis_job_reports", "analysis_jobs"]) {
    assert.ok(migrationDb.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `${table} must exist`);
  }
  const jobColumns = new Set((migrationDb.prepare("PRAGMA table_info(analysis_jobs)").all() as Array<{ name: string }>).map((column) => column.name));
  for (const column of ["worker_id", "lease_until", "attempt_count", "dedupe_key"]) assert.ok(jobColumns.has(column));
  const insertJob = migrationDb.prepare(`
    INSERT INTO analysis_jobs (id, stock_id, framework_ids, framework_count, status, per_framework, started_at, updated_at, dedupe_key)
    VALUES (?, '2330', '["goldman"]', 1, ?, '{}', 1, 1, '2330:goldman')
  `);
  insertJob.run("lease-a", "running");
  assert.throws(() => insertJob.run("lease-b", "running"), /UNIQUE/, "only one active duplicate job is allowed");
  migrationDb.prepare("UPDATE analysis_jobs SET status = 'done' WHERE id = 'lease-a'").run();
  insertJob.run("lease-b", "running");

  const tdccCsv = [
    "資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%",
    '"1150718","2330","1","10","100","10"',
    "20260718,2330,6,20,200,20",
    "2026-07-18,2330,15,5,300,30",
    "2026/07/18,2330,16,1,100,10",
    '20260718,2330,17,36,"1,000",100',
    "20260718,2317,1,10,100,25",
    "20260718,2317,15,2,300,75",
    "20260718,0050,17,1,100,100",
    "20261340,9999,1,1,100,100",
    "20260718,9999,1,1,-10,100",
  ].join("\n");
  const parsedTdcc = parseTdccCSV(tdccCsv);
  assert.equal(parsedTdcc.date, "2026-07-18");
  assert.equal(parsedTdcc.parsedRows, 7);
  assert.equal(parsedTdcc.records.length, 2);
  assert.deepEqual(parsedTdcc.records.find((record) => record.stock_id === "2330"), {
    stock_id: "2330", date: "2026-07-18", total_shares: 1_000, whale_ratio: 30, retail_ratio: 30,
    total_people: 36, whale_shares: 300, whale_people: 5,
  });
  assert.deepEqual(parsedTdcc.records.find((record) => record.stock_id === "2317"), {
    stock_id: "2317", date: "2026-07-18", total_shares: 400, whale_ratio: 75, retail_ratio: 25,
    total_people: 12, whale_shares: 300, whale_people: 2,
  });
  await saveTdccToSQLite(parsedTdcc.records, "contract_test", migrationDb);
  await saveTdccToSQLite(parsedTdcc.records, "contract_test", migrationDb);
  assert.equal((migrationDb.prepare("SELECT COUNT(*) AS count FROM tdcc_shareholding").get() as { count: number }).count, 2, "TDCC upsert must be idempotent");
} finally {
  migrationDb.close();
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(apiRouter);
const routeIds: string[] = [];
const collectRoutes = (stack: any[]) => {
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) routeIds.push(`${method.toUpperCase()} ${layer.route.path}`);
    } else if (layer.handle?.stack) collectRoutes(layer.handle.stack);
  }
};
collectRoutes((apiRouter as any).stack);
assert.equal(new Set(routeIds).size, routeIds.length, "API routes must not be registered twice after router extraction");
for (const route of [
  "POST /api/ai-analysis",
  "POST /api/analysis-mvp",
  "POST /api/job/batch",
  "POST /api/job/:id/cancel",
  "GET /api/job/:id",
  "GET /api/job",
  "POST /api/upload-tdcc",
  "POST /api/auto-download-tdcc",
  "POST /api/tdcc/sync",
  "GET /api/tdcc/status",
  "GET /api/settings",
  "POST /api/settings",
  "GET /api/movers",
  "GET /api/dashboard/recent-dividend",
  "GET /api/dashboard/trust-buy-2day",
  "GET /api/dashboard/break-ma200",
  "GET /api/dashboard/limit-up-yesterday",
  "GET /api/stock/:id/sr-analysis",
  "GET /api/stock/:id/ma-analysis",
  "GET /api/stock/:id/chips-analysis",
  "GET /api/stock/:id/prediction-analysis",
  "GET /api/stock/:id/pattern-analysis",
  "GET /api/strategy/sr-scan",
  "GET /api/strategy/ma-scan",
  "GET /api/strategy/chips-scan",
  "GET /api/strategy/prediction-scan",
  "GET /api/strategy/pattern-scan",
  "GET /api/stock/search",
  "GET /api/stock/:id/history",
  "GET /api/stock/:id/indicators",
  "GET /api/stock/:id/institutional",
  "GET /api/stock/:id/shareholding",
  "POST /api/stock/:id/shareholding/backfill",
  "GET /api/stock/:id/quote",
  "GET /api/stock/:id/valuation",
  "GET /api/stock/:id/margin",
  "GET /api/stock/:id/revenue",
  "GET /api/stock/:id/financials",
  "POST /api/sync-daily",
  "POST /api/trigger-update",
  "GET /api/sync-status",
  "POST /api/local/backfill-finmind",
  "GET /api/health",
  "GET /api/twse-stats",
  "GET /api/otc-stats",
  "GET /api/debug-status",
]) assert.ok(routeIds.includes(route), `${route} must remain registered`);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const settings = await fetch(`${baseUrl}/api/settings`).then((response) => response.json()) as Record<string, unknown>;
  assert.equal(settings.success, true);
  for (const secret of ["nvidiaApiKey", "longcatApiKey", "finmindApiKey", "geminiApiKey", "webhookUrl"]) {
    assert.equal(Object.hasOwn(settings, secret), false, `/api/settings must not expose ${secret}`);
  }
  const legacy = await fetch(`${baseUrl}/api/ai-analysis`, { method: "POST" });
  assert.equal(legacy.status, 410, "unsafe legacy AI route must stay retired");
  const etfResponse = await fetch(`${baseUrl}/api/stock/0050/history`);
  assert.equal(etfResponse.status, 400, "stock APIs must reject non-ordinary securities");
  const etfBody = await etfResponse.json() as Record<string, unknown>;
  assert.equal(etfBody.success, false);
} finally {
  server.close();
  await once(server, "close");
}

console.log("self-check: ok");
