import type {
  ResearchContext,
  ResearchDataset,
  ResearchSource,
  ResearchSourceProvider,
  ResearchSourceStatus,
  StrategyId,
  StrategyResearchResult,
} from "../../shared/researchContext";
import { isEligibleOrdinaryStock, isOrdinaryStockId } from "./stockUniverse";

type Company = ResearchContext["company"];
type Market = ResearchContext["market"];
type Fundamentals = ResearchContext["fundamentals"];
type Institutional = ResearchContext["institutional"];
type Tdcc = ResearchContext["tdcc"];
type TradeRisks = ResearchContext["tradeRisks"];
type TradingCalendar = { dates: string[] };

export interface ResearchCompanyEligibility extends Company {
  stockId: string;
  status: string;
  type: string;
}

export interface ResearchContextAdapter {
  readCompany(stockId: string): Promise<ResearchDataset<ResearchCompanyEligibility>>;
  readMarket(stockId: string): Promise<ResearchDataset<Market>>;
  readFundamentals(stockId: string): Promise<ResearchDataset<Fundamentals>>;
  readInstitutional(stockId: string): Promise<ResearchDataset<Institutional>>;
  readTdcc(stockId: string): Promise<ResearchDataset<Tdcc>>;
  readTradeRisks(stockId: string): Promise<ResearchDataset<TradeRisks>>;
  readTradingCalendar(asOfDate: string): Promise<ResearchDataset<TradingCalendar>>;
  runStrategy(stockId: string, strategy: StrategyId): Promise<StrategyResearchResult>;
}

export interface ResearchContextAggregatorOptions {
  clock?: () => Date;
  asOfDate?: string;
}

const STRATEGIES: StrategyId[] = ["sr", "ma", "chips", "pattern"];
const FRESHNESS_DATASETS = new Set([
  "stock_price", "stock_institutional", "tdcc_shareholding", "financials", "stock_trade_risk",
]);
const EMPTY_FUNDAMENTALS: Fundamentals = { status: "unavailable", metrics: [], missing: [] };
const EMPTY_INSTITUTIONAL: Institutional = { dailyFlows: [] };
const EMPTY_TDCC: Tdcc = {
  date: null, source: null, totalShares: null, whaleRatio: null, retailRatio: null,
  totalPeople: null, whaleShares: null, whalePeople: null,
};
const EMPTY_RISKS: TradeRisks = { highestLevel: "none", flags: [], dataAsOf: null };

interface OptionalResult<T> {
  data: T;
  source: ResearchSource;
  sources: ResearchSource[];
  missing: string[];
  warnings: string[];
}

interface StrategyOutcome {
  result: StrategyResearchResult;
  error: string | null;
}

type SourceBearing = Pick<ResearchDataset<unknown>, "source" | "sources">;

interface SourceAggregation {
  sources: ResearchSource[];
  missing: string[];
  warnings: string[];
}

function dateInTaipei(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

function timeInTaipei(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

function marketFreshnessDate(now: Date, asOfDate: string, dates: string[], explicitAsOf: boolean): string {
  if (explicitAsOf || timeInTaipei(now) >= "13:30") return asOfDate;
  const calendar = unique(dates).filter((date) => date <= asOfDate).sort();
  if (!calendar.includes(asOfDate)) return asOfDate;
  return calendar.filter((date) => date < asOfDate).at(-1) ?? asOfDate;
}

function sourceProvider(dataset: string): ResearchSourceProvider {
  return dataset === "financials" ? "finmind" : "supabase";
}

function normalizeSource(
  source: ResearchSource,
  defaultStatus: ResearchSourceStatus = source.rowCount > 0 ? "available" : "unavailable",
): ResearchSource {
  return {
    ...source,
    status: source.status ?? defaultStatus,
    error: source.error ?? null,
  };
}

function failedSource(dataset: string, error: string, retrievedAt: string): ResearchSource {
  const provider = sourceProvider(dataset);
  return {
    id: `${provider}:${dataset}`, dataset, provider, asOf: null, retrievedAt,
    rowCount: 0, estimated: false, status: "error", error,
  };
}

async function optional<T>(
  dataset: string,
  fallback: T,
  loader: () => Promise<ResearchDataset<T>>,
  retrievedAt: string,
  emptyIsAvailable = false,
): Promise<OptionalResult<T>> {
  try {
    const result = await loader();
    const defaultStatus = result.source.rowCount > 0 || emptyIsAvailable ? "available" : "unavailable";
    const source = normalizeSource(result.source, defaultStatus);
    const sources = (result.sources ?? []).map((item) => normalizeSource(item));
    const missing = [
      ...(source.status === "available" ? [] : [dataset]),
      ...sources.filter((item) => item.status !== "available").map((item) => item.dataset),
    ];
    const warnings = sources.flatMap((item) => item.error ? [`${item.dataset}:${item.error}`] : []);
    return { data: result.data, source, sources, missing, warnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      data: fallback, source: failedSource(dataset, message, retrievedAt), sources: [],
      missing: [dataset], warnings: [`${dataset}:${message}`],
    };
  }
}

function strategyError(strategy: StrategyId): StrategyResearchResult {
  return {
    strategy, status: "error", date: null, score: null, signal: "UNKNOWN",
    confidence: null, summary: null, details: {},
  };
}

async function runStrategy(
  adapter: ResearchContextAdapter,
  stockId: string,
  strategy: StrategyId,
  latestDate: string | null,
): Promise<StrategyOutcome> {
  try {
    const result = await adapter.runStrategy(stockId, strategy);
    return { result: { ...result, strategy, date: latestDate }, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: { ...strategyError(strategy), date: latestDate }, error: message };
  }
}

function strategySource(outcome: StrategyOutcome, retrievedAt: string): ResearchSource {
  const { result, error } = outcome;
  const status: ResearchSourceStatus = result.status === "ok" ? "available" : result.status;
  return {
    id: `supabase:strategy_${result.strategy}`, dataset: `strategy_${result.strategy}`,
    provider: "supabase", asOf: status === "available" ? result.date : null, retrievedAt,
    rowCount: status === "available" ? 1 : 0, estimated: false, status, error,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function aggregateResearchSources(
  datasets: SourceBearing[],
  additional: ResearchSource[],
): SourceAggregation {
  const datasetCandidates = datasets.flatMap((dataset) => [
    normalizeSource(dataset.source),
    ...(dataset.sources ?? []).map((source) => normalizeSource(source)),
  ]);
  const datasetIds = new Set(datasetCandidates.map((source) => source.id));
  const seen = new Set<string>();
  const sources = [...datasetCandidates, ...additional].filter((source) => {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
  const failed = sources.filter((source) =>
    datasetIds.has(source.id) && source.status !== "available");
  return {
    sources,
    missing: failed.map((source) => source.dataset),
    warnings: failed.flatMap((source) =>
      source.error ? [`${source.dataset}:${source.error}`] : []),
  };
}

function dayDistance(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function tradingLag(sourceDate: string, asOfDate: string, dates: string[]): number | null {
  if (sourceDate > asOfDate) return -1;
  const calendar = unique(dates).filter((date) => date <= asOfDate).sort();
  if (calendar.length === 0) return null;
  return calendar.filter((date) => date > sourceDate).length;
}

function requiredFinancialPeriod(asOfDate: string): string {
  const year = Number(asOfDate.slice(0, 4));
  const monthDay = asOfDate.slice(5);
  if (monthDay >= "11-14") return `${year}-09-30`;
  if (monthDay >= "08-14") return `${year}-06-30`;
  if (monthDay >= "05-15") return `${year}-03-31`;
  if (monthDay >= "03-31") return `${year - 1}-12-31`;
  return `${year - 1}-09-30`;
}

function staleReason(
  source: ResearchSource,
  asOfDate: string,
  marketAsOfDate: string,
  calendar: string[],
): string | null {
  if (!FRESHNESS_DATASETS.has(source.dataset)) return null;
  if (source.dataset === "stock_trade_risk" && source.rowCount === 0 && source.asOf === null) return null;
  if (source.status === "error") return null;
  if (source.asOf === null) return `${source.dataset}:null_as_of`;
  if (!isIsoDate(source.asOf)) return `${source.dataset}:invalid_as_of:${source.asOf}`;
  if (source.dataset === "stock_price" || source.dataset === "stock_institutional") {
    if (source.asOf > marketAsOfDate) return `${source.dataset}:future_as_of:${source.asOf}`;
    const lag = tradingLag(source.asOf, marketAsOfDate, calendar);
    if (lag === null) return `${source.dataset}:trading_calendar_unavailable`;
    const limit = source.dataset === "stock_price" ? 0 : 1;
    return lag > limit ? `${source.dataset}:trading_lag:${lag}` : null;
  }
  if (source.asOf > asOfDate) return `${source.dataset}:future_as_of:${source.asOf}`;
  if (source.dataset === "financials") {
    const requiredPeriod = requiredFinancialPeriod(asOfDate);
    return source.asOf < requiredPeriod ? `${source.dataset}:required_period:${requiredPeriod}` : null;
  }
  const limit = source.dataset === "tdcc_shareholding" ? 10
    : source.dataset === "stock_trade_risk" ? 3 : null;
  if (limit === null) return null;
  const age = dayDistance(source.asOf, asOfDate);
  return age === null || age > limit ? `${source.dataset}:calendar_lag:${age ?? "invalid"}` : null;
}

function freshness(sources: ResearchSource[], asOfDate: string, marketAsOfDate: string, calendar: string[]) {
  const assessed = sources.map((source) => ({
    source, reason: staleReason(source, asOfDate, marketAsOfDate, calendar),
  }));
  return {
    staleDatasets: unique(assessed.filter((item) => item.reason !== null).map((item) => item.source.dataset)),
    warnings: assessed.flatMap((item) => item.reason === null ? [] : [item.reason]),
  };
}

async function requiredCompany(adapter: ResearchContextAdapter, stockId: string) {
  try {
    const result = await adapter.readCompany(stockId);
    const source = normalizeSource(result.source);
    const eligible = source.rowCount > 0
      && isOrdinaryStockId(result.data.stockId)
      && isEligibleOrdinaryStock({
        stock_id: result.data.stockId, status: result.data.status,
        type: result.data.type, market: result.data.market,
      });
    if (!eligible) throw new Error("stock_not_eligible_for_research");
    return { ...result, source };
  } catch (error) {
    if (error instanceof Error && error.message === "stock_not_eligible_for_research") throw error;
    throw new Error("research_context_unavailable");
  }
}

async function requiredMarket(adapter: ResearchContextAdapter, stockId: string) {
  try {
    const result = await adapter.readMarket(stockId);
    if (result.data.history.length === 0) throw new Error("missing_market");
    return { ...result, source: normalizeSource(result.source, "available") };
  } catch {
    throw new Error("research_context_unavailable");
  }
}

export class ResearchContextAggregator {
  private readonly clock: () => Date;
  private readonly asOfDate?: string;

  constructor(
    private readonly adapter: ResearchContextAdapter,
    options: ResearchContextAggregatorOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.asOfDate = options.asOfDate;
  }

  async aggregate(stockId: string): Promise<ResearchContext> {
    const now = this.clock();
    const retrievedAt = now.toISOString();
    const asOfDate = this.asOfDate ?? dateInTaipei(now);
    const company = await requiredCompany(this.adapter, stockId);
    const market = await requiredMarket(this.adapter, stockId);
    const [fundamentals, institutional, tdcc, risks, calendar, strategyOutcomes] = await Promise.all([
      optional("financials", EMPTY_FUNDAMENTALS, () => this.adapter.readFundamentals(stockId), retrievedAt),
      optional("stock_institutional", EMPTY_INSTITUTIONAL, () => this.adapter.readInstitutional(stockId), retrievedAt),
      optional("tdcc_shareholding", EMPTY_TDCC, () => this.adapter.readTdcc(stockId), retrievedAt),
      optional("stock_trade_risk", EMPTY_RISKS, () => this.adapter.readTradeRisks(stockId), retrievedAt, true),
      optional("trading_calendar", { dates: [] }, () => this.adapter.readTradingCalendar(asOfDate), retrievedAt),
      Promise.all(STRATEGIES.map((strategy) => runStrategy(this.adapter, stockId, strategy, market.data.latestDate))),
    ]);
    const marketAsOfDate = marketFreshnessDate(
      now, asOfDate, calendar.data.dates, this.asOfDate !== undefined,
    );
    return this.build(stockId, asOfDate, marketAsOfDate, company, market,
      { fundamentals, institutional, tdcc, risks, calendar, strategyOutcomes }, retrievedAt);
  }

  private build(
    stockId: string,
    asOfDate: string,
    marketAsOfDate: string,
    company: ResearchDataset<ResearchCompanyEligibility>,
    market: ResearchDataset<Market>,
    loaded: {
      fundamentals: OptionalResult<Fundamentals>; institutional: OptionalResult<Institutional>;
      tdcc: OptionalResult<Tdcc>; risks: OptionalResult<TradeRisks>;
      calendar: OptionalResult<TradingCalendar>; strategyOutcomes: StrategyOutcome[];
    },
    retrievedAt: string,
  ): ResearchContext {
    const { fundamentals, institutional, tdcc, risks, calendar, strategyOutcomes } = loaded;
    const strategies = Object.fromEntries(strategyOutcomes.map(({ result }) => [result.strategy, result])) as ResearchContext["strategies"];
    const optionalRows = [fundamentals, institutional, tdcc, risks, calendar];
    const strategyMissing = strategyOutcomes.filter(({ result }) => result.status !== "ok").map(({ result }) => `strategy:${result.strategy}`);
    const datasets: SourceBearing[] = [company, market,
      ...optionalRows.map((row) => ({ source: row.source, sources: row.sources }))];
    const sourceAggregation = aggregateResearchSources(
      datasets,
      strategyOutcomes.map((outcome) => strategySource(outcome, retrievedAt)),
    );
    const missingDatasets = unique(optionalRows.flatMap((row) => row.missing)
      .concat(sourceAggregation.missing, fundamentals.data.missing, strategyMissing));
    const freshnessResult = freshness(sourceAggregation.sources, asOfDate, marketAsOfDate, calendar.data.dates);
    const loaderWarnings = optionalRows.flatMap((row) => row.warnings)
      .concat(sourceAggregation.warnings);
    return {
      schemaVersion: 1, stockId, asOf: market.data.latestDate,
      company: { name: company.data.name, market: company.data.market, industry: company.data.industry },
      market: market.data, fundamentals: fundamentals.data, institutional: institutional.data,
      tdcc: tdcc.data, tradeRisks: risks.data, strategies,
      quality: {
        status: missingDatasets.length || freshnessResult.staleDatasets.length
          || fundamentals.data.status !== "complete" ? "partial" : "complete",
        missingDatasets, staleDatasets: freshnessResult.staleDatasets,
        warnings: unique([...loaderWarnings, ...freshnessResult.warnings]),
      },
      sources: sourceAggregation.sources,
    };
  }
}
