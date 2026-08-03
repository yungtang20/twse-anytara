import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file: string) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("presenter allowlists recommendation and server-calculated valuation", async () => {
  const [presenter, shared, contract] = await Promise.all([
    read("server/lib/aiResearchReportPresenter.ts"), read("shared/aiResearchReport.ts"), read("shared/aiResearch.ts"),
  ]);
  for (const token of ["recommendation", "valuation", "currentPrice", "expectedReturnRatio", "expectedReturnPercent"]) {
    assert.match(`${presenter}\n${shared}\n${contract}`, new RegExp(token));
  }
  assert.doesNotMatch(presenter, /candidate|untrustedEvidence|ResearchPacket|rawPrompt|apiKey/i);
});

test("mechanical preview renders recommendation and valuation without client calculation", async () => {
  const [view, evaluator] = await Promise.all([
    read("src/components/views/AIResearchView.tsx"), read("server/lib/aiResearchInvestmentConclusion.ts"),
  ]);
  for (const text of ["綜合研究結論", "買進", "持有", "賣出", "研究期間", "信心值",
    "支持因素", "反對因素", "主要風險", "估值情境", "保守", "基準", "樂觀",
    "目標價", "預期報酬", "現有資料不足以建立可驗證估值",
    "倍數為模型選擇的有界假設，不代表保證獲利"] ) assert.match(`${view}\n${evaluator}`, new RegExp(text));
  assert.doesNotMatch(view, /targetPrice\s*=|expectedReturn(?:Ratio|Percent)?\s*=|\(.*targetPrice.*currentPrice|metric\.value\s*\*/s);
  assert.match(view, /publicationReady|機械驗證預覽/);
});
