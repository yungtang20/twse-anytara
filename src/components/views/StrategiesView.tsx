import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ChevronLeft,
  Database,
  Search,
  ShieldCheck,
  TrendingUp,
  Users,
} from 'lucide-react';
import { motion } from 'motion/react';
import { KlineChart, type KlineOverlay } from '../KlineChart';
import { StrategyScanner, type StrategyId } from '../strategies/StrategyScanner';
import {
  fetchMAAnalysis,
  fetchSRAnalysis,
  fetchStockHistory,
  fetchStockInstitutional,
  fetchStockSearch,
  fetchStockShareholding,
  type InstitutionalRow,
  type MAAnalysis,
  type PriceData,
  type ShareholdingRow,
  type SRAnalysis,
  type StockMeta,
} from '../../lib/api';
import { ChipsDetailPanel } from './ChipsPanel';
import { MAPanel } from './MAPanel';
import { PatternPanel } from './PatternPanel';
import { SRPanel } from './SRPanel';

const strategies: Array<{
  id: StrategyId;
  name: string;
  description: string;
  icon: typeof TrendingUp;
  color: string;
  background: string;
}> = [
  { id: 'support-resistance', name: '撐壓分析', description: '25 根高低價與 60 根收盤波峰／波谷趨勢線。', icon: TrendingUp, color: 'text-amber-400', background: 'bg-amber-400/10' },
  { id: 'ma-trend', name: '均線趨勢', description: '檢查 MA25／MA60／MA200 趨勢、扣抵與多空位置。', icon: Activity, color: 'text-blue-400', background: 'bg-blue-400/10' },
  { id: 'chips-flow', name: '籌碼動能', description: '追蹤外資、投信與集保大戶分佈。', icon: Users, color: 'text-purple-400', background: 'bg-purple-400/10' },
  { id: 'pattern-shape', name: '型態偵測', description: '偵測 W 底、M 頂、頸線與目標價。', icon: ShieldCheck, color: 'text-rose-400', background: 'bg-rose-400/10' },
];

type PageMode = 'stock' | 'scan';

function strategyOverlay(strategyId: StrategyId): KlineOverlay {
  if (strategyId === 'support-resistance') return { indicators: { supportResistance: true } };
  if (strategyId === 'ma-trend') return { indicators: { movingAverages: true } };
  if (strategyId === 'chips-flow') return { indicators: { foreign: true, trust: true } };
  return { indicators: {} };
}

function StrategyTabs({ selected, onSelect }: { selected: StrategyId; onSelect: (id: StrategyId) => void }) {
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/50 p-1">
      {strategies.map((strategy) => (
        <button
          key={strategy.id}
          onClick={() => onSelect(strategy.id)}
          className={`shrink-0 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
            selected === strategy.id ? `${strategy.background} ${strategy.color}` : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'
          }`}
        >{strategy.name}</button>
      ))}
    </div>
  );
}

function ModeSwitch({ mode, onChange }: { mode: PageMode; onChange: (mode: PageMode) => void }) {
  return (
    <div className="inline-flex rounded-xl border border-slate-800 bg-slate-950 p-1">
      {([['stock', '個股分析'], ['scan', '全市場掃描']] as const).map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)} className={`rounded-lg px-4 py-2 text-sm font-medium ${mode === id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function StrategiesView() {
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyId | null>(null);
  const [mode, setMode] = useState<PageMode>('stock');
  const [query, setQuery] = useState('');
  const [selectedStock, setSelectedStock] = useState<StockMeta | null>(null);
  const [selectedFromScan, setSelectedFromScan] = useState(false);
  const [searchResults, setSearchResults] = useState<StockMeta[]>([]);
  const [searching, setSearching] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [priceData, setPriceData] = useState<PriceData[]>([]);
  const [institutional, setInstitutional] = useState<InstitutionalRow[]>([]);
  const [shareholding, setShareholding] = useState<ShareholdingRow[]>([]);
  const [loadingStock, setLoadingStock] = useState(false);
  const [hasDataIssue, setHasDataIssue] = useState(false);
  const [srData, setSrData] = useState<SRAnalysis | null>(null);
  const [maData, setMaData] = useState<MAAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  const activeStrategy = strategies.find((strategy) => strategy.id === selectedStrategy);
  const activeStockId = selectedStock?.stock_id ?? '';
  const overlay = useMemo(
    () => selectedStrategy ? strategyOverlay(selectedStrategy) : undefined,
    [selectedStrategy],
  );

  useEffect(() => {
    setSrData(null);
    setMaData(null);
  }, [selectedStrategy]);

  useEffect(() => {
    if (!activeStockId) return;
    let current = true;
    setLoadingStock(true); setPageError(null);
    Promise.all([
      fetchStockHistory(activeStockId, 1000),
      fetchStockInstitutional(activeStockId),
      fetchStockShareholding(activeStockId),
    ]).then(([prices, institutions, holders]) => {
      if (!current) return;
      setPriceData(prices.data);
      setInstitutional(institutions.data);
      setShareholding(holders.data);
      setHasDataIssue(prices.data.length === 0 || prices.quality.isMock || prices.quality.isStale || prices.quality.warnings.length > 0);
    }).catch((reason) => {
      if (current) setPageError(reason instanceof Error ? reason.message : '個股資料載入失敗');
    }).finally(() => { if (current) setLoadingStock(false); });
    return () => { current = false; };
  }, [activeStockId]);

  useEffect(() => {
    if (!activeStockId || !selectedStrategy || !['support-resistance', 'ma-trend'].includes(selectedStrategy)) return;
    let current = true;
    setAnalysisLoading(true);
    const request = selectedStrategy === 'support-resistance'
      ? fetchSRAnalysis(activeStockId).then((data) => { if (current) setSrData(data); })
      : fetchMAAnalysis(activeStockId).then((data) => { if (current) setMaData(data); });
    request.catch((reason) => {
      if (current) setPageError(reason instanceof Error ? reason.message : '策略分析載入失敗');
    }).finally(() => { if (current) setAnalysisLoading(false); });
    return () => { current = false; };
  }, [activeStockId, selectedStrategy]);

  const updateQuery = async (value: string) => {
    setQuery(value);
    if (value.trim().length < 2) { setSearchResults([]); return; }
    setSearching(true);
    try { setSearchResults(await fetchStockSearch(value.trim())); }
    catch { setSearchResults([]); }
    finally { setSearching(false); }
  };

  const chooseStock = (stock: StockMeta, fromScan = false) => {
    setSelectedStock(stock);
    setSelectedFromScan(fromScan);
    setQuery(stock.stock_id);
    setSearchResults([]);
    setMode('stock');
  };

  const submitQuery = async () => {
    const stockId = query.trim();
    if (!/^\d{4,6}$/.test(stockId)) {
      setPageError('請輸入 4 至 6 碼股票代號');
      return;
    }
    const exact = searchResults.find((stock) => stock.stock_id === stockId)
      ?? (await fetchStockSearch(stockId)).find((stock) => stock.stock_id === stockId);
    if (!exact) { setPageError(`找不到股票 ${stockId}`); return; }
    chooseStock(exact);
  };

  const clearStock = () => {
    setSelectedStock(null); setQuery(''); setSearchResults([]);
    setSelectedFromScan(false);
    setPriceData([]); setInstitutional([]); setShareholding([]);
    setSrData(null); setMaData(null); setPageError(null);
  };

  const selectScannedStock = (stock: { stock_id: string; stock_name: string }) => {
    chooseStock({ stock_id: stock.stock_id, stock_name: stock.stock_name, market: '' }, true);
  };

  if (!selectedStrategy) {
    return <StrategyLanding onSelect={setSelectedStrategy} />;
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col gap-2">
      <header className="flex flex-col gap-2 border-b border-slate-800 pb-2 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <button onClick={() => { setSelectedStrategy(null); clearStock(); }} aria-label="返回策略首頁" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-slate-800 bg-slate-900 text-slate-400 hover:text-white"><ChevronLeft size={20} /></button>
          {activeStrategy && <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${activeStrategy.background}`}><activeStrategy.icon className={activeStrategy.color} size={23} /></div>}
          <div className="min-w-0"><h2 className="text-xl font-bold text-white">{activeStrategy?.name}</h2><p className="truncate text-sm text-slate-400">{selectedStock ? `${selectedStock.stock_id} · ${selectedStock.stock_name}` : activeStrategy?.description}</p></div>
        </div>
        <StrategyTabs selected={selectedStrategy} onSelect={setSelectedStrategy} />
      </header>

      <ModeSwitch mode={mode} onChange={setMode} />
      {pageError && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{pageError}</div>}

      <div className={mode === 'scan' ? '' : 'hidden'}>
        <StrategyScanner key={selectedStrategy} strategyId={selectedStrategy} onSelectStock={selectScannedStock} />
      </div>

      {mode === 'stock' && <div className="space-y-2">
        <StockSearch
          query={query}
          searching={searching}
          results={searchResults}
          onQueryChange={(value) => void updateQuery(value)}
          onSubmit={() => void submitQuery()}
          onChoose={chooseStock}
        />
        {selectedStock ? <StockStrategyDetail
          strategyId={selectedStrategy}
          stock={selectedStock}
          priceData={priceData}
          institutional={institutional}
          shareholding={shareholding}
          loading={loadingStock}
          analysisLoading={analysisLoading}
          hasDataIssue={hasDataIssue}
          srData={srData}
          maData={maData}
          overlay={overlay}
          onReturnToScan={selectedFromScan ? () => setMode('scan') : undefined}
        /> : <div className="rounded-xl border border-dashed border-slate-800 py-12 text-center text-sm text-slate-500">搜尋並選擇股票後，才會載入策略資料。</div>}
      </div>}
    </motion.div>
  );
}

function StrategyLanding({ onSelect }: { onSelect: (id: StrategyId) => void }) {
  return (
    <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="space-y-3">
      <div><h2 className="text-2xl font-bold text-white">四大策略模組</h2><p className="text-sm text-slate-400">選擇策略後，可進行個股分析或全市場掃描。</p></div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
        {strategies.map((strategy) => <button key={strategy.id} onClick={() => onSelect(strategy.id)} className="group rounded-xl border border-slate-800 bg-slate-900 p-4 text-left transition-all hover:border-blue-500/50">
          <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-lg ${strategy.background}`}><strategy.icon className={strategy.color} size={21} /></div>
          <h3 className="mb-1 text-sm font-medium text-white">{strategy.name}</h3><p className="text-xs leading-relaxed text-slate-400">{strategy.description}</p>
        </button>)}
      </div>
    </motion.div>
  );
}

function StockSearch({ query, searching, results, onQueryChange, onSubmit, onChoose }: {
  query: string; searching: boolean; results: StockMeta[];
  onQueryChange: (value: string) => void; onSubmit: () => void; onChoose: (stock: StockMeta) => void;
}) {
  return <div className="relative">
    <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900 px-4 py-3 focus-within:border-blue-500/50">
      <Search size={18} className="shrink-0 text-slate-500" />
      <input value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); }} placeholder="輸入股票代號或名稱" className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-slate-500" />
      <button onClick={onSubmit} className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white hover:bg-blue-500">{searching ? '搜尋中…' : '查詢'}</button>
    </div>
    {results.length > 0 && <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900 shadow-xl">
      {results.map((stock) => <button key={stock.stock_id} onClick={() => onChoose(stock)} className="flex w-full items-center justify-between border-b border-slate-800/50 px-4 py-3 text-left hover:bg-slate-800/60">
        <span><b className="font-mono text-white">{stock.stock_id}</b><span className="ml-3 text-slate-300">{stock.stock_name}</span></span><span className="text-xs text-slate-500">{stock.market === 'OTC' ? '櫃買' : '上市'}</span>
      </button>)}
    </div>}
  </div>;
}

interface StockStrategyDetailProps {
  strategyId: StrategyId; stock: StockMeta; priceData: PriceData[]; institutional: InstitutionalRow[];
  shareholding: ShareholdingRow[]; loading: boolean; analysisLoading: boolean;
  hasDataIssue: boolean; srData: SRAnalysis | null; maData: MAAnalysis | null; overlay?: KlineOverlay;
  onReturnToScan?: () => void;
}

function StockStrategyDetail(props: StockStrategyDetailProps) {
  const latestDate = props.priceData.at(-1)?.date ?? '--';
  const change = props.priceData.length > 1 ? props.priceData.at(-1)!.close - props.priceData.at(-2)!.close : 0;
  const changePercent = props.priceData.length > 1 ? (change / props.priceData.at(-2)!.close) * 100 : 0;
  return <div className="space-y-2">
    <div className="flex flex-col justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3 sm:flex-row sm:items-center">
      <div className="flex items-start gap-3"><div className={`rounded-lg p-2 ${props.hasDataIssue ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>{props.hasDataIssue ? <AlertCircle size={20} /> : <Database size={20} />}</div>
        <div><h3 className="text-sm font-bold text-white">Supabase 資料日期 {latestDate}</h3><p className="mt-1 text-xs text-slate-400">行情 {props.priceData.length} 根、法人 {props.institutional.length} 日、TDCC {props.shareholding.length} 週；資料由 GitHub 排程更新。</p></div>
      </div>
      {props.onReturnToScan && <button onClick={props.onReturnToScan} className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-800">返回掃描結果</button>}
    </div>

    {props.loading ? <div className="flex h-[420px] items-center justify-center rounded-xl border border-slate-800 bg-slate-900 text-sm text-slate-400">載入 K 線資料…</div>
      : props.priceData.length ? <KlineChart data={props.priceData} overlay={props.overlay} institutional={props.institutional} shareholding={props.shareholding} />
        : <div className="rounded-xl border border-slate-800 bg-slate-900 py-12 text-center text-sm text-slate-500">此股票沒有可用的 Supabase 歷史行情。</div>}

    {props.analysisLoading ? <div className="py-5 text-center text-sm text-slate-500">策略分析中…</div> : <StrategyPanel {...props} change={change} changePercent={changePercent} />}
  </div>;
}

function StrategyPanel(props: StockStrategyDetailProps & { change: number; changePercent: number }) {
  if (props.strategyId === 'support-resistance') return <SRPanel data={props.srData} />;
  if (props.strategyId === 'ma-trend') return <MAPanel data={props.maData} change={props.change} changePercent={props.changePercent} />;
  if (props.strategyId === 'chips-flow') return <ChipsDetailPanel stockId={props.stock.stock_id} institutional={props.institutional} shareholding={props.shareholding} />;
  return <PatternPanel stockId={props.stock.stock_id} />;
}
