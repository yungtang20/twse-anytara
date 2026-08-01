import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpDown } from 'lucide-react';
import {
  fetchChipsScan,
  fetchMAScan,
  fetchPatternScan,
  fetchSRScan,
  type ChipsScanItem,
  type MAScanItem,
  type PatternScanItem,
  type SRScanItem,
} from '../../lib/api';

export type StrategyId = 'support-resistance' | 'ma-trend' | 'chips-flow' | 'pattern-shape';
type ScanItem = SRScanItem | MAScanItem | ChipsScanItem | PatternScanItem;

interface StrategyScannerProps {
  strategyId: StrategyId;
  onSelectStock: (stock: { stock_id: string; stock_name: string }) => void;
}

const thClass = 'whitespace-nowrap px-2 py-1.5 text-left text-[10px] font-semibold text-slate-500';
const cellClass = 'whitespace-nowrap px-2 py-1.5';

function ScanTable({ strategyId, items, onSelectStock }: StrategyScannerProps & { items: ScanItem[] }) {
  if (strategyId === 'support-resistance') {
    return <SRTable items={items as SRScanItem[]} onSelectStock={onSelectStock} />;
  }
  if (strategyId === 'ma-trend') {
    return <MATable items={items as MAScanItem[]} onSelectStock={onSelectStock} />;
  }
  if (strategyId === 'chips-flow') {
    return <ChipsTable items={items as ChipsScanItem[]} onSelectStock={onSelectStock} />;
  }
  return <PatternTable items={items as PatternScanItem[]} onSelectStock={onSelectStock} />;
}

function Row({ item, onSelectStock, children }: {
  item: { stock_id: string; stock_name: string };
  onSelectStock: StrategyScannerProps['onSelectStock'];
  children: ReactNode;
}) {
  return (
    <tr
      onClick={() => onSelectStock(item)}
      className="cursor-pointer border-b border-slate-800/50 transition-colors hover:bg-blue-500/5"
    >{children}</tr>
  );
}

type SortValue = string | number | null | undefined;
interface SortableColumn<T> {
  key: string;
  label: string;
  value: (item: T) => SortValue;
  render: (item: T) => ReactNode;
}

function compareSortValues(left: SortValue, right: SortValue): number {
  if (typeof left === 'string') return left.localeCompare(String(right ?? ''), 'zh-Hant', { numeric: true });
  return Number(left ?? 0) - Number(right ?? 0);
}

function SortableTable<T extends { stock_id: string; stock_name: string }>({
  items, columns, defaultSortKey, defaultAscending = true, onSelectStock,
}: {
  items: T[];
  columns: Array<SortableColumn<T>>;
  defaultSortKey: string;
  defaultAscending?: boolean;
  onSelectStock: StrategyScannerProps['onSelectStock'];
}) {
  const [sortKey, setSortKey] = useState(defaultSortKey);
  const [ascending, setAscending] = useState(defaultAscending);
  const selectedColumn = columns.find((column) => column.key === sortKey) || columns[0];
  const sortedItems = [...items].sort((left, right) => {
    const comparison = compareSortValues(selectedColumn.value(left), selectedColumn.value(right));
    return ascending ? comparison : -comparison;
  });
  const changeSort = (key: string) => {
    if (key === sortKey) setAscending((current) => !current);
    else { setSortKey(key); setAscending(true); }
  };

  return <div className="max-w-full overflow-x-auto rounded-lg border border-slate-800">
    <table className="w-auto min-w-[660px] text-xs font-mono">
      <thead><tr className="border-b border-slate-800 bg-slate-950/70">
        {columns.map((column) => <th key={column.key} className={thClass}>
          <button type="button" onClick={() => changeSort(column.key)} className="flex items-center gap-1 hover:text-cyan-300">
            {column.label}<span className="w-2 text-cyan-400">{sortKey === column.key ? ascending ? '↑' : '↓' : ''}</span>
          </button>
        </th>)}
      </tr></thead>
      <tbody>{sortedItems.map((item) => <Row key={item.stock_id} item={item} onSelectStock={onSelectStock}>
        {columns.map((column) => <td key={column.key}>{column.render(item)}</td>)}
      </Row>)}</tbody>
    </table>
  </div>;
}

function SRTable({ items, onSelectStock }: { items: SRScanItem[]; onSelectStock: StrategyScannerProps['onSelectStock'] }) {
  const columns: Array<SortableColumn<SRScanItem>> = [
    { key: 'score', label: '強', value: (item) => item.score, render: (item) => <div className={`${cellClass} text-cyan-400`}>{item.score}</div> },
    { key: 'stock_id', label: '代號', value: (item) => item.stock_id, render: (item) => <div className={`${cellClass} text-fuchsia-400`}>{item.stock_id}</div> },
    { key: 'stock_name', label: '名稱', value: (item) => item.stock_name, render: (item) => <div className={`${cellClass} text-white`}>{item.stock_name}</div> },
    { key: 'close', label: '收盤', value: (item) => item.close, render: (item) => <div className={`${cellClass} text-right text-yellow-400`}>{item.close.toFixed(2)}</div> },
    { key: 'volume', label: '量(張)', value: (item) => item.volume, render: (item) => <div className={`${cellClass} text-right text-green-400`}>{item.volume.toLocaleString()}</div> },
    { key: 'amount', label: '額(億)', value: (item) => item.amount, render: (item) => <div className={`${cellClass} text-right text-yellow-300`}>{item.amount.toFixed(2)}</div> },
    { key: 'tags', label: '動態', value: (item) => item.tags, render: (item) => <div className={`${cellClass} max-w-[220px] truncate text-blue-300`}>{item.tags}</div> },
    { key: 'dist', label: '距支撐', value: (item) => item.dist, render: (item) => <div className={`${cellClass} text-right text-red-400`}>{item.dist > 0 ? '+' : ''}{item.dist.toFixed(2)}%</div> },
  ];
  return <SortableTable items={items} columns={columns} defaultSortKey="dist" onSelectStock={onSelectStock} />;
}

function MATable({ items, onSelectStock }: { items: MAScanItem[]; onSelectStock: StrategyScannerProps['onSelectStock'] }) {
  const columns: Array<SortableColumn<MAScanItem>> = [
    { key: 'stock_id', label: '代號', value: (item) => item.stock_id, render: (item) => <div className={`${cellClass} text-fuchsia-400`}>{item.stock_id}</div> },
    { key: 'stock_name', label: '名稱', value: (item) => item.stock_name, render: (item) => <div className={`${cellClass} text-white`}>{item.stock_name}</div> },
    { key: 'close', label: '收盤', value: (item) => item.close, render: (item) => <div className={`${cellClass} text-right text-yellow-400`}>{item.close.toFixed(2)}</div> },
    { key: 'volume', label: '量(張／日增)', value: (item) => item.volume, render: (item) => <div className={`${cellClass} text-right text-green-400`}>{item.volume.toLocaleString()} <span className="text-[10px] text-slate-500">({item.volumeRatio >= 0 ? '+' : ''}{item.volumeRatio.toFixed(1)}%)</span></div> },
    { key: 'amount', label: '額(億)', value: (item) => item.amount, render: (item) => <div className={`${cellClass} text-right text-yellow-300`}>{item.amount.toFixed(2)}</div> },
    { key: 'targetMA', label: items[0]?.targetLabel || '目標MA', value: (item) => item.targetMA, render: (item) => <div className={`${cellClass} text-right text-white`}>{item.targetMA.toFixed(2)}</div> },
    { key: 'bias', label: '乖離率', value: (item) => item.bias, render: (item) => <div className={`${cellClass} text-right ${item.bias >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>{item.bias > 0 ? '+' : ''}{item.bias.toFixed(2)}%</div> },
    { key: 'retraces', label: '曾回踩', value: (item) => item.retraces, render: (item) => <div className={`${cellClass} text-right text-cyan-400`}>{item.retraces}次</div> },
  ];
  return <SortableTable items={items} columns={columns} defaultSortKey="bias" onSelectStock={onSelectStock} />;
}

function ChipsTable({ items, onSelectStock }: { items: ChipsScanItem[]; onSelectStock: StrategyScannerProps['onSelectStock'] }) {
  if (items[0]?.type === '集保大戶') {
    const columns: Array<SortableColumn<ChipsScanItem>> = [
      { key: 'stock_id', label: '代號', value: (item) => item.stock_id, render: (item) => <div className={`${cellClass} text-fuchsia-400`}>{item.stock_id}</div> },
      { key: 'stock_name', label: '名稱', value: (item) => item.stock_name, render: (item) => <div className={`${cellClass} text-white`}>{item.stock_name}</div> },
      { key: 'close', label: '收盤', value: (item) => item.close, render: (item) => <div className={`${cellClass} text-left text-yellow-400`}>{item.close.toFixed(2)}</div> },
      { key: 'volume', label: '量(張)', value: (item) => item.volume, render: (item) => <div className={`${cellClass} text-left text-green-400`}>{item.volume.toLocaleString()}</div> },
      { key: 'amount', label: '額(億)', value: (item) => item.amount, render: (item) => <div className={`${cellClass} text-left text-yellow-300`}>{item.amount.toFixed(2)}</div> },
      { key: 'whaleRatio', label: '大戶比率', value: (item) => item.whaleRatio, render: (item) => <div className={`${cellClass} text-left text-purple-400`}>{item.whaleRatio?.toFixed(2)}%</div> },
      { key: 'whaleChange', label: '比率增減', value: (item) => item.whaleChange, render: (item) => <div className={`${cellClass} text-left text-red-400`}>+{item.whaleChange?.toFixed(2)}%</div> },
      { key: 'totalPeople', label: '股東人數', value: (item) => item.totalPeople, render: (item) => <div className={`${cellClass} text-left text-white`}>{item.totalPeople?.toLocaleString()}</div> },
      { key: 'peopleChange', label: '人數增減', value: (item) => item.peopleChange, render: (item) => <div className={`${cellClass} text-left text-emerald-400`}>{item.peopleChange?.toLocaleString()}</div> },
    ];
    return <SortableTable items={items} columns={columns} defaultSortKey="whaleChange" defaultAscending={false} onSelectStock={onSelectStock} />;
  }
  return <InstitutionalChipsTable items={items} onSelectStock={onSelectStock} />;
}

function InstitutionalChipsTable({ items, onSelectStock }: {
  items: ChipsScanItem[];
  onSelectStock: StrategyScannerProps['onSelectStock'];
}) {
  const columns: Array<SortableColumn<ChipsScanItem>> = [
    { key: 'stock_id', label: '代號', value: (item) => item.stock_id, render: (item) => <div className={`${cellClass} text-fuchsia-400`}>{item.stock_id}</div> },
    { key: 'stock_name', label: '名稱', value: (item) => item.stock_name, render: (item) => <div className={`${cellClass} text-white`}>{item.stock_name}</div> },
    { key: 'close', label: '收盤', value: (item) => item.close, render: (item) => <div className={`${cellClass} text-left text-yellow-400`}>{item.close.toFixed(2)}</div> },
    { key: 'volume', label: '量(張)', value: (item) => item.volume, render: (item) => <div className={`${cellClass} text-left text-green-400`}>{item.volume.toLocaleString()}</div> },
    { key: 'amount', label: '額(億)', value: (item) => item.amount, render: (item) => <div className={`${cellClass} text-left text-yellow-300`}>{item.amount.toFixed(2)}</div> },
    { key: 'consecutive', label: '連買天數', value: (item) => item.consecutive, render: (item) => <div className={`${cellClass} text-left text-cyan-400`}>{item.consecutive}</div> },
    { key: 'netTotal', label: '累計買超(張)', value: (item) => item.netTotal, render: (item) => <div className={`${cellClass} text-left text-green-300`}>{item.netTotal.toLocaleString()}</div> },
  ];
  return <SortableTable items={items} columns={columns} defaultSortKey="consecutive" onSelectStock={onSelectStock} />;
}

function PatternTable({ items, onSelectStock }: { items: PatternScanItem[]; onSelectStock: StrategyScannerProps['onSelectStock'] }) {
  const columns: Array<SortableColumn<PatternScanItem>> = [
    { key: 'stock_id', label: '代號', value: (item) => item.stock_id, render: (item) => <div className={`${cellClass} text-fuchsia-400`}>{item.stock_id}</div> },
    { key: 'stock_name', label: '名稱', value: (item) => item.stock_name, render: (item) => <div className={`${cellClass} text-white`}>{item.stock_name}</div> },
    { key: 'close', label: '收盤', value: (item) => item.close, render: (item) => <div className={`${cellClass} text-right text-yellow-400`}>{item.close.toFixed(2)}</div> },
    { key: 'volume', label: '量(張)', value: (item) => item.volume, render: (item) => <div className={`${cellClass} text-right text-green-400`}>{item.volume.toLocaleString()}</div> },
    { key: 'amount', label: '額(億)', value: (item) => item.amount, render: (item) => <div className={`${cellClass} text-right text-yellow-300`}>{item.amount.toFixed(2)}</div> },
    { key: 'patternName', label: '型態', value: (item) => `${item.patternName}-${item.stage}`, render: (item) => <div className={`${cellClass} text-rose-400`}>{item.patternName} · {item.stage === 'confirmed' ? '已確認' : '形成中'}</div> },
    { key: 'confidence', label: '信心度', value: (item) => item.confidence, render: (item) => <div className={`${cellClass} text-right text-cyan-400`}>{(item.confidence * 100).toFixed(0)}%</div> },
  ];
  return <SortableTable items={items} columns={columns} defaultSortKey="confidence" defaultAscending={false} onSelectStock={onSelectStock} />;
}

export function StrategyScanner({ strategyId, onSelectStock }: StrategyScannerProps) {
  const [minVolume, setMinVolume] = useState('500');
  const [sort, setSort] = useState('1');
  const [maType, setMaType] = useState('1');
  const [chipsType, setChipsType] = useState('1');
  const [chipsDays, setChipsDays] = useState('2');
  const [items, setItems] = useState<ScanItem[]>([]);
  const [hasScanned, setHasScanned] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems([]);
    setHasScanned(false);
    setError(null);
  }, [strategyId]);

  const execute = async (requestedSort = sort) => {
    setLoading(true); setError(null);
    try {
      const volume = Number.parseInt(minVolume, 10) || 500;
      const result = strategyId === 'support-resistance' ? await fetchSRScan(volume, requestedSort)
        : strategyId === 'ma-trend' ? await fetchMAScan(volume, maType, requestedSort)
          : strategyId === 'chips-flow' ? await fetchChipsScan(chipsType, requestedSort, Number.parseInt(chipsDays, 10) || 2)
            : await fetchPatternScan(volume, requestedSort);
      setItems(result); setHasScanned(true);
    } catch (reason) {
      setItems([]); setHasScanned(true);
      setError(reason instanceof Error ? reason.message : '掃描失敗');
    } finally { setLoading(false); }
  };

  const changeSort = (nextSort: string) => {
    setSort(nextSort);
    if (hasScanned) void execute(nextSort);
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-800 bg-slate-900 p-3">
        <h3 className="mb-2 text-sm font-bold text-white">全市場掃描條件</h3>
        <div className="flex flex-wrap items-end gap-2.5">
          {strategyId !== 'chips-flow' && <label className="text-xs text-slate-400">最小成交量（張）
            <input type="number" value={minVolume} onChange={(event) => setMinVolume(event.target.value)} className="mt-1 block w-28 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white" />
          </label>}
          {strategyId === 'ma-trend' && <label className="text-xs text-slate-400">掃描類型
            <select value={maType} onChange={(event) => setMaType(event.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white">
              <option value="1">突破年線（200MA）</option><option value="2">突破季線（60MA）</option><option value="3">2560 戰法</option>
              <option value="4">回落年線（200MA）</option><option value="5">回落季線（60MA）</option><option value="6">回落月線（MA25）</option>
            </select>
          </label>}
          {strategyId === 'chips-flow' && <label className="text-xs text-slate-400">掃描類型
            <select value={chipsType} onChange={(event) => setChipsType(event.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white">
              <option value="1">投信動向</option><option value="2">外資動向</option><option value="3">集保大戶</option>
            </select>
          </label>}
          {strategyId === 'chips-flow' && chipsType !== '3' && <label className="text-xs text-slate-400">最少連買天數
            <input type="number" min="1" max="30" value={chipsDays} onChange={(event) => setChipsDays(event.target.value)} className="mt-1 block w-24 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white" />
          </label>}
          <label className="text-xs text-slate-400">排序方式
            <select value={sort} onChange={(event) => changeSort(event.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-white">
              {strategyId === 'chips-flow' ? chipsType === '3'
                ? <><option value="1">大戶比率增幅大→小</option><option value="2">股東人數降幅大→小</option></>
                : <><option value="1">連買天數少→多</option><option value="2">連買天數多→少</option></>
                : <><option value="1">距目標均線近→遠</option><option value="2">成交量增幅大→小</option></>}
            </select>
          </label>
          <button onClick={() => void execute()} disabled={loading} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:bg-slate-700">
            {loading ? '掃描中…' : '開始掃描'}
          </button>
        </div>
      </section>

      {error && <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      {hasScanned && <section className="rounded-xl border border-slate-800 bg-slate-950/50 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
          <h3 className="flex items-center gap-2 text-sm font-bold text-white"><ArrowUpDown size={14} className="text-blue-400" />掃描結果（{items.length} 筆）</h3>
          <span className="text-xs text-slate-500">點選股票查看詳細分析，返回後結果仍會保留</span>
        </div>
        {loading ? <div className="py-8 text-center text-sm text-slate-400">重新排序中…</div>
          : items.length ? <ScanTable strategyId={strategyId} items={items} onSelectStock={onSelectStock} />
            : <div className="py-8 text-center text-sm text-slate-500">沒有符合條件的股票</div>}
      </section>}
    </div>
  );
}
