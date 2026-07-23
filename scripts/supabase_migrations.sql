-- Phase 1 Migration: 4 表 + cleanup function + pg-cron
-- 1) 估值表
CREATE TABLE IF NOT EXISTS stock_valuation (
  stock_id TEXT NOT NULL, date DATE NOT NULL, yield REAL, pe_ratio REAL, pb_ratio REAL,
  updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_valuation_stock_date ON stock_valuation(stock_id, date);
ALTER TABLE stock_valuation REPLICA IDENTITY FULL;

-- 2) 融資融券餘額表
CREATE TABLE IF NOT EXISTS stock_margin (
  stock_id TEXT NOT NULL, date DATE NOT NULL, margin_buy BIGINT, margin_sell BIGINT,
  margin_cash_redeem BIGINT, margin_balance BIGINT, short_buy BIGINT, short_sell BIGINT,
  short_balance BIGINT, updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (stock_id, date)
);
CREATE INDEX IF NOT EXISTS idx_margin_stock_date ON stock_margin(stock_id, date);
ALTER TABLE stock_margin REPLICA IDENTITY FULL;

-- 3) 月營收表
CREATE TABLE IF NOT EXISTS stock_monthly_revenue (
  stock_id TEXT NOT NULL, year_month TEXT NOT NULL, month_revenue BIGINT,
  cumulative_revenue BIGINT, mom REAL, yoy REAL,
  updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (stock_id, year_month)
);
CREATE INDEX IF NOT EXISTS idx_revenue_stock_ym ON stock_monthly_revenue(stock_id, year_month);
ALTER TABLE stock_monthly_revenue REPLICA IDENTITY FULL;

-- 4) 季財報表
CREATE TABLE IF NOT EXISTS stock_financials_quarter (
  stock_id TEXT NOT NULL, quarter_label TEXT NOT NULL, revenue BIGINT,
  net_income BIGINT, eps REAL,
  updated_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (stock_id, quarter_label)
);
CREATE INDEX IF NOT EXISTS idx_financials_stock_q ON stock_financials_quarter(stock_id, quarter_label);
ALTER TABLE stock_financials_quarter REPLICA IDENTITY FULL;

-- 5) cleanup function
CREATE OR REPLACE FUNCTION cleanup_expired_supabase_data()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $cleanup$
DECLARE cutoff_512 DATE; d5y DATE; d5y_ym TEXT; d16q TEXT;
BEGIN
  SELECT date INTO cutoff_512 FROM stock_price WHERE stock_id = '2330'
    ORDER BY date DESC OFFSET 511 LIMIT 1;
  IF cutoff_512 IS NULL THEN RETURN; END IF;
  DELETE FROM stock_price WHERE date < cutoff_512;
  DELETE FROM stock_institutional WHERE date < cutoff_512;
  DELETE FROM stock_valuation WHERE date < cutoff_512;
  DELETE FROM stock_margin WHERE date < cutoff_512;
  DELETE FROM stock_features WHERE date < cutoff_512;
  DELETE FROM tdcc_shareholding WHERE date < cutoff_512;
  d5y := CURRENT_DATE - INTERVAL '5 years';
  d5y_ym := to_char(d5y, 'YYYY-MM');
  DELETE FROM stock_monthly_revenue WHERE year_month < d5y_ym;
  d16q := to_char(CURRENT_DATE - INTERVAL '4 years', 'YYYY-"Q"Q');
  DELETE FROM stock_financials_quarter WHERE quarter_label < d16q;
END;
$cleanup$;

-- 6) pg_cron 排程 (Supabase 需先啟用 pg_cron Extension)
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('twse-cleanup-daily', '0 6 * * *',
  'SELECT cleanup_expired_supabase_data();'
);
-- 備註: SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
