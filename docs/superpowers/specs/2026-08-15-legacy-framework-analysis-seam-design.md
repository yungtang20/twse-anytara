# Legacy Framework Analysis Seam Design

- 日期：2026-08-15
- 狀態：書面規格已由使用者於 2026-08-15 核准
- 範圍：本機 TypeScript 模組邊界重構

## 背景與問題

目前 `server/mvpMcpRoutes.ts` 同時負責 HTTP 路由、FinMind 資料擷取、分析快照建構、框架提示詞，以及 NVIDIA 報告生成。它又匯入 `server/lib/jobQueue.ts` 的工作佇列 API；另一方面，`jobQueue.ts` 反向匯入 `mvpMcpRoutes.ts` 的分析函式與型別，因此形成路由層與工作佇列之間的循環相依。

另有 `server/routes/fundamentals.ts` 為了使用資料擷取函式而依賴路由模組。這讓純分析能力無法在不載入 Express 路由與佇列模組的情況下被重用，也提高初始化順序與後續修改的風險。

## 目標

1. 消除 `mvpMcpRoutes.ts` 與 `jobQueue.ts` 的循環匯入。
2. 建立單一、明確且可重用的舊版框架分析介面。
3. 保留既有路由、回應狀態、錯誤文字、框架提示、資料來源選擇與工作佇列行為。
4. 保留目前的執行邊界：工作佇列及其 SQLite 儲存僅屬測試模式；雲端正式模式仍不使用持久化本機 SQLite。
5. 以測試鎖定相依方向，避免循環匯入再次出現。

## 非目標

- 不新增、移除或升級套件。
- 不變更 Supabase schema、migration、RLS、權限或雲端設定。
- 不執行同步、回填、刪除或任何正式資料異動。
- 不更改 FinMind、NVIDIA 或其他供應商的請求格式、重試、快取或憑證行為。
- 不更改框架提示詞、分析演算法、報告格式或資料充分性判定。
- 不退役舊版工作佇列，也不把它擴張為正式雲端架構。

## 架構決策

新增 `server/lib/legacyFrameworkAnalysis.ts`，作為舊版框架分析的深層模組。它擁有資料擷取、快照建構、框架提示與報告生成實作，但不得依賴 Express、`mvpMcpRoutes.ts`、`jobQueue.ts` 或 SQLite。

對外介面限於既有消費者所需的型別與函式：

```ts
export interface AnalysisSnapshot extends StockSnapshot {
  dataBlock: string;
  datasetRows: Record<string, number>;
}

export interface FrameworkAnalysisResult {
  report: string;
  claims: ReportClaim[];
  evidence: Record<string, unknown>;
  evidenceSummary: EvidenceSummary;
  provider?: "nvidia";
}

export async function fetchFundamentalDataset(
  stockId: string,
  datasetName: string,
  signal?: AbortSignal,
): Promise<FundamentalDatasetResult>;

export async function fetchAnalysisSnapshot(
  stockId: string,
  signal?: AbortSignal,
  frameworkIds?: string[],
): Promise<AnalysisSnapshot>;

export async function fetchFinancialSnapshot(
  stockId: string,
  signal?: AbortSignal,
  identityOverride?: {
    companyName?: string | null;
    market?: string | null;
    industry?: string | null;
  },
): Promise<AnalysisSnapshot>;

export async function runFrameworkAnalysis(
  stockId: string,
  frameworkId: string,
  signal?: AbortSignal,
  suppliedSnapshot?: AnalysisSnapshot,
): Promise<FrameworkAnalysisResult>;
```

`FundamentalDatasetResult` 可保留為模組內匯出的具名型別，讓 TypeScript 推導與呼叫端測試維持清楚；不為了此次重構擴張更多公開 API。

### 規劃階段的相容性澄清

核對目前 checkout 後確認另有兩個既存需求，處理方式如下：

- `selectFinMindDatasetNames(frameworkIds?: string[]): string[]` 目前已由 `tests/self-check.ts` 直接使用；它隨實作移至新模組並維持既有匯出，不是新增產品能力。
- `mvpMcpRoutes.ts` 目前以 `FRAMEWORK_PROMPTS` 的鍵值驗證框架 ID。新模組僅新增窄介面 `isLegacyFrameworkId(value: string): boolean` 供路由維持相同行為，不匯出提示詞內容。

這兩項只維持現有相容性與封裝，不改變路由、框架清單、提示詞或分析結果。

## 相依方向

重構後的相依關係固定如下：

```text
server/routes/analysisTdcc.ts
            |
            v
server/mvpMcpRoutes.ts ------> server/lib/jobQueue.ts
            |                            |
            |                            |
            v                            v
       server/lib/legacyFrameworkAnalysis.ts
            ^
            |
server/routes/fundamentals.ts
```

規則如下：

- `mvpMcpRoutes.ts` 只保留 HTTP 請求驗證、回應映射與工作佇列路由協調。
- `jobQueue.ts` 直接由 `legacyFrameworkAnalysis.ts` 匯入分析函式與型別。
- `fundamentals.ts` 直接由 `legacyFrameworkAnalysis.ts` 匯入基本面資料函式。
- `analysisTdcc.ts` 仍可匯入 `mvpMcpRoutes.ts` 的路由處理函式。
- `legacyFrameworkAnalysis.ts` 不得反向匯入任何路由或工作佇列模組。
- `mvpMcpRoutes.ts` 不重新匯出分析函式，避免舊的相依入口被保留下來。

## 資料流與錯誤行為

本次只移動實作與更新匯入來源，不改變資料流：

1. 路由或工作佇列傳入 `stockId`、`AbortSignal` 與框架 ID。
2. 分析模組依現行規則載入動態設定、擷取 FinMind 資料並建立 `AnalysisSnapshot`。
3. `runFrameworkAnalysis` 依現行資格判定、提示詞與 NVIDIA 供應商流程生成結果。
4. 工作佇列依現行方式保存快照、狀態、報告與錯誤摘要。
5. HTTP 層依現行方式將成功或錯誤映射為回應。

所有既有可觀察行為均須保持，包括股票代號驗證、取消訊號、`unsupported_financial_dataset`、`insufficient_data`、缺少 NVIDIA API 金鑰的錯誤文字，以及雲端模式對舊版佇列端點的限制。

## 實作策略

1. 先加入相依邊界測試，證明目前 `jobQueue.ts -> mvpMcpRoutes.ts` 的反向依賴會被測試攔截。
2. 將分析相關型別、常數與函式從 `mvpMcpRoutes.ts` 搬移到 `legacyFrameworkAnalysis.ts`；同一份實作只存在一處，不複製邏輯。
3. 更新 `jobQueue.ts` 與 `fundamentals.ts` 的匯入來源。
4. 讓 `mvpMcpRoutes.ts` 只匯入並呼叫新分析模組，保留原有路由契約。
5. 先執行針對性測試與型別檢查，再執行專案的完整本機驗證。

## 測試與驗收

最低驗收條件：

- 相依邊界測試確認：
  - `jobQueue.ts` 不匯入 `mvpMcpRoutes.ts`。
  - `legacyFrameworkAnalysis.ts` 不匯入路由、工作佇列或資料庫模組。
  - `mvpMcpRoutes.ts` 不重新匯出分析介面。
- 現有基本面路由、工作佇列、分析快照、框架資格、AI 報告稽核與發佈門檻測試維持通過。
- `npm run typecheck` 實際執行成功。
- `npm test` 實際執行成功，且不以刪除或弱化既有測試取得通過。
- 如此次移動影響打包邊界，執行 `npm run build` 並確認成功。
- 不執行 `npm run verify:cloud`，除非另有明確雲端驗證授權與有效憑證。

未實際執行的檢查一律記為「未驗證」，不記為成功或失敗。

## 風險與控制

- **遺漏隱性依賴**：以 TypeScript 型別檢查、針對性測試及完整測試發現；搬移時保持函式內容與常數內容不變。
- **初始化順序改變**：新模組不得有路由註冊或工作啟動副作用；頂層僅保留現有必要常數與無副作用設定。
- **介面不必要擴張**：公開匯出限制在三個現有消費端真正使用的型別與函式。
- **誤觸正式資料**：所有驗證限本機、無正式憑證的型別檢查、測試與建置；不執行雲端同步或資料異動。

## 完成定義

只有在原始碼不存在上述循環相依、所有要求的本機檢查均已實際通過，且實際 diff 未包含規格外行為變更時，才可宣告此重構完成。Migration 的本機空白重播因環境缺少 Docker/Podman 而屬另一項「未驗證」事項，不作為本模組邊界重構已成功或失敗的判定依據。
