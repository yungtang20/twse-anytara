# Phase status

## 已完成

### 第一階段：安全與資料正確性

- 停用會產生虛構財務資料的舊 AI API。
- 設定 API 不回傳金鑰，寫入限 localhost，LongCat endpoint 使用 allowlist。
- 移除假預測、假型態信心與未標示 mock；修正 ATR、RSI、均線、法人連續天數及五日均量。
- 預設只綁定 `127.0.0.1`，加入 strict TypeScript、測試與 CI。

### 第二階段：可驗證 AI 報告

- 每個 job 只抓一次 immutable `StockSnapshot`，所有框架共用。
- 由程式計算報酬、波動、VaR、回撤、ATR、營收成長、ROE、FCF、估值及 TDCC 指標。
- 數字 claim 必須附有效 evidence；缺證據的數字會被遮蔽。
- 快照、框架報告、claims 與 evidence 分表儲存。
- SQLite schema migration v1-v2 與對應測試。

### 第三階段：本機運行可靠性

- Active AI job 依股票與框架組合去重。
- SQLite worker lease 防止多程序重複恢復與重複扣額。
- FinMind/LongCat 對 transient failure 最多重試一次。
- SIGINT/SIGTERM 優雅停止 job、TDCC scheduler、同步 child process 與 SQLite。
- 背景同步直接使用目前 Node 執行檔，不再透過 `npx tsx` 臨時下載工具。
- SQLite schema migration v3 與可靠性測試。

### 第四階段：TDCC 單一資料管線

- 上傳、自動下載、手動同步與每週 scheduler 共用同一 parser/writer。
- 統一定義為散戶 1–6 級、大戶 12–16 級、總股數優先採第 17 級合計。
- 支援西元、民國與斜線日期，以及含引號／千分位的 CSV 欄位。
- SQLite 使用 idempotent upsert；Supabase 寫入固定使用 `tdcc_shareholding`。
- 啟動同步不再清空本機 TDCC，也不再從 `stock_features` 誤拉資料。
- 加入 TDCC contract、異常列與重複匯入測試。

### 第五階段：AI 固定 Evaluation Set

- 為 13 個框架定義必要 dataset、deterministic metric 與已知資料限制。
- 資料缺失或必要資料過期時，在呼叫模型前拒絕執行並回報具體原因。
- StockSnapshot 新增 MA20、MA60、RSI14、MACD DIF／Signal／Histogram。
- 建立電子、金融、航運、生技、傳產、ETF、資料不足七類離線 synthetic fixtures。
- 固定檢查 eligibility、公式誤差、stale warning、claim evidence、數字遮蔽與共享快照不變性。
- CI 加入 `npm run test:eval`；前端顯示 framework 的具體資料充分性錯誤。

### 第六階段：低風險路由拆分

- 將 AI job、舊 AI alias、TDCC 與 bridge 端點移至 `routes/analysisTdcc.ts`。
- 將 settings、Supabase diagnostics、cleanup 與雙向同步移至 `routes/settings.ts`。
- AI、TDCC、settings、cleanup、bridge、回補與手動同步寫入統一限制為 localhost。
- 手動同步不再透過 `npx tsx`，改用目前 Node 與專案內已安裝的 tsx CLI。
- 加入 route inventory 測試，防止拆分時漏掉或重複註冊 endpoint。
- 主 `server/routes.ts` 由約 2,400 行降至約 1,800 行。

### 第七階段：Dashboard 與策略路由拆分

- 將 movers 與四個 dashboard 指標端點移至 `routes/dashboard.ts`。
- 將五個個股策略分析與五個全市場掃描端點移至 `routes/strategies.ts`。
- SQL、策略計分公式、停用中的 prediction API 與既有路徑保持不變。
- route inventory 涵蓋新拆出的 15 個端點，並持續檢查漏註冊與重複註冊。
- 主 `server/routes.ts` 由約 1,800 行降至約 1,000 行。

### 第八階段：股票查詢與基本面路由拆分

- 將搜尋、歷史股價、指標、法人、集保與完整報價移至 `routes/stocks.ts`。
- 將估值、融資券、月營收與季度財報移至 `routes/fundamentals.ts`。
- Yahoo 即時補價 helper 移至 `lib/yahooPrice.ts`，供股票查詢與 backfill 共用，未複製實作。
- SQL、Supabase fallback、回傳格式與資料品質警告保持不變。
- route inventory 新增上述 10 個端點，持續檢查漏註冊與重複註冊。
- 主 `server/routes.ts` 降至 465 行，只剩同步、backfill 與服務狀態端點。

### 第九階段：完成路由模組化

- 將每日同步、背景更新、同步狀態與 FinMind 回補移至 `routes/syncBackfill.ts`。
- 將 health、TWSE／OTC 統計與 debug status 移至 `routes/status.ts`。
- 同步流程、localhost 權限、FinMind free-tier 邏輯、SQLite 寫入與錯誤回傳保持不變。
- route inventory 新增最後 8 個端點，涵蓋所有拆分模組並持續檢查重複註冊。
- 主 `server/routes.ts` 降至 22 行，現在只負責組裝子 router。

### 第十階段：Supabase Data API 診斷

- 以實際 REST 請求確認目前為 HTTP 503／`PGRST002`，不是 URL 或 anon key 格式錯誤。
- settings 診斷 API 對 `PGRST002` 回傳明確原因、Dashboard 入口與修復步驟，不再只顯示模糊連線錯誤。
- `scripts/check_sb.ts` 改用最多一列的 GET，保留錯誤 response body 並輸出安全的結構化診斷。
- 加入 `PGRST002` 分類與 Dashboard URL 的自我檢查。

## 尚未進行

- 登入 Supabase Dashboard，修正 Data API 的 Exposed schemas 並重新載入 schema cache；目前瀏覽器尚未登入。
