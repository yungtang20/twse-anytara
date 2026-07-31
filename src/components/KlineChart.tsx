import { useMemo, useState, useCallback } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, EyeOff } from 'lucide-react';
import { PriceData, calcMA } from '../lib/indicators';
import { IntegratedMarketPanels } from './IntegratedMarketPanels';
import type {
  InstitutionalPoint,
  ShareholdingPoint,
} from '../lib/integratedMarketData';
import { buildSupportResistanceLines } from '../lib/trendLines';

export interface KlineOverlay {
  hLines?: { value: number; color: string; label?: string; dash?: boolean }[];
  extraMAs?: { period: number; color: string; label: string }[];
}

interface KlineChartProps {
  data: PriceData[];
  overlay?: KlineOverlay;
  institutional?: InstitutionalPoint[];
  shareholding?: ShareholdingPoint[];
}

interface CandleDatum extends PriceData {
  color: string;
  candleRange: [number, number];
  previousClose: number;
  vwap: number | null;
}

interface CandlestickShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: CandleDatum;
}

function LineLegend({ items }: { items: Array<{ label: string; color: string }> }) {
  return (
    <div className="pointer-events-none absolute right-2 top-1 z-10 flex flex-wrap items-center gap-2 rounded bg-slate-950/80 px-2 py-1 font-mono text-[9px] text-slate-300">
      {items.map((item) => (
        <span key={item.label} className="flex items-center gap-1">
          <span
            className="inline-block h-0.5 w-4"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function CandlestickShape({
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  payload,
}: CandlestickShapeProps) {
  if (!payload || payload.high <= payload.low) return null;
  const priceToY = (price: number) => (
    y + ((payload.high - price) / (payload.high - payload.low)) * height
  );
  const openY = priceToY(payload.open);
  const closeY = priceToY(payload.close);
  const bodyTop = Math.min(openY, closeY);
  const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
  const centerX = x + width / 2;
  return (
    <g>
      <line
        x1={centerX}
        x2={centerX}
        y1={y}
        y2={y + height}
        stroke={payload.color}
        strokeWidth={1}
      />
      <rect
        x={x}
        y={bodyTop - (bodyHeight === 1.5 ? 0.75 : 0)}
        width={Math.max(1, width)}
        height={bodyHeight}
        fill={payload.color}
      />
    </g>
  );
}

function MarketDataStrip({ datum }: { datum?: CandleDatum }) {
  if (!datum) return <div className="h-7 border-b border-slate-800" />;
  const change = datum.close - datum.previousClose;
  const changePct = datum.previousClose > 0 ? (change / datum.previousClose) * 100 : 0;
  const directionClass = change >= 0 ? 'text-red-400' : 'text-emerald-400';
  const sign = change >= 0 ? '+' : '';
  return (
    <div
      aria-live="polite"
      className="h-7 overflow-x-auto border-b border-slate-800 bg-slate-950/70 px-2 font-mono text-[10px] text-slate-400"
    >
      <div className="flex h-full min-w-max items-center gap-2">
        <strong className="text-slate-200">{datum.date}</strong>
        <span>開 <b className="text-slate-100">{datum.open.toFixed(2)}</b></span>
        <span>高 <b className="text-red-400">{datum.high.toFixed(2)}</b></span>
        <span>低 <b className="text-emerald-400">{datum.low.toFixed(2)}</b></span>
        <span>收 <b className="text-slate-100">{datum.close.toFixed(2)}</b></span>
        <span className={directionClass}>
          漲跌 <b>{sign}{change.toFixed(2)}</b>
        </span>
        <span className={directionClass}>
          漲幅 <b>{sign}{changePct.toFixed(2)}%</b>
        </span>
        <span>量 <b className="text-slate-100">{Math.floor(datum.volume / 1000).toLocaleString()} 張</b></span>
        {datum.vwap !== null && (
          <span>VWAP <b className="text-yellow-400">{datum.vwap.toFixed(2)}</b></span>
        )}
      </div>
    </div>
  );
}

// Rolling VWAP (Volume Weighted Average Price) over 20-day period
function calcVWAP(data: PriceData[], period = 20): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    let sumTypicalVolume = 0;
    let sumVolume = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (data[j].high + data[j].low + data[j].close) / 3;
      sumTypicalVolume += tp * data[j].volume;
      sumVolume += data[j].volume;
    }
    return sumVolume === 0 ? null : sumTypicalVolume / sumVolume;
  });
}

export function KlineChart({
  data,
  overlay,
  institutional = [],
  shareholding = [],
}: KlineChartProps) {
  const [windowSize, setWindowSize] = useState<number>(61);
  const [windowOffset, setWindowOffset] = useState(0);

  // Filter or feature toggle states
  const [showMAs, setShowMAs] = useState(true);
  const [showVolMAs, setShowVolMAs] = useState(true);
  const [showVWAP, setShowVWAP] = useState(true);
  const [showSupportResistance, setShowSupportResistance] = useState(true);
  const [showRecentHighLow, setShowRecentHighLow] = useState(true);
  const [showPOC, setShowPOC] = useState(true);
  const [showForeign, setShowForeign] = useState(true);
  const [showTrust, setShowTrust] = useState(false);
  const [showShareholding, setShowShareholding] = useState(true);
  const [hoveredDatum, setHoveredDatum] = useState<CandleDatum | null>(null);

  const aggregatedData = data;

  // Remove the old global isVolumeInShares since data is now normalized
  const totalLen = aggregatedData.length;
  const endIdx = Math.max(0, totalLen - 1 - windowOffset);
  const startIdx = Math.max(0, endIdx - windowSize + 1);

  const windowData = useMemo(() => {
    return aggregatedData.slice(startIdx, endIdx + 1);
  }, [aggregatedData, startIdx, endIdx]);

  const canGoLeft = startIdx > 0;
  const canGoRight = windowOffset > 0;

  const shift = useCallback((dir: 'left' | 'right', customStep?: number) => {
    const step = customStep !== undefined ? customStep : Math.max(1, Math.floor(windowSize / 5));
    setWindowOffset(prev => dir === 'left'
      ? Math.min(prev + step, totalLen - windowSize)
      : Math.max(0, prev - step));
  }, [windowSize, totalLen]);

  // 2. Compute Moving Averages on full aggregated data to avoid edge calculations
  const closes = useMemo(() => aggregatedData.map(d => {
    const v = Number(d.close);
    return isNaN(v) ? 0 : v;
  }), [aggregatedData]);
  
  const volumes = useMemo(() => aggregatedData.map(d => {
    const v = Number(d.volume);
    return isNaN(v) ? 0 : v;
  }), [aggregatedData]);

  const ma25 = useMemo(() => calcMA(closes, 25), [closes]);
  const ma60 = useMemo(() => calcMA(closes, 60), [closes]);
  const ma200 = useMemo(() => calcMA(closes, 200), [closes]);

  const volma5 = useMemo(() => calcMA(volumes, 5), [volumes]);
  const volma60 = useMemo(() => calcMA(volumes, 60), [volumes]);

  const vwapData = useMemo(() => calcVWAP(aggregatedData, 20), [aggregatedData]);

  const supportResistanceLines = useMemo(
    () => buildSupportResistanceLines(aggregatedData, endIdx),
    [aggregatedData, endIdx],
  );

  // 4. Construct the chart dataset
  const allChartData = useMemo(() => {
    return aggregatedData.map((d, i) => {
      const open = Number(d.open || 0);
      const close = Number(d.close || 0);
      const high = Number(d.high || 0);
      const low = Number(d.low || 0);
      const vol = Number(d.volume || 0);

      const isUp = close >= open;
      const color = isUp ? '#ef4444' : '#22c55e';
      const previousClose = i > 0 ? Number(aggregatedData[i - 1].close || close) : close;
      
      const v5 = volma5[i];
      const v60 = volma60[i];
      const cleanV5 = (v5 !== null && v5 !== undefined && !isNaN(v5)) ? v5 : null;
      const cleanV60 = (v60 !== null && v60 !== undefined && !isNaN(v60)) ? v60 : null;
      
      return {
        date: d.date,
        open,
        high,
        low,
        close,
        volume: isNaN(vol) ? 0 : vol,
        color,
        candleRange: [low, high] as [number, number],
        previousClose,
        ma25: ma25[i],
        ma60: ma60[i],
        ma200: ma200[i],
        volma5: cleanV5,
        volma60: cleanV60,
        vwap: vwapData[i],
        shortResistance: supportResistanceLines.shortResistance[i],
        shortSupport: supportResistanceLines.shortSupport[i],
        longResistance: supportResistanceLines.longResistance[i],
        longSupport: supportResistanceLines.longSupport[i],
        isUp,
      };
    });
  }, [
    aggregatedData,
    ma25,
    ma60,
    ma200,
    volma5,
    volma60,
    vwapData,
    supportResistanceLines,
  ]);

  // Slice visible data
  const visibleChartData = useMemo(() => {
    return allChartData.slice(startIdx, endIdx + 1);
  }, [allChartData, startIdx, endIdx]);

  // 5. Calculate Point of Control (POC) on visible data
  const pocPrice = useMemo(() => {
    if (!showPOC || visibleChartData.length === 0) return null;
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    visibleChartData.forEach(d => {
      if (d.low < minPrice) minPrice = d.low;
      if (d.high > maxPrice) maxPrice = d.high;
    });
    if (minPrice === Infinity || maxPrice === -Infinity || minPrice === maxPrice) return null;

    const numBins = 15;
    const binWidth = (maxPrice - minPrice) / numBins;
    const bins = Array(numBins).fill(0);

    visibleChartData.forEach(d => {
      const binIdx = Math.min(numBins - 1, Math.floor((d.close - minPrice) / binWidth));
      if (binIdx >= 0 && binIdx < numBins) {
        bins[binIdx] += d.volume;
      }
    });

    let maxVolIdx = 0;
    let maxVol = -1;
    bins.forEach((vol, idx) => {
      if (vol > maxVol) {
        maxVol = vol;
        maxVolIdx = idx;
      }
    });

    return minPrice + (maxVolIdx + 0.5) * binWidth;
  }, [visibleChartData, showPOC]);

  // 6. Calculate Recent High/Low of the visible window
  const recentHighLow = useMemo(() => {
    if (visibleChartData.length === 0) return { high: 0, low: 0 };
    const highs = visibleChartData.map(d => d.high);
    const lows = visibleChartData.map(d => d.low);
    return {
      high: Math.max(...highs),
      low: Math.min(...lows)
    };
  }, [visibleChartData]);

  const chartData = visibleChartData;
  const priceDomain = useMemo<[number, number]>(() => {
    if (chartData.length === 0) return [0, 1];
    const lowest = Math.min(...chartData.map((row) => row.low));
    const highest = Math.max(...chartData.map((row) => row.high));
    const padding = Math.max((highest - lowest) * 0.08, highest * 0.02);
    return [Math.max(0, lowest - padding), highest + padding];
  }, [chartData]);
  const displayDatum = useMemo(() => {
    if (hoveredDatum && chartData.some((row) => row.date === hoveredDatum.date)) {
      return hoveredDatum;
    }
    return chartData[chartData.length - 1];
  }, [chartData, hoveredDatum]);

  const handleChartMouseMove = useCallback((state: {
    activeTooltipIndex?: unknown;
  }) => {
    const index = Number(state.activeTooltipIndex);
    if (Number.isInteger(index) && chartData[index]) {
      setHoveredDatum(chartData[index]);
    }
  }, [chartData]);

  // Calculate maximum volume of the visible dataset to guarantee 100% correct scaling of Y-Axis in Recharts
  const maxVolume = useMemo(() => {
    if (chartData.length === 0) return 100;
    const volumes = chartData.map(d => Number(d.volume || 0)).filter(v => !isNaN(v));
    const maxVal = volumes.length > 0 ? Math.max(...volumes) : 100;
    return maxVal > 0 ? maxVal : 100;
  }, [chartData]);

  // Bar sizes to align K-Line candle bodies and Volume bars perfectly
  const currentWindowSize = windowSize;
  const calculatedBarSize = useMemo(() => {
    if (currentWindowSize <= 35) return 14;
    if (currentWindowSize <= 65) return 8;
    if (currentWindowSize <= 125) return 4;
    if (currentWindowSize <= 255) return 2;
    return 1.5; // ponytail: min 1.5px to make sure bars don't disappear or overlap weirdly on low-dpi displays
  }, [currentWindowSize]);

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-lg shadow-black/40 flex flex-col">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 bg-slate-950/40 p-2 text-[10px]">
        {[
          { label: '均線', state: showMAs, set: setShowMAs, color: 'text-orange-400' },
          { label: '量能均線', state: showVolMAs, set: setShowVolMAs, color: 'text-cyan-400' },
          { label: 'VWAP', state: showVWAP, set: setShowVWAP, color: 'text-yellow-400' },
          { label: '最密成交價', state: showPOC, set: setShowPOC, color: 'text-rose-400' },
          { label: '長短期撐壓', state: showSupportResistance, set: setShowSupportResistance, color: 'text-emerald-400' },
          { label: '波段高低', state: showRecentHighLow, set: setShowRecentHighLow, color: 'text-sky-400' },
          { label: '千戶大戶', state: showShareholding, set: setShowShareholding, color: 'text-cyan-300' },
        ].map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => item.set(!item.state)}
            className={`flex items-center gap-1 rounded border px-2 py-1 transition-all ${
              item.state
                ? 'border-slate-700 bg-slate-800/80 text-slate-200'
                : 'border-slate-900 bg-transparent text-slate-600'
            }`}
          >
            {item.state
              ? <Eye size={10} className={item.color} />
              : <EyeOff size={10} />}
            {item.label}
          </button>
        ))}

        <div className="flex items-center gap-0.5 rounded border border-slate-700 bg-slate-950 p-0.5">
          <span className="px-1 text-slate-600">法人</span>
          {([
            { label: '外資', state: showForeign, set: setShowForeign, color: 'text-blue-400' },
            { label: '投信', state: showTrust, set: setShowTrust, color: 'text-amber-400' },
          ] as const).map((item) => {
            return (
              <button
                key={item.label}
                type="button"
                aria-pressed={item.state}
                onClick={() => item.set(!item.state)}
                className={`flex items-center gap-1 rounded px-2 py-1 transition-all ${
                  item.state
                    ? 'bg-slate-800 text-slate-100 shadow-sm'
                    : 'text-slate-600 hover:text-slate-300'
                }`}
              >
                {item.state
                  ? <Eye size={10} className={item.color} />
                  : <EyeOff size={10} className="text-slate-600" />}
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1 rounded border border-slate-800 bg-slate-950 p-0.5">
          {([26, 61, 201] as const).map(w => (
            <button
              key={w}
              onClick={() => { setWindowSize(w); setWindowOffset(0); }}
              className={`px-2 py-1 text-[10px] rounded font-mono font-semibold transition-all ${
                windowSize === w
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {w}天
            </button>
          ))}

          <div className="h-4 w-[1px] bg-slate-800 mx-1" />
          <button
            onClick={() => shift('left')}
            disabled={!canGoLeft}
            className="p-1 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors"
            title="往前多日"
          >
            <ChevronsLeft size={13} />
          </button>
          <button
            onClick={() => shift('left', 1)}
            disabled={!canGoLeft}
            className="p-1 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors"
            title="往前一日"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            onClick={() => shift('right', 1)}
            disabled={!canGoRight}
            className="p-1 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors"
            title="往後一日"
          >
            <ChevronRight size={13} />
          </button>
          <button
            onClick={() => shift('right')}
            disabled={!canGoRight}
            className="p-1 rounded text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors"
            title="往後多日"
          >
            <ChevronsRight size={13} />
          </button>
        </div>

        <div className="flex items-center gap-1 rounded border border-slate-850 bg-slate-950/60 px-2 py-1 font-mono text-slate-500">
          <span>{windowData[0]?.date} ~ {windowData[windowData.length - 1]?.date}</span>
        </div>
      </div>

      {/* ── Chart Area ── */}
      <div className="p-3 select-none flex-1 min-h-[420px] flex flex-col gap-2">
        {/* Main Price Chart */}
        <div className="h-[320px] shrink-0">
          <MarketDataStrip datum={displayDatum} />
          <div className="relative h-[292px]">
            {(showMAs || showSupportResistance) && (
              <LineLegend
                items={[
                  ...(showMAs ? [
                    { label: 'MA25', color: '#fb923c' },
                    { label: 'MA60', color: '#60a5fa' },
                    { label: 'MA200', color: '#f472b6' },
                  ] : []),
                  ...(showSupportResistance ? [
                    { label: '短壓25', color: '#ef4444' },
                    { label: '短撐25', color: '#10b981' },
                    { label: '長壓60', color: '#dc2626' },
                    { label: '長撐60', color: '#059669' },
                  ] : []),
                ]}
              />
            )}
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                syncId="integrated-stock-cockpit"
                data={chartData}
                margin={{ top: 12, right: 8, left: 0, bottom: 4 }}
                onMouseMove={handleChartMouseMove}
                onTouchMove={handleChartMouseMove}
                onMouseLeave={() => setHoveredDatum(null)}
              >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.5} />
              <XAxis 
                dataKey="date" 
                tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'monospace' }} 
                tickLine={false} 
                axisLine={false}
                tickFormatter={v => (v && !v.includes('+')) ? v.slice(5) : v}
                interval="preserveStartEnd" 
              />
              <YAxis 
                domain={priceDomain}
                allowDataOverflow
                tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'monospace' }} 
                tickLine={false} 
                axisLine={false} 
                width={48} 
              />
              <Tooltip
                content={() => null}
                cursor={{ stroke: '#475569', strokeDasharray: '3 3' }}
              />

              <Bar
                dataKey="candleRange"
                barSize={calculatedBarSize}
                shape={<CandlestickShape />}
                isAnimationActive={false}
              />

              {/* Moving Averages */}
              {showMAs && (
                <>
                  <Line type="monotone" dataKey="ma25" stroke="#fb923c" dot={false} strokeWidth={1.3} name="MA25" connectNulls={false} />
                  <Line type="monotone" dataKey="ma60" stroke="#60a5fa" dot={false} strokeWidth={1.3} name="MA60" connectNulls={false} />
                  <Line type="monotone" dataKey="ma200" stroke="#f472b6" dot={false} strokeWidth={1.3} name="MA200" connectNulls={false} />
                </>
              )}

              {/* VWAP indicator */}
              {showVWAP && (
                <Line type="monotone" dataKey="vwap" stroke="#eab308" dot={false} strokeWidth={1.5} name="VWAP" connectNulls={false} />
              )}

              {/* POC Reference Line */}
              {pocPrice !== null && (
                <ReferenceLine 
                  y={pocPrice} 
                  stroke="#f43f5e" 
                  strokeDasharray="3 3" 
                  strokeWidth={1.2}
                  label={{ value: `POC最密成交價: ${pocPrice.toFixed(2)}`, fill: '#f43f5e', fontSize: 8, position: 'right' }} 
                />
              )}

              {/* Two-point support and resistance trend lines */}
              {showSupportResistance && (
                <>
                  <Line
                    type="linear"
                    dataKey="shortResistance"
                    stroke="#ef4444"
                    strokeDasharray="4 3"
                    strokeWidth={1}
                    dot={false}
                    name="短期壓力（25日高點連線）"
                    connectNulls
                  />
                  <Line
                    type="linear"
                    dataKey="shortSupport"
                    stroke="#10b981"
                    strokeDasharray="4 3"
                    strokeWidth={1}
                    dot={false}
                    name="短期支撐（25日低點連線）"
                    connectNulls
                  />
                  <Line
                    type="linear"
                    dataKey="longResistance"
                    stroke="#dc2626"
                    strokeDasharray="1 3"
                    strokeWidth={1.5}
                    dot={false}
                    name="長期壓力（60日高點連線）"
                    connectNulls
                  />
                  <Line
                    type="linear"
                    dataKey="longSupport"
                    stroke="#059669"
                    strokeDasharray="1 3"
                    strokeWidth={1.5}
                    dot={false}
                    name="長期支撐（60日低點連線）"
                    connectNulls
                  />
                </>
              )}

              {/* Recent Wave High/Low */}
              {showRecentHighLow && recentHighLow.high > 0 && (
                <>
                  <ReferenceLine 
                    y={recentHighLow.high} 
                    stroke="#38bdf8" 
                    strokeWidth={1}
                    label={{ value: `波段最高: ${recentHighLow.high.toFixed(1)}`, fill: '#38bdf8', fontSize: 8, position: 'right' }} 
                  />
                  <ReferenceLine 
                    y={recentHighLow.low} 
                    stroke="#34d399" 
                    strokeWidth={1}
                    label={{ value: `波段最低: ${recentHighLow.low.toFixed(1)}`, fill: '#34d399', fontSize: 8, position: 'right' }} 
                  />
                </>
              )}

              {/* Extra lines passed via strategies views */}
              {overlay?.hLines?.map((hl, i) => (
                <ReferenceLine
                  key={`hl${i}`} 
                  y={hl.value}
                  stroke={hl.color}
                  strokeDasharray={hl.dash ? '4 3' : undefined}
                  strokeWidth={1.2}
                  label={hl.label ? { value: `${hl.label} ${hl.value}`, fill: hl.color, fontSize: 8, position: 'right' } : undefined}
                />
              ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Volume Sub-Chart */}
        <div className="h-[100px] border-t border-slate-850/60 pt-2 relative shrink-0">
          {showVolMAs && (
            <LineLegend
              items={[
                { label: 'VolMA5', color: '#22d3ee' },
                { label: 'VolMA60', color: '#f59e0b' },
              ]}
            />
          )}
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart syncId="integrated-stock-cockpit" data={chartData} margin={{ top: 2, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" opacity={0.3} />
              <XAxis dataKey="date" tick={false} tickLine={false} axisLine={false} />
              <YAxis 
                domain={[0, maxVolume * 1.15]} 
                tick={{ fill: '#64748b', fontSize: 8, fontFamily: 'monospace' }} 
                tickLine={false} 
                axisLine={false} 
                width={48} 
                tickFormatter={v => v >= 1000 ? `${(v/1000).toFixed(0)}K` : v}
              />
              {/* Volume Bars aligned perfectly with candles using the exact same calculatedBarSize */}
              <Bar dataKey="volume" barSize={calculatedBarSize} fill="#ef4444">
                {chartData.map((e, i) => (
                  <Cell key={`v${i}`} fill={e.color || '#ef4444'} opacity={0.85} />
                ))}
              </Bar>

              {/* Volume Moving Averages */}
              {showVolMAs && (
                <>
                  <Line type="monotone" dataKey="volma5" stroke="#22d3ee" dot={false} strokeWidth={1} name="VolMA5" connectNulls={false} />
                  <Line type="monotone" dataKey="volma60" stroke="#f59e0b" dot={false} strokeWidth={1} name="VolMA60" connectNulls={false} />
                </>
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>

      </div>
      <IntegratedMarketPanels
        visibleDates={chartData.map((row) => row.date)}
        institutional={institutional}
        shareholding={shareholding}
        showForeign={showForeign}
        showTrust={showTrust}
        showShareholding={showShareholding}
      />
    </div>
  );
}
