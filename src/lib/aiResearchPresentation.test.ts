import { describe, expect, it } from "vitest";
import {
  claimKindLabel,
  claimStanceLabel,
  datasetLabel,
  groundingLabel,
  informationRichnessLabel,
  providerLabel,
  qualityStatusLabel,
  researchErrorLabel,
  scenarioLabel,
  signalLabel,
  strategyLabel,
} from "./aiResearchPresentation";

const reservedKeys = ["__proto__", "constructor", "toString"];

describe("AI research presentation labels", () => {
  it.each([
    ["information richness", informationRichnessLabel, "資訊等級未知"],
    ["quality status", qualityStatusLabel, "資料狀態未知"],
    ["claim kind", claimKindLabel, "其他研究發現"],
    ["claim stance", claimStanceLabel, "方向未分類"],
    ["grounding", groundingLabel, "驗證狀態未知"],
    ["provider", providerLabel, "其他 AI 服務"],
    ["dataset", datasetLabel, "其他資料來源"],
    ["strategy", strategyLabel, "策略名稱未知"],
    ["signal", signalLabel, "訊號未判定"],
    ["scenario", scenarioLabel, "估值情境未知"],
    ["research error", researchErrorLabel, "研究流程目前無法完成，請稍後再試"],
  ] as const)("returns the neutral fallback for reserved %s keys", (_name, label, fallback) => {
    for (const key of reservedKeys) expect(label(key)).toBe(fallback);
  });

  it.each([
    ["strategy", strategyLabel, "wire-strategy", "策略名稱未知"],
    ["signal", signalLabel, "wire-signal", "訊號未判定"],
    ["scenario", scenarioLabel, "wire-scenario", "估值情境未知"],
    ["research error", researchErrorLabel, "wire-error", "研究流程目前無法完成，請稍後再試"],
  ] as const)("does not expose an unknown %s wire value", (_name, label, wireValue, fallback) => {
    expect(label(wireValue)).toBe(fallback);
    expect(label(wireValue)).not.toContain(wireValue);
  });

  it.each([
    [strategyLabel, "sr", "撐壓分析"],
    [strategyLabel, "ma", "均線趨勢"],
    [strategyLabel, "chips", "籌碼動能"],
    [strategyLabel, "pattern", "型態偵測"],
    [signalLabel, "BUY", "正向訊號"],
    [signalLabel, "SELL", "負向訊號"],
    [signalLabel, "HOLD", "中性訊號"],
    [signalLabel, "UNKNOWN", "未判定"],
    [scenarioLabel, "conservative", "保守"],
    [scenarioLabel, "base", "基準"],
    [scenarioLabel, "optimistic", "樂觀"],
    [researchErrorLabel, "invalid_stock_id", "股票代號格式錯誤"],
    [researchErrorLabel, "ai_research_provider_timeout", "AI 研究供應商回應逾時，請稍後再試"],
  ] as const)("preserves the legitimate label for %s", (label, wireValue, expected) => {
    expect(label(wireValue)).toBe(expected);
  });
});
