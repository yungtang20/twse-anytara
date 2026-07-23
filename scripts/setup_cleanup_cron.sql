-- 1. 啟用 pg_cron 擴充功能
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. 建立精準保留 512 個交易日的清理函數
CREATE OR REPLACE FUNCTION delete_old_stock_data()
RETURNS void AS $$
DECLARE
    cutoff_date DATE;
BEGIN
    -- 以台積電 (2330) 的交易紀錄作為全市場交易日曆基準，找出倒數第 512 個交易日的日期
    -- 注意：OFFSET 511 是指跳過最新的 511 天，取得第 512 天的日期
    SELECT date INTO cutoff_date 
    FROM stock_price 
    WHERE stock_id = '2330' 
    ORDER BY date DESC 
    OFFSET 511 LIMIT 1;

    -- 確保有找到正確的基準日期，才進行刪除動作以保證安全
    IF cutoff_date IS NOT NULL THEN
        -- 刪除小於基準日期的舊資料
        DELETE FROM stock_price WHERE date < cutoff_date;
        DELETE FROM stock_institutional WHERE date < cutoff_date;
        DELETE FROM stock_features WHERE date < cutoff_date;
        DELETE FROM tdcc_shareholding WHERE date < cutoff_date;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- 3. 確保排程設定：每天凌晨 3 點自動執行清理 (這會更新現有的排程)
SELECT cron.schedule(
    'cleanup-old-stock-data',
    '0 3 * * *',
    'SELECT delete_old_stock_data();'
);
