import type {
  ResearchContext,
  ResearchDataset,
  ResearchMetric,
  ResearchSource,
  ResearchSourceStatus,
  StrategyId,
  StrategyResearchResult,
} from "../../shared/researchContext";
import {
  fetchCloudInstitutional,
  fetchCloudMeta,
  fetchCloudPrices,
  fetchCloudShareholding,
  fetchCloudTradingCalendar,
} from "./cloudMarketData";
import { finMindMemoryCache } from "./finmindCache";
import { FINANCIAL_DATASETS, normalizeFinancialSnapshot } from "./financialNormalization";
import type { ResearchCompanyEligibility, ResearchContextAdapter } from "./researchContext";
import { supabase } from "./runtimeState";
import type { SnapshotDatasetInput, SnapshotRow } from "./stockSnapshot";
import { runStockStrategyResearch } from "./stockStrategyResearch";

type Market = ResearchContext["market"];
type Fundamentals = ResearchContext["fundamentals"];
type Institutional = ResearchContext["institutional"];
type Tdcc = ResearchContext["tdcc"];
type TradeRisks = ResearchContext["tradeRisks"];
type RiskLevel = TradeRisks["highestLevel"];
type CloudRecord = Record<string, unknown>;

const FINMIND_URL = "https://api.finmindtrade.com/api/v4/data";
const LEVEL_ORDER: Record<RiskLevel, number> = { none: 0, medium: 1, high: 2, critical: 3 };

interface CloudRiskRow extends CloudRecord {
  risk_type: string;
  risk_level: Exclude<RiskLevel, "none">;
  reason: string;
  restrictions: string;
  announced_date: string | null;
  start_date: string;
  end_date: string | null;
  source: string;
  source_url: string;
  source_updated_at: string | null;
  fetched_at: string;
  is_active: boolean;
}

export interface CloudResearchReaders {
  readStockMeta(stockId: string): Promise<CloudRecord | null>;
  readPrices(stockId: string): Promise<CloudRecord[]>;
  readInstitutional(stockId: string): Promise<CloudRecord[]>;
  readTdcc(stockId: string): Promise<CloudRecord[]>;
  readFinancials(stockId: string): Promise<SnapshotDatasetInput[]>;
  readTradeRisks(stockId: string): Promise<CloudRecord[]>;
  readTradingCalendar(asOfDate: string): Promise<string[]>;
  runStrategy(stockId: string, strategy: StrategyId, prices: CloudRecord[]): Promise<CloudRecord>;
}

export interface CloudResearchContextAdapterOptions {
  readers?: CloudResearchReaders;
  clock?: () => Date;
}

function valueString(row: CloudRecord | null | undefined, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

function valueNumber(row: CloudRecord | null | undefined, key: string): number | null {
  const value = row?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadata(
  clock: () => Date,
  dataset: string,
  provider: ResearchSource["provider"],
  asOf: string | null,
  rowCount: number,
  status: ResearchSourceStatus = rowCount > 0 ? "available" : "unavailable",
): ResearchSource {
  return {
    id: `${provider}:${dataset}`, dataset, provider, asOf,
    retrievedAt: clock().toISOString(), rowCount, estimated: false, status, error: null,
  };
}

function taipeiDate(clock: () => Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(clock());
}

function yearsAgoDate(clock: () => Date, years: number): string {
  const parts = taipeiDate(clock).split("-");
  return `${Number(parts[0]) - years}-${parts[1]}-${parts[2]}`;
}

async function finMindRequest(clock: () => Date, dataset: string, stockId: string): Promise<SnapshotRow[]> {
  const startDate = yearsAgoDate(clock, dataset === "TaiwanStockDividend" ? 10 : 5);
  const endDate = taipeiDate(clock);
  const cached = await finMindMemoryCache.load({ stockId, dataset, startDate, endDate }, async () => {
    const params = new URLSearchParams({ dataset, data_id: stockId, start_date: startDate, end_date: endDate });
    const request = async (token: string) => fetch(`${FINMIND_URL}?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000),
    });
    const token = process.env.FINMIND_API_KEY || "";
    let response = await request(token);
    if (token && !response.ok) response = await request("");
    if (!response.ok) throw new Error(`FinMind HTTP ${response.status}`);
    const payload = await response.json() as { status?: number; msg?: string; data?: unknown };
    if (payload.status !== undefined && Number(payload.status) !== 200) throw new Error(payload.msg || "FinMind request failed");
    return Array.isArray(payload.data) ? payload.data as SnapshotRow[] : [];
  });
  return cached.rows;
}

async function financialInputs(clock: () => Date, stockId: string): Promise<SnapshotDatasetInput[]> {
  const rows = await Promise.all(FINANCIAL_DATASETS.map(async (dataset) => {
    try {
      return { dataset, rows: await finMindRequest(clock, dataset, stockId), source: "finmind" as const };
    } catch (error) {
      return { dataset, rows: [], source: "finmind" as const,
        error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return rows;
}

function latestInputDate(rows: SnapshotRow[]): string | null {
  return rows.map((row) => valueString(row, "date")).filter((date): date is string => date !== null)
    .sort().at(-1) ?? null;
}

function financialInputSource(
  clock: () => Date,
  input: SnapshotDatasetInput,
): ResearchSource {
  const status: ResearchSourceStatus = input.error ? "error"
    : input.rows.length > 0 ? "available" : "unavailable";
  return {
    ...metadata(clock, input.dataset, "finmind", latestInputDate(input.rows), input.rows.length, status),
    error: input.error ?? null,
  };
}

function financialMetrics(
  snapshot: ReturnType<typeof normalizeFinancialSnapshot>,
  sourceId: string,
): ResearchMetric[] {
  const latest = snapshot.quarters.at(-1);
  if (!latest) return [];
  const quarterly = Object.entries(latest.metrics).map(([key, metric]) => ({
    key: key === "eps" ? "epsQuarterly" : key,
    value: metric.value, available: metric.value !== null,
    unit: /Margin|Ratio|roe/i.test(key) ? "%" : "TWD", period: latest.label,
    sourceId: metric.sources.length ? sourceId : null,
  }));
  const ttmEps = snapshot.ttm.eps;
  return [...quarterly, {
    key: "eps", value: ttmEps.value, available: ttmEps.value !== null,
    unit: "TWD", period: "TTM", sourceId: ttmEps.sources.length ? sourceId : null,
  }];
}

function highestRisk(rows: CloudRiskRow[]): RiskLevel {
  return rows.reduce<RiskLevel>((highest, row) =>
    row.is_active && LEVEL_ORDER[row.risk_level] > LEVEL_ORDER[highest] ? row.risk_level : highest, "none");
}

async function cloudTradeRisks(stockId: string): Promise<CloudRiskRow[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("stock_trade_risk")
    .select("risk_type,risk_level,reason,restrictions,announced_date,start_date,end_date,source,source_url,source_updated_at,fetched_at,is_active")
    .eq("stock_id", stockId).order("start_date", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []) as CloudRiskRow[];
}

function defaultReaders(clock: () => Date): CloudResearchReaders {
  return {
    readStockMeta: async (stockId) => {
      const row = await fetchCloudMeta(stockId);
      return row ? { ...row } : null;
    },
    readPrices: async (stockId) => (await fetchCloudPrices(stockId, 512)).map((row) => ({ ...row })),
    readInstitutional: async (stockId) => (await fetchCloudInstitutional(stockId, 120)).map((row) => ({ ...row })),
    readTdcc: async (stockId) => (await fetchCloudShareholding(stockId, 1)).map((row) => ({ ...row })),
    readFinancials: (stockId) => financialInputs(clock, stockId),
    readTradeRisks: async (stockId) => (await cloudTradeRisks(stockId)).map((row) => ({ ...row })),
    readTradingCalendar: (asOfDate) => fetchCloudTradingCalendar(asOfDate),
    runStrategy: async (stockId, strategy, prices) => ({
      ...await runStockStrategyResearch(stockId, strategy, prices as unknown as Parameters<typeof runStockStrategyResearch>[2]),
    }),
  };
}

export class CloudResearchContextAdapter implements ResearchContextAdapter {
  private readonly priceCache = new Map<string, CloudRecord[]>();

  constructor(
    private readonly readers: CloudResearchReaders,
    private readonly clock: () => Date,
  ) {}

  async readCompany(stockId: string): Promise<ResearchDataset<ResearchCompanyEligibility>> {
    const row = await this.readers.readStockMeta(stockId);
    const data = {
      stockId: valueString(row, "stock_id") ?? stockId,
      name: valueString(row, "stock_name"), market: valueString(row, "market"),
      industry: valueString(row, "industry_category"), status: valueString(row, "status") ?? "",
      type: valueString(row, "type") ?? "",
    };
    const status = row ? "available" : "unavailable";
    return { data, source: metadata(this.clock, "stock_meta", "supabase", null, row ? 1 : 0, status) };
  }

  async readMarket(stockId: string): Promise<ResearchDataset<Market>> {
    const rows = [...await this.readers.readPrices(stockId)].sort((left, right) =>
      (valueString(left, "date") ?? "").localeCompare(valueString(right, "date") ?? ""));
    this.priceCache.set(stockId, rows);
    const latest = rows.at(-1);
    const latestDate = valueString(latest, "date");
    if (!latest || !latestDate) throw new Error("No Supabase price data");
    return {
      data: { latestDate, price: valueNumber(latest, "close"), history: rows },
      source: metadata(this.clock, "stock_price", "supabase", latestDate, rows.length),
    };
  }

  async readFundamentals(stockId: string): Promise<ResearchDataset<Fundamentals>> {
    const inputs = await this.readers.readFinancials(stockId);
    const fetchedAt = this.clock().toISOString();
    const snapshot = normalizeFinancialSnapshot(stockId, inputs, {}, fetchedAt);
    const metrics = financialMetrics(snapshot, "finmind:financials");
    const missingMetrics = metrics.filter((metric) => !metric.available).map((metric) => metric.key);
    const missing = [...new Set([...snapshot.missingDatasets, ...missingMetrics])];
    const rowCount = inputs.reduce((total, input) => total + input.rows.length, 0);
    const sources = inputs.map((input) => financialInputSource(this.clock, input));
    const incomplete = sources.some((source) => source.status !== "available");
    return {
      data: {
        status: rowCount === 0 ? "unavailable" : incomplete || missing.length ? "partial" : "complete",
        metrics, missing,
      },
      source: metadata(this.clock, "financials", "finmind", snapshot.asOf, rowCount),
      sources,
    };
  }

  async readInstitutional(stockId: string): Promise<ResearchDataset<Institutional>> {
    const rows = await this.readers.readInstitutional(stockId);
    const dailyFlows = rows.map((row) => ({
      date: valueString(row, "date") ?? "", foreignNet: valueNumber(row, "foreign_net"),
      trustNet: valueNumber(row, "trust_net"), dealerNet: valueNumber(row, "dealer_net"),
      institutionalNet: valueNumber(row, "institutional_net"),
    })).filter((row) => row.date !== "");
    return {
      data: { dailyFlows },
      source: metadata(this.clock, "stock_institutional", "supabase", dailyFlows[0]?.date ?? null, rows.length),
    };
  }

  async readTdcc(stockId: string): Promise<ResearchDataset<Tdcc>> {
    const rows = await this.readers.readTdcc(stockId);
    const row = rows[0];
    const data = {
      date: valueString(row, "date"), source: valueString(row, "source"),
      totalShares: valueNumber(row, "total_shares"), whaleRatio: valueNumber(row, "whale_ratio"),
      retailRatio: valueNumber(row, "retail_ratio"), totalPeople: valueNumber(row, "total_people"),
      whaleShares: valueNumber(row, "whale_shares"), whalePeople: valueNumber(row, "whale_people"),
    };
    return { data, source: metadata(this.clock, "tdcc_shareholding", "supabase", data.date, rows.length) };
  }

  async readTradeRisks(stockId: string): Promise<ResearchDataset<TradeRisks>> {
    const records = await this.readers.readTradeRisks(stockId);
    const rows = records as CloudRiskRow[];
    const asOf = rows.map((row) => row.source_updated_at?.slice(0, 10) ?? row.announced_date)
      .filter((date): date is string => date !== null).sort().at(-1) ?? null;
    return {
      data: { highestLevel: highestRisk(rows), flags: records, dataAsOf: asOf },
      source: metadata(this.clock, "stock_trade_risk", "supabase", asOf, rows.length, "available"),
    };
  }

  async readTradingCalendar(asOfDate: string): Promise<ResearchDataset<{ dates: string[] }>> {
    const dates = await this.readers.readTradingCalendar(asOfDate);
    return {
      data: { dates },
      source: metadata(this.clock, "trading_calendar", "supabase", dates.at(-1) ?? null, dates.length),
    };
  }

  async runStrategy(stockId: string, strategy: StrategyId): Promise<StrategyResearchResult> {
    const prices = this.priceCache.get(stockId) ?? await this.readers.readPrices(stockId);
    this.priceCache.set(stockId, prices);
    const raw = await this.readers.runStrategy(stockId, strategy, prices);
    const details = raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)
      ? raw.details as CloudRecord : raw;
    return {
      strategy, status: raw.status === "unavailable" || raw.status === "error" ? raw.status : "ok",
      date: valueString(raw, "date"), score: valueNumber(raw, "score"),
      signal: raw.signal === "BUY" || raw.signal === "HOLD" || raw.signal === "SELL" ? raw.signal : "UNKNOWN",
      confidence: valueNumber(raw, "confidence"), summary: valueString(raw, "summary"), details,
    };
  }
}

export function createCloudResearchContextAdapter(
  options: CloudResearchContextAdapterOptions = {},
): ResearchContextAdapter {
  const clock = options.clock ?? (() => new Date());
  return new CloudResearchContextAdapter(options.readers ?? defaultReaders(clock), clock);
}
