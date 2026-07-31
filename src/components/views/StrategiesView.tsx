import React, { useState, useEffect, useMemo, useRef } from 'react';
import { TrendingUp, Users, ShieldCheck, Activity, ChevronLeft, Search, ArrowUpDown, RefreshCw, Database, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { SRPanel } from './SRPanel';
import { MAPanel } from './MAPanel';
import { ChipsPanel } from './ChipsPanel';
import { PatternPanel } from './PatternPanel';
import { KlineChart, type KlineOverlay } from '../KlineChart';
import { ChipsBarChart } from '../ChipsBarChart';
import {
  fetchStockSearch, fetchStockHistory, fetchStockInstitutional, fetchStockShareholding,
  type StockMeta, type PriceData, type InstitutionalRow,
} from '../../lib/api';
import {
  fetchSRScan, fetchMAScan, fetchChipsScan, fetchPatternScan,
  fetchSRAnalysis, fetchMAAnalysis,
  type SRScanItem, type MAScanItem, type ChipsScanItem, type PatternScanItem,
  type SRAnalysis, type MAAnalysis,
} from '../../lib/api';

const strategies = [
  { id: 'support-resistance', name: '撐壓分析',   icon: TrendingUp, desc: '析出關鍵支撐與阻力水位，並標記在 K 線圖上。', color: 'text-amber-400',  bg: 'bg-amber-400/10'  },
  { id: 'ma-trend',          name: '均線趨勢',   icon: Activity,   desc: '扣抵模型（MA-Deduction）透析多空強勢區，圖表顯示 MA25/60/200。', color: 'text-blue-400',   bg: 'bg-blue-400/10'   },
  { id: 'chips-flow',        name: '籌碼動能',   icon: Users,      desc: '三大法人連買賣天數與大戶集保分佈，柱狀圖一目了然。', color: 'text-purple-400', bg: 'bg-purple-400/10' },
  { id: 'pattern-shape',     name: '型態偵測',   icon: ShieldCheck,desc: 'W 底、頸線、黃金交叉區智能辨識。',                   color: 'text-rose-400',  bg: 'bg-rose-400/10'  },
];

interface ScanConfig { maType?: string; chipsType?: string; }

const STRATEGY_COPY: Record<string, { name: string; desc: string }> = {
  'support-resistance': { name: '撐壓分析', desc: '分析關鍵支撐與壓力水位，並標記在 K 線圖上。' },
  'ma-trend': { name: '均線趨勢', desc: '檢查 MA25 / MA60 / MA200 的趨勢、扣抵與多空位置。' },
  'chips-flow': { name: '籌碼動能', desc: '追蹤法人買賣與集保大戶分佈，判斷籌碼集中度。' },
  'pattern-shape': { name: '型態偵測', desc: '偵測 W 底、頸線、黃金交叉等常見技術型態。' },
};

const strategyName = (id: string) => STRATEGY_COPY[id]?.name || id;
const strategyDesc = (id: string) => STRATEGY_COPY[id]?.desc || '';

// ── 根據策略產生 K 線覆蓋層 ──────────────────────────────
function buildOverlay(
  strategy: string,
  srData: SRAnalysis | null,
  maData: MAAnalysis | null,
): KlineOverlay {
  if (strategy === 'support-resistance' && srData) {
    const hLines: KlineOverlay['hLines'] = [];
    const { support, pressure } = srData;
    // 壓力：紅色虛線
    [pressure.near, pressure.mid, pressure.far].forEach((v, i) => {
      if (v) hLines.push({ value: v, color: '#f87171', dash: true,
        label: ['近壓', '中壓', '長壓'][i] });
    });
    // 支撐：綠色虛線
    [support.near, support.mid, support.far].forEach((v, i) => {
      if (v) hLines.push({ value: v, color: '#34d399', dash: true,
        label: ['近撐', '中撐', '長撐'][i] });
    });
    return { hLines };
  }
  if (strategy === 'ma-trend') {
    // 顯示 MA25/60/200 取代預設 MA
    return {
      extraMAs: [
        { period: 25,  color: '#f59e0b', label: 'MA25'  },
        { period: 60,  color: '#3b82f6', label: 'MA60'  },
        { period: 200, color: '#a855f7', label: 'MA200' },
      ],
    };
  }
  return {};
}

export function StrategiesView() {
  const [selectedStrategy, setSelectedStrategy] = useState<string | null>(null);
  const [stockId,     setStockId]     = useState('');
  const [stockName,   setStockName]   = useState('');
  const [searchResults, setSearchResults] = useState<StockMeta[]>([]);
  const [searching,   setSearching]   = useState(false);

  // 掃描
  const [showScanOptions, setShowScanOptions] = useState(false);
  const [minVolume,   setMinVolume]   = useState('500');
  const [scanning,    setScanning]    = useState(false);
  const [scanResults, setScanResults] = useState<any[] | null>(null);
  const [scanSort,    setScanSort]    = useState('1');
  const [scanConfig,  setScanConfig]  = useState<ScanConfig>({});
  const [selectedStockForScan, setSelectedStockForScan] = useState<string | null>(null);

  // 圖表資料
  const [priceData,   setPriceData]   = useState<PriceData[]>([]);
  const [instData,    setInstData]    = useState<InstitutionalRow[]>([]);
  const [shareholding,setShareholding]= useState<{ date: string; ratio: number }[]>([]);
  const [loadingChart,setLoadingChart]= useState(false);
  const [hasDataIssue, setHasDataIssue] = useState(false);

  // ── FinMind 實體同步相關狀態 ──
  const [syncing,     setSyncing]     = useState(false);
  const [syncLogs,    setSyncLogs]    = useState<string[]>([]);
  const [syncError,   setSyncError]   = useState<string | null>(null);

  // 策略分析資料（用於 K 線覆蓋）
  const [srData, setSrData] = useState<SRAnalysis | null>(null);
  const [maDataResult, setMaDataResult] = useState<MAAnalysis | null>(null);
  const [infoTab, setInfoTab] = useState<'strategy' | 'institutional' | 'shareholding'>('strategy');

  const activeStrategy = strategies.find(s => s.id === selectedStrategy);
  const activeSid = selectedStockForScan || (stockId.length >= 4 ? stockId : '');

  // ── 共用載入函數 ──
  const loadStockData = async (sid: string) => {
    setLoadingChart(true);
    setSyncError(null);
    try {
      const [prices, insts, whales] = await Promise.all([
        fetchStockHistory(sid, 1000),
        fetchStockInstitutional(sid),
        fetchStockShareholding(sid)
      ]);

      setPriceData(prices.data);
      setHasDataIssue(prices.data.length === 0 || prices.quality.isMock || prices.quality.isStale || prices.quality.warnings.length > 0);
      setInstData(insts.data);
      setShareholding(whales.data);
    } catch (err) {
      console.error("Failed to load stock data in StrategiesView via API:", err);
    } finally {
      setLoadingChart(false);
    }
  };

  // ── 載入圖表與籌碼資料 ────────────────────────────────
  useEffect(() => {
    if (!activeSid) return;
    loadStockData(activeSid);
  }, [activeSid]);

  // ── 載入策略覆蓋資料（SR / MA）─────────────────────────
  useEffect(() => {
    if (!activeSid || !selectedStrategy) return;
    if (selectedStrategy === 'support-resistance') {
      fetchSRAnalysis(activeSid).then(setSrData).catch(() => setSrData(null));
    }
    if (selectedStrategy === 'ma-trend') {
      fetchMAAnalysis(activeSid).then(setMaDataResult).catch(() => setMaDataResult(null));
    }
  }, [activeSid, selectedStrategy]);

  // ── 策略切換時清理掃描結果 ──
  useEffect(() => {
    setScanResults(null);
    setShowScanOptions(false);
  }, [selectedStrategy]);

  // ── 一鍵同步 FinMind 數據 ──
  const handleSyncFinMind = async () => {
    if (!activeSid) return;
    setSyncing(true);
    setSyncError(null);
    setSyncLogs([
      "[INFO] 正在啟動 TWSE／TPEX 雲端同步...",
      "[INFO] 行情與法人資料將直接寫入 Supabase，不會修改本地 SQLite。",
    ]);

    try {
      const response = await fetch("/api/trigger-update", {
        method: 'POST',
      });

      const resData = await response.json();
      if (resData.success) {
        setSyncLogs(prev => [
          ...prev,
          "🟢 Supabase 更新已在背景啟動；完成後重新載入雲端資料。",
        ]);
        setTimeout(async () => {
          loadStockData(activeSid);
          if (selectedStrategy === 'support-resistance') {
            fetchSRAnalysis(activeSid).then(setSrData).catch(() => setSrData(null));
          }
          if (selectedStrategy === 'ma-trend') {
            fetchMAAnalysis(activeSid).then(setMaDataResult).catch(() => setMaDataResult(null));
          }
          setSyncing(false);
          setSyncLogs([]);
        }, 3000);
      } else {
        throw new Error(resData.error || "Supabase 同步啟動失敗");
      }
    } catch (err: any) {
      setSyncError(err.message || String(err));
      setSyncLogs(prev => [...prev, `❌ 發生錯誤: ${err.message || err}`]);
      setSyncing(false);
    }
  };

  const logContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [syncLogs]);

  const overlay = useMemo(
    () => buildOverlay(selectedStrategy ?? '', srData, maDataResult),
    [selectedStrategy, srData, maDataResult]
  );

  // ── 搜尋 ─────────────────────────────────────────────
  const handleSearch = async (query: string) => {
    setStockId(query);
    if (query.length < 2) { setSearchResults([]); return; }
    setSearching(true);
    try { setSearchResults(await fetchStockSearch(query)); }
    catch { setSearchResults([]); }
    finally { setSearching(false); }
  };

  const selectStock = (stock: StockMeta) => {
    setStockId(stock.stock_id);
    setStockName(stock.stock_name);
    setSearchResults([]);
    setScanResults(null);
    setSelectedStockForScan(stock.stock_id);
  };

  // ── 掃描 ─────────────────────────────────────────────
  const executeScan = async () => {
    if (!selectedStrategy) return;
    setScanning(true); setScanResults(null);
    const mv = parseInt(minVolume) || 500;
    try {
      let results: any[] = [];
      switch (selectedStrategy) {
        case 'support-resistance': results = await fetchSRScan(mv, scanSort); break;
        case 'ma-trend':           results = await fetchMAScan(mv, scanConfig.maType || '1', scanSort); break;
        case 'chips-flow':         results = await fetchChipsScan(scanConfig.chipsType || '1', scanSort); break;
        case 'pattern-shape':      results = await fetchPatternScan(mv, scanSort); break;
      }
      setScanResults(results);
    } catch { setScanResults([]); }
    finally { setScanning(false); }
  };

  const selectFromScan = (item: any) => {
    setStockId(item.stock_id);
    setStockName(item.stock_name || '');
    setSelectedStockForScan(item.stock_id);
    setScanResults(null);
    setShowScanOptions(false);
  };

  const resetStock = () => {
    setStockId(''); setStockName('');
    setSearchResults([]); setScanResults(null);
    setShowScanOptions(false);
    setSelectedStockForScan(null);
    setPriceData([]); setInstData([]); setShareholding([]);
    setSrData(null); setMaDataResult(null);
  };

  // ── 策略分析面板 ─────────────────────────────────────
  const renderPanel = () => {
    if (!activeSid || !selectedStrategy) return null;
    let change = 0;
    let changePercent = 0;
    if (priceData && priceData.length >= 2) {
      const current = priceData[priceData.length - 1];
      const prev = priceData[priceData.length - 2];
      change = current.close - prev.close;
      changePercent = (change / prev.close) * 100;
    }
    switch (selectedStrategy) {
      case 'support-resistance': return <SRPanel stockId={activeSid} />;
      case 'ma-trend':           return <MAPanel stockId={activeSid} change={change} changePercent={changePercent} />;
      case 'chips-flow':         return <ChipsPanel stockId={activeSid} />;
      case 'pattern-shape':      return <PatternPanel stockId={activeSid} />;
    }
  };

  // ── 掃描結果表格 ─────────────────────────────────────
  const renderScanTable = () => {
    if (scanning) return <div className="text-center py-8"><div className="inline-block w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /><p className="text-slate-400 text-sm mt-2">掃描中...</p></div>;
    if (!scanResults?.length) return <div className="text-center py-8 text-slate-500 text-sm">無掃描結果，請調整條件後重試</div>;
    switch (selectedStrategy) {
      case 'support-resistance': return renderSRTable(scanResults as SRScanItem[]);
      case 'ma-trend':           return renderMATable(scanResults as MAScanItem[]);
      case 'chips-flow':         return renderChipsTable(scanResults as ChipsScanItem[]);
      case 'pattern-shape':      return renderPatternTable(scanResults as PatternScanItem[]);
    }
  };

  const thCls = "text-left py-2 px-2 text-slate-500 text-[10px] font-semibold";
  const trCls = "border-b border-slate-800/50 hover:bg-blue-500/5 cursor-pointer transition-colors";

  const renderSRTable = (items: SRScanItem[]) => (
    <table className="w-full text-xs font-mono"><thead><tr className="border-b border-slate-800">
      {['強','代號','名稱','收盤','量(張)','額(億)','動態','距支撐'].map(h => <th key={h} className={thCls}>{h}</th>)}
    </tr></thead><tbody>
      {items.map(item => (<tr key={item.stock_id} onClick={() => selectFromScan(item)} className={trCls}>
        <td className="py-1.5 px-2 text-cyan-400">{item.score}</td>
        <td className="py-1.5 px-2 text-fuchsia-400">{item.stock_id}</td>
        <td className="py-1.5 px-2 text-white">{item.stock_name}</td>
        <td className="py-1.5 px-2 text-right text-yellow-400">{item.close?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-right text-green-400">{item.volume?.toLocaleString() ?? '0'}</td>
        <td className="py-1.5 px-2 text-right text-yellow-300">{item.amount?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-blue-300 max-w-[140px] truncate">{item.tags}</td>
        <td className="py-1.5 px-2 text-right text-red-400">{item.dist > 0 ? '+' : ''}{(item.dist ?? 0).toFixed(2)}%</td>
      </tr>))}
    </tbody></table>
  );

  const renderMATable = (items: MAScanItem[]) => (
    <table className="w-full text-xs font-mono"><thead><tr className="border-b border-slate-800">
      {['代號','名稱','收盤','量(張)','額(億)',items[0]?.targetLabel||'目標','乖離率','曾回踩'].map(h => <th key={h} className={thCls}>{h}</th>)}
    </tr></thead><tbody>
      {items.map(item => (<tr key={item.stock_id} onClick={() => selectFromScan(item)} className={trCls}>
        <td className="py-1.5 px-2 text-fuchsia-400">{item.stock_id}</td>
        <td className="py-1.5 px-2 text-white">{item.stock_name}</td>
        <td className="py-1.5 px-2 text-right text-yellow-400">{item.close?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-right text-green-400">{item.volume?.toLocaleString() ?? '0'}</td>
        <td className="py-1.5 px-2 text-right text-yellow-300">{item.amount?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-right text-white">{item.targetMA?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-right text-red-400">{item.bias > 0 ? '+' : ''}{(item.bias ?? 0).toFixed(2)}%</td>
        <td className="py-1.5 px-2 text-right text-cyan-400">{item.touchCount ?? 0}次</td>
      </tr>))}
    </tbody></table>
  );

  const renderChipsTable = (items: ChipsScanItem[]) => (
    <table className="w-full text-xs font-mono"><thead><tr className="border-b border-slate-800">
      {['代號','名稱','收盤','量(張)','額(億)',items[0]?.type||'類型','連買/賣(天)','淨額(千張)'].map(h => <th key={h} className={thCls}>{h}</th>)}
    </tr></thead><tbody>
      {items.map(item => (<tr key={item.stock_id} onClick={() => selectFromScan(item)} className={trCls}>
        <td className="py-1.5 px-2 text-fuchsia-400">{item.stock_id}</td>
        <td className="py-1.5 px-2 text-white">{item.stock_name}</td>
        <td className="py-1.5 px-2 text-right text-yellow-400">{item.close?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-right text-green-400">{item.volume?.toLocaleString() ?? '0'}</td>
        <td className="py-1.5 px-2 text-right text-yellow-300">{item.amount?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-right text-purple-400">{item.type}</td>
        <td className="py-1.5 px-2 text-right text-cyan-400">{item.consecutive}</td>
        <td className="py-1.5 px-2 text-right text-green-300">{item.netTotal}</td>
      </tr>))}
    </tbody></table>
  );

  const renderPatternTable = (items: PatternScanItem[]) => (
    <table className="w-full text-xs font-mono"><thead><tr className="border-b border-slate-800">
      {['代號','名稱','收盤','量(張)','額(億)','型態','信心度'].map(h => <th key={h} className={thCls}>{h}</th>)}
    </tr></thead><tbody>
      {items.map(item => (<tr key={item.stock_id} onClick={() => selectFromScan(item)} className={trCls}>
        <td className="py-1.5 px-2 text-fuchsia-400">{item.stock_id}</td>
        <td className="py-1.5 px-2 text-white">{item.stock_name}</td>
        <td className="py-1.5 px-2 text-right text-yellow-400">{item.close?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-right text-green-400">{item.volume?.toLocaleString() ?? '0'}</td>
        <td className="py-1.5 px-2 text-right text-yellow-300">{item.amount?.toFixed(2) ?? '0.00'}</td>
        <td className="py-1.5 px-2 text-rose-400">{item.patternName}</td>
        <td className="py-1.5 px-2 text-right text-cyan-400">{((item.confidence ?? 0) * 100).toFixed(0)}%</td>
      </tr>))}
    </tbody></table>
  );

  // ── 掃描設定面板 ─────────────────────────────────────
  const renderScanSettings = () => {
    if (!showScanOptions) return null;
    const isChips = selectedStrategy === 'chips-flow';
    const isMA    = selectedStrategy === 'ma-trend';
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-4">
        <h4 className="text-sm font-bold text-white">全市場掃描設定</h4>
        <div className="flex flex-wrap gap-3 items-end">
          {!isChips && (
            <div>
              <label className="text-xs text-slate-400 block mb-1">最小成交量 (張)</label>
              <input type="number" value={minVolume} onChange={e => setMinVolume(e.target.value)}
                className="w-28 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm outline-none focus:border-blue-500/50" />
            </div>
          )}
          {isMA && (
            <div>
              <label className="text-xs text-slate-400 block mb-1">掃描類型</label>
              <select value={scanConfig.maType||'1'} onChange={e => setScanConfig({...scanConfig, maType: e.target.value})}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm outline-none">
                <option value="1">突破年線 (200MA)</option>
                <option value="2">突破季線 (60MA)</option>
                <option value="3">2560 戰法</option>
              </select>
            </div>
          )}
          {isChips && (
            <div>
              <label className="text-xs text-slate-400 block mb-1">掃描類型</label>
              <select value={scanConfig.chipsType||'1'} onChange={e => setScanConfig({...scanConfig, chipsType: e.target.value})}
                className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm outline-none">
                <option value="1">投信動向</option>
                <option value="2">外資動向</option>
                <option value="3">集保大戶</option>
              </select>
            </div>
          )}
          <div>
            <label className="text-xs text-slate-400 block mb-1">排序方式</label>
            <select value={scanSort} onChange={e => setScanSort(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm outline-none">
              <option value="1">策略優先</option>
              <option value="2">成交金額大→小</option>
            </select>
          </div>
          <button onClick={executeScan} disabled={scanning}
            className="bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700 text-white px-4 py-1.5 rounded-lg text-sm transition-colors">
            {scanning ? '掃描中...' : '開始掃描'}
          </button>
        </div>
      </div>
    );
  };

  // ─────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-2.5">
      <AnimatePresence mode="wait">
        {!selectedStrategy ? (
          /* ── 策略選單首頁 ── */
          <motion.div key="list" initial={{opacity:0,x:-20}} animate={{opacity:1,x:0}} exit={{opacity:0,x:-20}} transition={{duration:0.2}} className="flex flex-col gap-3">
            <div>
              <h2 className="text-2xl font-bold text-white tracking-tight mb-1">五大策略模組</h2>
              <p className="text-slate-400 text-sm">TRINITY 的核心選股策略庫</p>
            </div>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-2.5">
              {strategies.map(s => (
                <div key={s.id} onClick={() => setSelectedStrategy(s.id)}
                  className="bg-slate-900 border border-slate-800 rounded-xl p-3 hover:border-blue-500/50 hover:shadow-[0_0_15px_rgba(59,130,246,0.1)] transition-all cursor-pointer group">
                  <div className={`w-9 h-9 rounded-lg ${s.bg} flex items-center justify-center mb-2 group-hover:scale-105 transition-transform`}>
                    <s.icon className={s.color} size={20} />
                  </div>
                  <h3 className="text-sm font-medium text-white mb-1">{strategyName(s.id)}</h3>
                  <p className="text-xs text-slate-400 leading-snug">{strategyDesc(s.id)}</p>
                </div>
              ))}
            </div>
          </motion.div>
        ) : (
          /* ── 策略詳細分頁 ── */
          <motion.div key="detail" initial={{opacity:0,x:20}} animate={{opacity:1,x:0}} exit={{opacity:0,x:20}} transition={{duration:0.2}} className="flex flex-col gap-5">

            {/* Header */}
            <div className="flex items-center gap-4 border-b border-slate-800 pb-5">
              <button onClick={() => { setSelectedStrategy(null); resetStock(); }}
                className="w-10 h-10 rounded-full bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center transition-colors">
                <ChevronLeft size={20} />
              </button>
              <div className={`w-12 h-12 rounded-lg ${activeStrategy?.bg} flex items-center justify-center`}>
                {activeStrategy && <activeStrategy.icon className={activeStrategy.color} size={24} />}
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-xl font-bold text-white tracking-tight">{activeStrategy?.name}</h2>
                {activeSid && (
                  <p className="text-slate-400 text-sm mt-0.5">
                    {activeSid} {stockName && `· ${stockName}`}
                  </p>
                )}
              </div>
              {/* 策略切換 Tab（小型） */}
              <div className="hidden md:flex gap-1">
                {strategies.map(s => (
                  <button key={s.id} onClick={() => { setSelectedStrategy(s.id); setSrData(null); setMaDataResult(null); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      s.id === selectedStrategy ? `${s.bg} ${s.color}` : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800'
                    }`}>
                    {s.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 搜尋框 */}
            <div className="relative">
              <div className="flex items-center gap-3 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 focus-within:border-blue-500/50 transition-colors">
                <Search size={18} className="text-slate-500 shrink-0" />
                <input
                  type="text"
                  placeholder="輸入 4 碼股號，或輸入 1 進行全市場掃描"
                  value={stockId}
                  onChange={e => handleSearch(e.target.value)}
                  onKeyDown={e => {
                    if (e.key !== 'Enter') return;
                    const q = stockId.trim();
                    if (q === '1') { setShowScanOptions(true); setSearchResults([]); }
                    else if (q.length >= 4) handleSearch(q);
                  }}
                  className="flex-1 bg-transparent text-white placeholder-slate-500 outline-none text-sm"
                />
                {stockName && <span className="text-xs text-slate-400 bg-slate-800 px-2 py-1 rounded shrink-0">{stockName}</span>}
                <button
                  onClick={() => {
                    const q = stockId.trim();
                    if (q === '1') { setShowScanOptions(true); setSearchResults([]); }
                    else if (q.length >= 2) handleSearch(q);
                  }}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded-lg text-xs transition-colors shrink-0"
                >
                  查詢
                </button>
              </div>
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-slate-900 border border-slate-800 rounded-xl overflow-hidden z-50 shadow-xl">
                  {searchResults.map(stock => (
                    <div key={stock.stock_id} onClick={() => selectStock(stock)}
                      className="flex items-center justify-between px-4 py-3 hover:bg-slate-800/60 cursor-pointer transition-colors border-b border-slate-800/50 last:border-0">
                      <div className="flex items-center gap-3">
                        <span className="font-mono font-bold text-white">{stock.stock_id}</span>
                        <span className="text-slate-300">{stock.stock_name}</span>
                      </div>
                      <span className="text-xs text-slate-500">{stock.market === 'OTC' ? '櫃買' : '上市'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!showScanOptions && !scanResults && !activeSid && (
              <div className="text-xs text-slate-500 px-1">
                💡 輸入 4 碼股號查詢個股，或輸入 <kbd className="bg-slate-800 px-1.5 py-0.5 rounded text-blue-400">1</kbd> 全市場掃描
              </div>
            )}

            {renderScanSettings()}

            {/* 掃描結果 */}
            {scanResults && !selectedStockForScan && (
              <div className="bg-slate-950/50 border border-slate-800 rounded-xl p-4 overflow-x-auto">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <ArrowUpDown size={14} className="text-blue-400" />
                    掃描結果 ({scanResults.length} 筆)
                  </h3>
                  <div className="flex gap-2">
                    {['1','2'].map(v => (
                      <button key={v} onClick={() => { setScanSort(v); executeScan(); }}
                        className={`text-xs px-2 py-1 rounded transition-colors ${scanSort===v ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-400'}`}>
                        {v==='1' ? '策略優先' : '成交金額'}
                      </button>
                    ))}
                  </div>
                </div>
                {renderScanTable()}
              </div>
            )}

            {/* ── 股票詳細分析區 ── */}
            {activeSid && (
              <div className="flex flex-col gap-5">
                {/* K 線數據來源提示與同步控制 */}
                <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row items-center justify-between gap-4 shadow-md shadow-black/20">
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg shrink-0 ${hasDataIssue ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                      {hasDataIssue ? <AlertCircle size={20} /> : <Database size={20} />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-white">
                          數據狀態：{hasDataIssue ? '實體資料缺失、過期或不足' : '實體數據（來自資料庫 / FinMind 已同步）'}
                        </h4>
                        <span className={`px-2 py-0.5 text-[10px] rounded-full font-medium ${hasDataIssue ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'}`}>
                          {hasDataIssue ? 'Incomplete' : 'Synced'}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">
                        {hasDataIssue 
                          ? '系統不會生成替代行情；請同步 FinMind 後再進行分析。' 
                          : '已成功從 FinMind 回補並安全儲存於系統實體資料庫。您可以隨時點擊右側按鈕重新整理同步。'}
                      </p>
                    </div>
                  </div>
                  
                  <div className="shrink-0 w-full md:w-auto">
                    <button
                      onClick={handleSyncFinMind}
                      disabled={syncing}
                      className={`w-full md:w-auto flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                        syncing
                          ? 'bg-slate-800 text-slate-500 border border-slate-700 cursor-not-allowed'
                          : hasDataIssue
                            ? 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-600/15 hover:scale-[1.01]'
                            : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 hover:scale-[1.01]'
                      }`}
                    >
                      <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                      {syncing ? '正在同步數據...' : hasDataIssue ? '一鍵同步 FinMind 數據' : '重新同步數據'}
                    </button>
                  </div>
                </div>

                {/* 同步日誌視窗（當同步進行時顯示） */}
                {syncing && (
                  <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3 shadow-lg">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <span className="text-xs font-bold text-slate-300 flex items-center gap-2">
                        <RefreshCw size={12} className="animate-spin text-blue-400" />
                        FinMind 資料庫同步終端機
                      </span>
                      <span className="text-[10px] font-mono text-slate-500">System Database Connector v1.2</span>
                    </div>
                    <div ref={logContainerRef} className="bg-black/85 font-mono text-xs text-green-400 p-4 rounded-lg border border-slate-950 max-h-[220px] overflow-y-auto flex flex-col gap-1 shadow-inner scrollbar-thin scrollbar-thumb-slate-800">
                      {syncLogs.map((log, idx) => (
                        <div key={idx} className={log.startsWith('❌') ? 'text-red-400' : log.startsWith('🟢') ? 'text-cyan-400' : log.startsWith('⚠️') ? 'text-amber-400' : 'text-green-400/80'}>
                          {log}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* K 線圖（帶策略覆蓋） */}
                <div>
                  {loadingChart ? (
                    <div className="bg-slate-900 border border-slate-800 rounded-xl flex items-center justify-center h-[420px]">
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                        <span className="text-slate-400 text-xs">載入 K 線資料...</span>
                      </div>
                    </div>
                  ) : priceData.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      <KlineChart data={priceData} overlay={overlay} />
                      {!hasDataIssue && (
                        <div className="flex items-center justify-end px-1 gap-1.5 text-[10px] text-slate-500 mt-1">
                          <CheckCircle2 size={12} className="text-emerald-500" />
                          已載入實體資料庫歷史數據，共計 {priceData.length} 根日 K 棒。支援均線扣抵與指標自適應計算。
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 flex flex-col items-center justify-center gap-4 text-center">
                      <div className="p-4 rounded-full bg-slate-950 text-slate-500 border border-slate-800">
                        <AlertCircle size={32} />
                      </div>
                      <div>
                        <h4 className="text-sm font-bold text-white mb-1">無歷史價格資料</h4>
                        <p className="text-xs text-slate-400 max-w-sm">
                          此股票目前在本地無任何歷史或模擬交易資料，請立即點擊下方按鈕或上方「一鍵同步 FinMind」以下載最新價格數據。
                        </p>
                      </div>
                      <button
                        onClick={handleSyncFinMind}
                        disabled={syncing}
                        className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all hover:scale-[1.01]"
                      >
                        <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                        {syncing ? '正在下載中...' : '立即同步並回補歷史數據'}
                      </button>
                    </div>
                  )}
                </div>

                {/* ── 整合資訊分頁 Tab 切換 ── */}
                <div className="flex border-b border-slate-800 gap-1 bg-slate-950/40 p-1.5 rounded-xl">
                  {[
                    { id: 'strategy', label: '策略分析面板', icon: Sparkles, count: null },
                    { id: 'institutional', label: '法人買賣超', icon: Users, count: instData.length },
                    { id: 'shareholding', label: '千戶大戶比例', icon: ShieldCheck, count: shareholding.length }
                  ].map((t) => {
                    const Icon = t.icon;
                    const isActive = infoTab === t.id;
                    return (
                      <button
                        key={t.id}
                        onClick={() => setInfoTab(t.id as any)}
                        className={`flex items-center gap-1.5 px-4 py-2 text-xs font-bold rounded-lg transition-all ${
                          isActive
                            ? 'bg-blue-600/15 text-blue-400 border border-blue-500/35 shadow-sm'
                            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
                        }`}
                      >
                        <Icon size={14} className={isActive ? 'text-blue-400 animate-pulse' : 'text-slate-500'} />
                        <span>{t.label}</span>
                        {t.count !== null && t.count > 0 && (
                          <span className={`px-1.5 py-0.5 text-[10px] rounded-full font-mono ${isActive ? 'bg-blue-500/20 text-blue-300' : 'bg-slate-800 text-slate-500'}`}>
                            {t.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Tab 內容 */}
                <div className="transition-all duration-200">
                  {infoTab === 'strategy' && renderPanel()}
                  {infoTab === 'institutional' && (
                    <ChipsBarChart
                      chipHistory={instData.map(r => ({ date: r.date, foreign: r.foreign_net, trust: r.trust_net }))}
                      shareholding={[]}
                      viewMode="institutional"
                    />
                  )}
                  {infoTab === 'shareholding' && (
                    <ChipsBarChart
                      chipHistory={[]}
                      shareholding={shareholding}
                      viewMode="shareholding"
                    />
                  )}
                </div>

                {/* 策略行動切換（手機版，header 的切換 tab 只在 md+ 顯示） */}
                <div className="flex md:hidden gap-1 flex-wrap">
                  {strategies.map(s => (
                    <button key={s.id} onClick={() => { setSelectedStrategy(s.id); setSrData(null); setMaDataResult(null); }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                        s.id === selectedStrategy ? `${s.bg} ${s.color}` : 'text-slate-500 bg-slate-800'
                      }`}>
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
