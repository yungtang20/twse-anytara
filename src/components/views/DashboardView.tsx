import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  CheckCircle2,
  Info,
} from "lucide-react";
import { cn, getMarketStatus } from "../../lib/utils";
import type { AppView } from "../../types";
import { ClockBadge } from "../ClockBadge";

// ── Types ──────────────────────────────────────────────────

interface IndexStats {
  success: boolean;
  index: number;
  change: number;
  changePercent: number;
  amount: number;
  limitUp: number;
  up: number;
  flat: number;
  down: number;
  limitDown: number;
  error?: string;
  date?: string;
}

interface IndexChartDataPoint {
  date: string;
  index: number;
  change: number;
  changePercent: number;
  amount: number;
}

interface DividendStock {
  stock_id: string;
  stock_name: string;
  date: string;
  cash_dividend: number;
  stock_dividend: number;
  reference_price: number;
  close: number;
  prev_close: number;
  change_pct: number;
  volume: number;
  volume_change_pct: number;
}

interface TrustBuyStock {
  stock_id: string;
  stock_name: string;
  volume: number;
  amount: number;
  trust_days: number;
  trust_net: number;
  close: number;
  prev_close: number;
  change_pct: number;
  volume_change_pct: number;
}

interface BreakMA200Stock {
  stock_id: string;
  stock_name: string;
  prev_close: number;
  latest_close: number;
  prev_ma200: number;
  latest_ma200: number;
  volume: number;
  close: number;
  change_pct: number;
  volume_change_pct: number;
}

interface LimitUpStock {
  stock_id: string;
  stock_name: string;
  close: number;
  prev_close: number;
  change_pct: number;
  volume: number;
  vol_explosion_pct: number;
  volume_change_pct: number;
}

// ── Collapsible Card ───────────────────────────────────────

function CollapsibleCard({
  title,
  icon,
  iconColor,
  children,
  subtitle,
  loading,
  error,
  onRetry,
}: {
  title: string;
  icon: React.ReactNode;
  iconColor: string;
  children: React.ReactNode;
  subtitle?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-bg-secondary border border-border rounded-lg overflow-hidden">
      <div
        className="px-2 py-1.5 bg-bg-tertiary border-b border-border flex items-center justify-between cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <span className={iconColor}>{icon}</span>
          <span className="text-[14px] font-medium text-gray-300">{title}</span>
          {subtitle && (
            <span className="text-[12px] text-gray-600 ml-1">({subtitle})</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {collapsed ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
          ) : (
            <ChevronUp className="w-3.5 h-3.5 text-gray-500" />
          )}
        </div>
      </div>
      {!collapsed && (
        <div className="p-2">
          {loading && (
            <div className="flex items-center justify-center py-6 text-gray-500 text-xs">
              <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" />
              載入中...
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2 py-4 text-xs text-error bg-error/10 rounded px-3">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="flex-1">{error}</span>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="text-xs text-primary-500 hover:text-yellow-300"
                >
                  重試
                </button>
              )}
            </div>
          )}
          {!loading && !error && children}
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard View ────────────────────────────────────

export function DashboardView() {
  // Clock state moved to <ClockBadge /> to avoid full-page re-renders every second.
  const [tseStats, setTseStats] = useState<IndexStats>({
    success: false,
    index: 0,
    change: 0,
    changePercent: 0,
    amount: 0,
    limitUp: 0,
    up: 0,
    flat: 0,
    down: 0,
    limitDown: 0,
  });

  const [dividendData, setDividendData] = useState<DividendStock[]>([]);
  const [dividendLoading, setDividendLoading] = useState(false);
  const [dividendError, setDividendError] = useState<string | null>(null);

  const [trustBuyData, setTrustBuyData] = useState<TrustBuyStock[]>([]);
  const [trustBuyLoading, setTrustBuyLoading] = useState(false);
  const [trustBuyError, setTrustBuyError] = useState<string | null>(null);

  const [breakMaData, setBreakMaData] = useState<BreakMA200Stock[]>([]);
  const [breakMaLoading, setBreakMaLoading] = useState(false);
  const [breakMaError, setBreakMaError] = useState<string | null>(null);

  const [limitUpData, setLimitUpData] = useState<LimitUpStock[]>([]);
  const [limitUpLoading, setLimitUpLoading] = useState(false);
  const [limitUpError, setLimitUpError] = useState<string | null>(null);

  const [otcStats, setOtcStats] = useState<IndexStats>({
    success: false,
    index: 0,
    change: 0,
    changePercent: 0,
    amount: 0,
    limitUp: 0,
    up: 0,
    flat: 0,
    down: 0,
    limitDown: 0,
  });

  const isOpen = getMarketStatus();

  // Load TWSE stats
  useEffect(() => {
    const loadTwse = async () => {
      try {
        const res = await fetch("/api/twse-stats");
        const data = await res.json();
        if (data.success) {
          const stats = data.data || data;
          setTseStats({
            success: true,
            index: stats.index,
            change: stats.change,
            changePercent: stats.changePercent,
            amount: stats.amount,
            limitUp: stats.limitUp,
            up: stats.up,
            flat: stats.flat,
            down: stats.down,
            limitDown: stats.limitDown,
            date: stats.date,
          });
        }
      } catch {
        // ignore TWSE error
      }
    };
    loadTwse();
  }, []);

  // Load OTC stats
  useEffect(() => {
    const loadOtc = async () => {
      try {
        const res = await fetch("/api/otc-stats");
        const data = await res.json();
        if (data.success) {
          const stats = data.data || data;
          setOtcStats({
            success: true,
            index: stats.index,
            change: stats.change,
            changePercent: stats.changePercent,
            amount: stats.amount,
            limitUp: stats.limitUp,
            up: stats.up,
            flat: stats.flat,
            down: stats.down,
            limitDown: stats.limitDown,
            date: stats.date,
          });
        }
      } catch {
        // ignore OTC error
      }
    };
    loadOtc();
  }, []);

  // Clock is now rendered by <ClockBadge /> — no state here.

  // ── Dividend query ──────────────────────────────────────
  const loadDividend = useCallback(async () => {
    setDividendLoading(true);
    setDividendError(null);
    try {
      const res = await fetch("/api/dashboard/recent-dividend");
      const data = await res.json();
      if (data.success) setDividendData(data.data);
      else setDividendError(data.error ?? "查詢失敗");
    } catch (e: any) {
      setDividendError(e.message ?? "網路錯誤");
    } finally {
      setDividendLoading(false);
    }
  }, []);
  useEffect(() => { loadDividend(); }, [loadDividend]);

  // ── Trust buy query ─────────────────────────────────────
  const loadTrustBuy = useCallback(async () => {
    setTrustBuyLoading(true);
    setTrustBuyError(null);
    try {
      const res = await fetch("/api/dashboard/trust-buy-2day");
      const data = await res.json();
      if (data.success) setTrustBuyData(data.data);
      else setTrustBuyError(data.error ?? "查詢失敗");
    } catch (e: any) {
      setTrustBuyError(e.message ?? "網路錯誤");
    } finally {
      setTrustBuyLoading(false);
    }
  }, []);
  useEffect(() => { loadTrustBuy(); }, [loadTrustBuy]);

  // ── Break MA200 query ───────────────────────────────────
  const loadBreakMa = useCallback(async () => {
    setBreakMaLoading(true);
    setBreakMaError(null);
    try {
      const res = await fetch("/api/dashboard/break-ma200");
      const data = await res.json();
      if (data.success) setBreakMaData(data.data);
      else setBreakMaError(data.error ?? "查詢失敗");
    } catch (e: any) {
      setBreakMaError(e.message ?? "網路錯誤");
    } finally {
      setBreakMaLoading(false);
    }
  }, []);
  useEffect(() => { loadBreakMa(); }, [loadBreakMa]);

  // ── Limit up query ──────────────────────────────────────
  const loadLimitUp = useCallback(async () => {
    setLimitUpLoading(true);
    setLimitUpError(null);
    try {
      const res = await fetch("/api/dashboard/limit-up-yesterday");
      const data = await res.json();
      if (data.success) setLimitUpData(data.data);
      else setLimitUpError(data.error ?? "查詢失敗");
    } catch (e: any) {
      setLimitUpError(e.message ?? "網路錯誤");
    } finally {
      setLimitUpLoading(false);
    }
  }, []);
  useEffect(() => { loadLimitUp(); }, [loadLimitUp]);

  // timeString now rendered by <ClockBadge /> below.

  // ── Render ──────────────────────────────────────────────

  // Helper: format change with sign
  const formatChange = (val: number) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}`;
  const formatPercent = (val: number) => `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
  const formatAmount = (val: number) => `${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}億`;
  const changeColor = (val: number) => val >= 0 ? 'text-red-400' : 'text-green-400';
  
  // Safe number formatter that handles undefined/null
  const safeToFixed = (val: number | undefined | null, digits: number = 2) => {
    const num = Number(val);
    return isNaN(num) ? '0.00' : num.toFixed(digits);
  };

  // Index card component — 標題顏色隨漲跌變化（紅漲綠跌）
  const renderIndexCard = (
    title: string,
    stats: IndexStats,
  ) => {
    if (!stats.success) {
      return (
        <div className="bg-bg-secondary border border-border rounded-lg p-2.5">
          <div className="text-[16px] font-bold mb-2 text-gray-400">{title} ---</div>
          <div className="text-gray-600 text-center py-4">暫無資料</div>
        </div>
      );
    }

    // 標題顏色：漲=紅，跌=綠
    const titleColorClass = stats.change >= 0 ? 'text-red-400' : 'text-green-400';

    return (
      <div className="bg-bg-secondary border border-border rounded-lg p-2.5">
        {/* Title */}
        <div className={`text-base font-bold mb-1 ${titleColorClass}`}>
          {title} {stats.index.toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </div>
        {/* Main stats: 收盤 + 漲跌 */}
        <div className="grid grid-cols-2 gap-y-1 mb-1 pb-1.5 border-b border-border/50">
          <div>
            <div className="text-gray-500 text-[12px] mb-0.5">收盤</div>
            <div className="text-gray-200 font-mono font-bold text-base leading-none">
              {stats.index.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          </div>
          <div className="text-right flex flex-col justify-end">
            <div className="text-gray-500 text-[12px] mb-0.5">漲跌</div>
            <div className={`font-mono font-bold text-base leading-none ${changeColor(stats.change)}`}>
              {formatChange(stats.change)} ({formatPercent(stats.changePercent)})
            </div>
          </div>
        </div>
        {/* High/Low + Amount */}
        <div className="grid grid-cols-3 gap-y-1 mb-1.5 pb-1.5 border-b border-border/50 mt-1.5">
          <div>
            <div className="text-gray-500 text-[12px] mb-0.5">昨收</div>
            <div className="text-gray-300 font-mono font-semibold text-xs leading-none">
              {((stats.index - stats.change)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          </div>
          <div>
            <div className="text-gray-500 text-[12px] mb-0.5">最新</div>
            <div className="text-gray-300 font-mono font-semibold text-xs leading-none">
              {stats.index.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </div>
          </div>
          <div className="text-right flex flex-col justify-end">
            <div className="text-gray-500 text-[12px] mb-0.5">成交</div>
            <div className="text-gray-300 font-mono font-semibold text-xs leading-none">{formatAmount(stats.amount)}</div>
          </div>
        </div>
        {/* 漲跌家數 */}
        <div className="pt-1.5 border-t border-border/50">
          <div className="grid grid-cols-5 gap-0 text-center">
            <div className="flex flex-col items-center justify-center">
              <span className="text-red-400 text-[10px] font-bold mb-0.5">漲停</span>
              <span className="text-red-400 font-mono font-bold text-[15px] tracking-tight leading-none">{stats.limitUp}</span>
            </div>
            <div className="flex flex-col items-center justify-center">
              <span className="text-red-400/90 text-[10px] font-bold mb-0.5">上漲</span>
              <span className="text-red-400 font-mono font-bold text-[15px] tracking-tight leading-none">{stats.up}</span>
            </div>
            <div className="flex flex-col items-center justify-center">
              <span className="text-gray-400 text-[10px] font-bold mb-0.5">平盤</span>
              <span className="text-gray-400 font-mono font-bold text-[15px] tracking-tight leading-none">{stats.flat}</span>
            </div>
            <div className="flex flex-col items-center justify-center">
              <span className="text-green-400/90 text-[10px] font-bold mb-0.5">下跌</span>
              <span className="text-green-400 font-mono font-bold text-[15px] tracking-tight leading-none">{stats.down}</span>
            </div>
            <div className="flex flex-col items-center justify-center">
              <span className="text-green-400 text-[10px] font-bold mb-0.5">跌停</span>
              <span className="text-green-400 font-mono font-bold text-[15px] tracking-tight leading-none">{stats.limitDown}</span>
            </div>
          </div>
          {/* 總計 */}
          <div className="text-center text-[10px] text-gray-500 mt-1.5">
            合計 {(stats.limitUp + stats.up + stats.flat + stats.down + stats.limitDown).toLocaleString()} 檔
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-2">
      {/* UX Status Header Bar */}
      <div className="bg-bg-secondary border border-border rounded-lg p-2.5 flex flex-col md:flex-row md:items-center justify-between gap-2 shadow-sm">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-primary-500 bg-primary-500/10 px-2 py-0.5 rounded-full">
              <ClockBadge />
            </span>
            <span>
              {isOpen ? (
                <span className="flex items-center gap-1 text-[11px] font-medium text-green-400 bg-green-500/10 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  開盤中
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] font-medium text-gray-400 bg-gray-500/10 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
                  市場收盤
                </span>
              )}
            </span>
          </div>
          <p className="text-xs text-gray-400 mt-1 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
            <span>
              最新數據基準日：<strong className="text-gray-200">{tseStats.date || "2026-06-25"}</strong>（與交易所每日盤後同步）
            </span>
          </p>
        </div>
        <div className="flex flex-col sm:flex-row md:items-end gap-2 text-right">
          <div className="flex items-center gap-1.5 text-xs text-green-400 bg-green-500/5 border border-green-500/10 px-2.5 py-1 rounded-md">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>系統資料庫運作良好 • 同步完成</span>
          </div>
        </div>
      </div>

      {/* Two index cards side by side */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-2">
        {renderIndexCard("加權指數", tseStats)}
        {renderIndexCard("櫃買指數", otcStats)}
      </div>

      {/* 4-column grid */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-1.5">
        {/* 1. 接下來一週發放股利 */}
        <CollapsibleCard
          title="接下來一週發放股利"
          icon={<span className="text-base">💰</span>}
          iconColor="text-yellow-400"
          subtitle={`${dividendData.length} 檔`}
          loading={dividendLoading}
          error={dividendError}
          onRetry={loadDividend}
        >
          {dividendData.length === 0 ? (
            <div className="text-[11px] text-gray-600 text-center py-2">暫無資料</div>
          ) : (
            <div className="space-y-0.5">
              {dividendData.slice(0, 8).map((s) => (
                <div key={s.stock_id} className="flex items-center justify-between py-0.5 border-b border-border/30 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[11px] font-mono font-medium text-gray-300">{s.stock_id}</span>
                      <span className="text-[10px] text-gray-500 truncate">{s.stock_name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className={`font-mono ${changeColor(s.change_pct ?? 0)}`}>
                        {s.close ? `${safeToFixed(s.close)} (${formatPercent(s.change_pct ?? 0)})` : '-'}
                      </span>
                      <span className="text-gray-500">
                        量{s.volume_change_pct ? `${s.volume_change_pct >= 0 ? '+' : ''}${safeToFixed(s.volume_change_pct, 0)}%` : '-'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right ml-1.5 shrink-0">
                    <div className="text-[10px] text-gray-500">{s.date}</div>
                    <div className="text-[11px] text-red-400 font-mono">
                      現{s.cash_dividend !== undefined ? Number(s.cash_dividend).toFixed(2) : '0.00'}
                      {s.stock_dividend > 0 && <span className="text-green-400 ml-0.5">+{s.stock_dividend}股</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleCard>

        {/* 2. 投信連買二日 */}
        <CollapsibleCard
          title="投信連買二日"
          icon={<span className="text-base">📈</span>}
          iconColor="text-green-400"
          subtitle={`${trustBuyData.length} 檔`}
          loading={trustBuyLoading}
          error={trustBuyError}
          onRetry={loadTrustBuy}
        >
          {trustBuyData.length === 0 ? (
            <div className="text-[11px] text-gray-600 text-center py-2">暫無資料</div>
          ) : (
            <div className="space-y-0.5">
              {trustBuyData.slice(0, 8).map((s) => (
                <div key={s.stock_id} className="flex items-center justify-between py-0.5 border-b border-border/30 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[11px] font-mono font-medium text-gray-300">{s.stock_id}</span>
                      <span className="text-[10px] text-gray-500 truncate">{s.stock_name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className={`font-mono ${changeColor(s.change_pct ?? 0)}`}>
                        {s.close ? `${safeToFixed(s.close)} (${formatPercent(s.change_pct ?? 0)})` : '-'}
                      </span>
                      <span className="text-gray-500">
                        量{s.volume_change_pct ? `${s.volume_change_pct >= 0 ? '+' : ''}${safeToFixed(s.volume_change_pct, 0)}%` : '-'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right ml-1.5 shrink-0">
                    <div className="text-[11px] text-red-400 font-mono font-bold">
                      連買{s.trust_days}日
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleCard>

        {/* 3. 突破 MA200 */}
        <CollapsibleCard
          title="突破 MA200"
          icon={<span className="text-base">🚀</span>}
          iconColor="text-blue-400"
          subtitle={`${breakMaData.length} 檔`}
          loading={breakMaLoading}
          error={breakMaError}
          onRetry={loadBreakMa}
        >
          {breakMaData.length === 0 ? (
            <div className="text-[11px] text-gray-600 text-center py-2">暫無資料</div>
          ) : (
            <div className="space-y-0.5">
              {breakMaData.slice(0, 8).map((s) => {
                const changePct = s.prev_close > 0 ? ((s.latest_close - s.prev_close) / s.prev_close * 100) : 0;
                const tomorrowMa200 = s.latest_ma200 + (s.latest_close - s.prev_ma200) / 200;
                return (
                  <div key={s.stock_id} className="flex items-center justify-between py-0.5 border-b border-border/30 last:border-0">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1">
                        <span className="text-[11px] font-mono font-medium text-gray-300">{s.stock_id}</span>
                        <span className="text-[10px] text-gray-500 truncate">{s.stock_name}</span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px]">
                        <span className={`font-mono ${changeColor(changePct)}`}>
                          {s.latest_close > 0 ? `${safeToFixed(s.latest_close)} (${formatPercent(changePct)})` : '-'}
                        </span>
                        <span className="text-gray-500">
                          量{s.volume_change_pct ? `${s.volume_change_pct >= 0 ? '+' : ''}${safeToFixed(s.volume_change_pct, 0)}%` : '-'}
                        </span>
                      </div>
                    </div>
                    <div className="text-right ml-1.5 shrink-0">
                      <div className="text-[10px] text-gray-500 font-mono">
                        MA200 {tomorrowMa200.toFixed(2)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CollapsibleCard>

        {/* 4. 昨日漲跌停 */}
        <CollapsibleCard
          title="昨日漲跌停"
          icon={<span className="text-base">🔴</span>}
          iconColor="text-red-400"
          subtitle={`${limitUpData.length} 檔`}
          loading={limitUpLoading}
          error={limitUpError}
          onRetry={loadLimitUp}
        >
          {limitUpData.length === 0 ? (
            <div className="text-[11px] text-gray-600 text-center py-2">暫無資料</div>
          ) : (
            <div className="space-y-0.5">
              {limitUpData.slice(0, 8).map((s) => (
                <div key={s.stock_id} className="flex items-center justify-between py-0.5 border-b border-border/30 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[11px] font-mono font-medium text-gray-300">{s.stock_id}</span>
                      <span className="text-[10px] text-gray-500 truncate">{s.stock_name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <span className={`font-mono ${changeColor(s.change_pct ?? 0)}`}>
                        {s.close ? `${safeToFixed(s.close)} (${formatPercent(s.change_pct ?? 0)})` : '-'}
                      </span>
                      <span className="text-gray-500">
                        量{s.volume_change_pct ? `${s.volume_change_pct >= 0 ? '+' : ''}${safeToFixed(s.volume_change_pct, 0)}%` : '-'}
                      </span>
                    </div>
                  </div>
                  <div className="text-right ml-1.5 shrink-0">
                    <div className="text-[11px] text-red-400 font-mono font-bold">
                      +{safeToFixed(s.change_pct)}%
                    </div>
                    <div className="text-[10px] text-orange-400 font-mono">
                      爆量{s.vol_explosion_pct > 0 ? '+' : ''}{safeToFixed(s.vol_explosion_pct, 0)}%
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CollapsibleCard>
      </div>
    </div>
  );
}

export default DashboardView;
