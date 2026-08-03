import type { ResearchContextAdapter } from "../../server/lib/researchContext.js";
import type {
  ResearchSource,
  StrategyId,
} from "../../shared/researchContext.js";

export type { StrategyId } from "../../shared/researchContext.js";

const retrievedAt = "2026-08-02T03:04:05.000Z";

const source = (
  dataset: string,
  rowCount: number,
  provider: ResearchSource["provider"] = "supabase",
  estimated = false,
): ResearchSource => {
  return {
    id: `${provider}:${dataset}`, dataset, provider, asOf: "2026-07-31",
    retrievedAt, rowCount, estimated, status: "available", error: null,
  };
};

export function createResearchContextAdapter(): ResearchContextAdapter {
  return {
    async readCompany() {
      const data = {
        name: "台積電", market: "TSE", industry: "半導體業",
        stockId: "2330", status: "active", type: "COMMON",
      };
      return {
        data,
        source: source("stock_meta", 1),
      };
    },
    async readMarket() {
      return {
        data: {
          latestDate: "2026-07-31",
          price: 0,
          history: [{ date: "2026-07-31", close: 0, volume: 100 }],
        },
        source: source("stock_price", 1),
      };
    },
    async readFundamentals() {
      return {
        data: {
          status: "partial",
          metrics: [{
            key: "eps",
            value: null,
            available: false,
            unit: "TWD",
            period: null,
            sourceId: null,
          }],
          missing: ["eps"],
        },
        source: source("financials", 0, "finmind"),
      };
    },
    async readInstitutional() {
      return {
        data: {
          dailyFlows: [{
            date: "2026-07-31",
            foreignNet: 0,
            trustNet: 12,
            dealerNet: 0,
            institutionalNet: 12,
          }],
        },
        source: source("stock_institutional", 1),
      };
    },
    async readTdcc() {
      return {
        data: {
          date: "2026-07-31",
          source: "tdcc",
          totalShares: 1000,
          whaleRatio: 52.3,
          retailRatio: null,
          totalPeople: null,
          whaleShares: null,
          whalePeople: null,
        },
        source: source("tdcc_shareholding", 1),
      };
    },
    async readTradeRisks() {
      return {
        data: { highestLevel: "none", flags: [], dataAsOf: null },
        source: source("stock_trade_risk", 0),
      };
    },
    async readTradingCalendar() {
      return {
        data: { dates: ["2026-07-29", "2026-07-30", "2026-07-31"] },
        source: source("trading_calendar", 3),
      };
    },
    async runStrategy(_stockId: string, strategy: StrategyId) {
      return {
        strategy,
        status: "ok",
        date: "2026-07-31",
        score: 0,
        signal: "HOLD",
        confidence: 0,
        summary: `${strategy} deterministic result`,
        details: {},
      };
    },
  };
}
