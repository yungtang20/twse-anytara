import { describe, expect, it } from "vitest";
import {
  claimKindLabel,
  claimStanceLabel,
  datasetLabel,
  groundingLabel,
  informationRichnessLabel,
  providerLabel,
  qualityStatusLabel,
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
  ] as const)("returns the neutral fallback for reserved %s keys", (_name, label, fallback) => {
    for (const key of reservedKeys) expect(label(key)).toBe(fallback);
  });
});
