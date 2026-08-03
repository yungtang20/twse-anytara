# TRINITY 交易風險官方資料來源盤點

驗證日期：2026-08-01（Asia/Taipei）。所有端點均以 HTTPS `GET` 直接探測，TWSE schema 取自
`https://openapi.twse.com.tw/v1/swagger.json`，TPEx schema 取自
`https://www.tpex.org.tw/openapi/swagger.json`。下列 OpenAPI 端點皆無查詢參數。

| 市場 | normalized 類型 | 官方 API | 原始欄位 | 日期／期間 | 範圍與更新 | 空資料／非交易日 |
|---|---|---|---|---|---|---|
| TWSE | attention | `https://openapi.twse.com.tw/v1/announcement/notice` | `Number`, `Code`, `Name`, `NumberOfAnnouncement`, `TradingInfoForAttention`, `Date`, `ClosingPrice`, `PE` | `Date` 同時作公告、生效與結束日 | 當日注意股；交易日更新 | 無資料實測為一筆空白 sentinel（`Code/Date` 空字串），不是 HTTP 失敗；非交易日可能保留最近發布格式 |
| TPEx | attention | `https://www.tpex.org.tw/openapi/v1/tpex_trading_warning_information` | `Date`, `SecuritiesCompanyCode`, `CompanyName`, `TradingInformation`, `ClosePrice`, `PriceEarningRatio` | `Date` 同時作公告、生效與結束日 | 當日注意股；交易日更新 | 標準空格式為 JSON `[]`；非交易日可能保留最近交易日資料 |
| TWSE | disposition | `https://openapi.twse.com.tw/v1/announcement/punish` | `Number`, `Date`, `Code`, `Name`, `NumberOfAnnouncement`, `ReasonsOfDisposition`, `DispositionPeriod`, `DispositionMeasures`, `Detail`, `LinkInformation` | 公告 `Date`；起迄取 `DispositionPeriod` | 無參數的近期／現行公告集合；交易日更新 | JSON `[]`；非交易日通常保留最近公告集合 |
| TPEx | disposition | `https://www.tpex.org.tw/openapi/v1/tpex_disposal_information` | `Date`, `SecuritiesCompanyCode`, `CompanyName`, `DispositionPeriod`, `DispositionReasons`, `DisposalCondition` | 公告 `Date`；起迄取 `DispositionPeriod` | 無參數的近期／現行公告集合；交易日更新 | JSON `[]`；非交易日通常保留最近公告集合 |
| TWSE | trading_halt | `https://openapi.twse.com.tw/v1/exchangeReport/TWTAWU` | `Number`, `Code`, `Name`, `TradingHaltDate`, `TradingHaltTime`, `TradingResumptionDate`, `TradingResumptionTime` | 暫停與恢復日期／時間 | 無參數的近期暫停交易資料；事件更新 | JSON `[]`；非交易日可保留最近事件 |
| TPEx | trading_halt | `https://www.tpex.org.tw/openapi/v1/tpex_spendi_today` | `Date`, `SecuritiesCompanyCode`, `CompanyName`, `暫停交易`, `恢復交易` | `Date` 與兩個 Y/N 狀態 | 當日公布暫停／恢復；事件更新 | JSON `[]` 或最近公布狀態；只有 `暫停交易=Y` 才建立限制紀錄 |
| TWSE | short_sale_restricted | `https://openapi.twse.com.tw/v1/exchangeReport/BFI84U` | `Code`, `Name`, `StartDate`, `EndDate`, `Reason` | 停券起迄 | 停資停券預告表，但公開欄位只明確描述停券；交易日更新 | JSON `[]`；非交易日保留最近預告表 |
| TPEx | short_sale_restricted | `https://www.tpex.org.tw/openapi/v1/tpex_margin_trading_term` | `Date`, `SecuritiesCompanyCode`, `CompanyName`, `ShortSaleSuspensionStartDate`, `ShortSaleSuspensionEndDate`, `Reason` | 公告 `Date`、停券起迄 | 停止融券賣出預告；交易日更新 | JSON `[]`；非交易日保留最近預告表 |
| TWSE | daytrade_restricted | `https://openapi.twse.com.tw/v1/exchangeReport/TWTBAU2` | `Code`, `Name`, `StartDate`, `EndDate`, `Reason` | 停止先賣後買起迄 | 近期歷史查詢結果；無自訂日期參數；交易日更新 | JSON `[]`；非交易日保留最近資料 |
| TPEx | daytrade_restricted | `https://www.tpex.org.tw/openapi/v1/tpex_intraday_trading_his` | `Date`, `SecuritiesCompanyCode`, `CompanyName`, `FirstDayToSuspendSellThenBuy`, `LastDayToSuspendSellThenBuy`, `Reason` | 查詢資料日與停止先賣後買起迄 | 近期歷史查詢結果；無自訂日期參數；交易日更新 | JSON `[]`；非交易日保留最近資料 |

## 支援界線

- `attention`、`disposition`、`trading_halt`、`short_sale_restricted`、`daytrade_restricted`：已支援 TWSE 與 TPEx。
- `margin_restricted`：**unsupported**。目前確認的公開欄位不足以把「停止融資」與停券可靠拆分；TRINITY 不從標題、成交量或其他市場訊號推測。
- `daytrade_restricted` 僅表示官方明列的「暫停先賣後買現股當日沖銷」，不宣稱所有形式的當沖都禁止。
- OpenAPI 不提供來源產製 timestamp；`source_updated_at` 優先使用公告／資料日，`fetched_at` 另存實際抓取時間。
- API 的近期集合不等同完整永久歷史，因此 SQLite 採 append-preserving upsert，累積後保留 TRINITY 自行取得的歷史。
