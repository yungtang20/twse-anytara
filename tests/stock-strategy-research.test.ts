import assert from "node:assert/strict";
import test from "node:test";
import type { StrategyId } from "../shared/researchContext.js";

type PriceRow = {
  stock_id: string; date: string; open: number; high: number; low: number;
  close: number; volume: number;
};

function priceRows(): PriceRow[] {
  const end = Date.parse("2024-01-15T00:00:00Z");
  return Array.from({ length: 120 }, (_, index) => {
    const date = new Date(end - index * 86_400_000).toISOString().slice(0, 10);
    const close = 100 + (119 - index) * 0.1;
    return {
      stock_id: "2330", date, open: close, high: close + 1, low: close - 1,
      close, volume: 1_000_000 + index,
    };
  });
}

test("formal strategy runner derives every strategy date from unsorted price input", async () => {
  const module = await import("../server/lib/stockStrategyResearch.js") as unknown as {
    runStockStrategyResearch(
      stockId: string,
      strategy: StrategyId,
      rows: PriceRow[],
      readers: {
        readInstitutional(stockId: string): Promise<Array<Record<string, unknown>>>;
        readShareholding(stockId: string): Promise<Array<Record<string, unknown>>>;
      },
    ): Promise<{ date: string | null }>;
  };
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network forbidden");
  }) as typeof fetch;
  const readers = {
    async readInstitutional() {
      return [{ date: "2024-01-15", foreign_net: 0, trust_net: 0, dealer_net: 0, institutional_net: 0 }];
    },
    async readShareholding() {
      return [{ date: "2024-01-12", source: "tdcc", total_shares: 1, whale_ratio: 0, retail_ratio: null }];
    },
  };
  try {
    const signals: string[] = [];
    for (const strategy of ["sr", "ma", "chips", "pattern"] as const) {
      const result = await module.runStockStrategyResearch("2330", strategy, priceRows(), readers);
      assert.equal(result.date, "2024-01-15", `${strategy} must use the maximum input price date`);
      signals.push((result as unknown as { signal: string }).signal);
    }
    assert.ok(signals.some((signal) => signal !== "UNKNOWN"), JSON.stringify(signals));
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("one deterministic mapper covers SR MA chips and pattern semantics", async () => {
  const { deriveStockStrategySignal } = await import("../server/lib/stockStrategyResearch.js");
  assert.equal(deriveStockStrategySignal("sr", { lastClose: 100,
    support: { near: 99 }, pressure: { near: 102 } }).signal, "BUY");
  assert.equal(deriveStockStrategySignal("sr", { lastClose: 100,
    support: { near: 98 }, pressure: { near: 101 } }).signal, "SELL");
  assert.equal(deriveStockStrategySignal("sr", { lastClose: 100,
    support: { near: 99 }, pressure: { near: 101 } }).signal, "HOLD");
  for (const arrangement of ["多頭排列 (強勢攻擊)", "突破季線 (短線轉強)", "黃金交叉 (趨勢轉強)", "站上中短期均線 (偏強)"]) {
    assert.equal(deriveStockStrategySignal("ma", { arrangement }).signal, "BUY", arrangement);
  }
  for (const arrangement of ["空頭排列 (弱勢尋底)", "跌破中短期均線 (弱勢)", "死亡交叉 (趨勢轉弱)"]) {
    assert.equal(deriveStockStrategySignal("ma", { arrangement }).signal, "SELL", arrangement);
  }
  assert.equal(deriveStockStrategySignal("ma", { arrangement: "區間震盪" }).signal, "HOLD");
  const chipBuy = deriveStockStrategySignal("chips", { foreignTotal: 10, trustTotal: 5,
    whaleChange: 0.2, peopleChange: -10 });
  assert.equal(chipBuy.signal, "BUY");
  assert.equal(chipBuy.score, 100);
  assert.match(chipBuy.summary, /BUY ≥ 2/);
  assert.equal(deriveStockStrategySignal("chips", { foreignTotal: -10, trustTotal: -5,
    whaleChange: -0.2, peopleChange: 10 }).signal, "SELL");
  assert.equal(deriveStockStrategySignal("chips", { foreignTotal: 0, trustTotal: 0,
    whaleChange: null, peopleChange: null }).signal, "HOLD");
  const chipUnknown = deriveStockStrategySignal("chips", { foreignTotal: null, trustTotal: null,
    whaleChange: null, peopleChange: null });
  assert.equal(chipUnknown.signal, "UNKNOWN");
  assert.equal(chipUnknown.score, null);
  const patternBuy = deriveStockStrategySignal("pattern", {
    stage: "confirmed", patternDirection: "up", confidence: 0.8,
  });
  assert.equal(patternBuy.signal, "BUY");
  assert.equal(patternBuy.score, 80);
  assert.match(patternBuy.summary, /已確認向上型態/);
  assert.equal(deriveStockStrategySignal("pattern", { stage: "confirmed", patternDirection: "down", confidence: 0.8 }).signal, "SELL");
  assert.equal(deriveStockStrategySignal("pattern", { stage: "forming", patternDirection: "up", confidence: 0.6 }).signal, "HOLD");
  assert.equal(deriveStockStrategySignal("pattern", { stage: "none", patternDirection: "neutral", confidence: 0 }).signal, "UNKNOWN");
});
