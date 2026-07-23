import React, { useMemo, useState, useCallback } from 'react';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Eye, EyeOff } from 'lucide-react';
import { PriceData, calcMA } from '../lib/indicators';

export interface KlineOverlay {
  hLines?: { value: number; color: string; label?: string; dash?: boolean }[];
  extraMAs?: { period: number; color: string; label: string }[];
}

interface KlineChartProps {
  data: PriceData[];
  overlay?: KlineOverlay;
}

type TimeframeType = 'daily' | 'weekly' | 'yearly';

// Custom Tooltip with Lots conversion
const CustomTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  
  if (d.isPrediction) {
    return (
      <div className="bg-slate-950/95 border border-purple-500/40 p-3 rounded-lg shadow-2xl font-mono text-xs text-slate-300 space-y-1.5 min-w-[190px]">
        <div className="text-purple-400 font-bold border-b border-purple-950 pb-1 flex justify-between items-center">
          <span>🔮 Kronos 預測 ({d.date})</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">預估價格:</span>
          <span className="text-purple-300 font-bold">{d.close.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">預估漲跌:</span>
          <span className={d.predPct >= 0 ? 'text-red-400 font-bold' : 'text-emerald-400 font-bold'}>
            {d.predPct >= 0 ? '+' : ''}{d.predPct.toFixed(2)}%
          </span>
        </div>
      </div>
    );
  }

  const isUp = d.close >= d.open;
  const change = d.close - d.open;
  const changePct = d.open > 0 ? (change / d.open) * 100 : 0;
  
  return (
    <div className="bg-slate-950/95 border border-slate-700 p-3 rounded-lg shadow-2xl font-mono text-xs text-slate-300 space-y-1 min-w-[190px]">
      <div className="text-slate-400 font-bold border-b border-slate-800 pb-1">{d.date}</div>
      <div className="space-y-0.5">
        {[
          ['開盤', d.open, 'text-slate-200'],
          ['最高', d.high, 'text-red-400'],
          ['最低', d.low, 'text-emerald-400'],
          ['收盤', d.close, isUp ? 'text-red-400' : 'text-emerald-400']
        ].map(([l, v, c]) => (
          <div key={l as string} className="flex justify-between">
            <span className="text-slate-500">{l}:</span>
            <span className={`font-bold ${c}`}>{(v as number).toFixed(2)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-slate-800 pt-1">
          <span className="text-slate-500">漲跌:</span>
          <span className={change >= 0 ? 'text-red-400 font-bold' : 'text-emerald-400 font-bold'}>
            {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">成交量:</span>
          <span className="text-slate-100 font-semibold">
            {d.volume.toLocaleString()} 張 ({ (d.volume * 1000).toLocaleString() } 股)
          </span>
        </div>
        {d.vwap !== undefined && d.vwap !== null && (
          <div className="flex justify-between border-t border-slate-800 pt-1 text-[10px]">
            <span className="text-slate-500">VWAP:</span>
            <span className="text-yellow-400 font-medium">{d.vwap.toFixed(2)}</span>
          </div>
        )}
      </div>
    </div>
  );
};

// Client-side data aggregator to support Daily, Weekly, Yearly timeframes
function aggregateData(data: PriceData[], type: TimeframeType): PriceData[] {
  if (type === 'daily' || !data || data.length === 0) return data;

  const result: PriceData[] = [];
  
  if (type === 'weekly') {
    const weeks: Record<string, PriceData[]> = {};
    const weekKeys: string[] = [];
    
    data.forEach(d => {
      const dateObj = new Date(d.date);
      // Compute year and week number simple index
      const firstDayOfYear = new Date(dateObj.getFullYear(), 0, 1);
      const pastDaysOfYear = (dateObj.getTime() - firstDayOfYear.getTime()) / 86400000;
      const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
      const weekKey = `${dateObj.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
      
      if (!weeks[weekKey]) {
        weeks[weekKey] = [];
        weekKeys.push(weekKey);
      }
      weeks[weekKey].push(d);
    });
    
    weekKeys.forEach(key => {
      const group = weeks[key];
      if (group.length === 0) return;
      group.sort((a, b) => a.date.localeCompare(b.date));
      const first = group[0];
      const last = group[group.length - 1];
      const high = Math.max(...group.map(g => g.high));
      const low = Math.min(...group.map(g => g.low));
      const volume = group.reduce((sum, g) => sum + g.volume, 0);
      result.push({
        date: last.date,
        open: first.open,
        high,
        low,
        close: last.close,
        volume
      });
    });
  } else if (type === 'yearly') {
    const years: Record<string, PriceData[]> = {};
    const yearKeys: string[] = [];
    
    data.forEach(d => {
      const year = d.date.split('-')[0];
      if (!years[year]) {
        years[year] = [];
        yearKeys.push(year);
      }
      years[year].push(d);
    });
    
    yearKeys.forEach(year => {
      const group = years[year];
      if (group.length === 0) return;
      group.sort((a, b) => a.date.localeCompare(b.date));
      const first = group[0];
      const last = group[group.length - 1];
      const high = Math.max(...group.map(g => g.high));
      const low = Math.min(...group.map(g => g.low));
      const volume = group.reduce((sum, g) => sum + g.volume, 0);
      result.push({
        date: last.date,
        open: first.open,
        high,
        low,
        close: last.close,
        volume
      });
    });
  }
  
  return result;
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

export function KlineChart({ data, overlay }: KlineChartProps) {
  const [timeframe, setTimeframe] = useState<TimeframeType>('daily');
  const [windowSize, setWindowSize] = useState<number>(120);
  const [windowOffset, setWindowOffset] = useState(0);

  // Filter or feature toggle states
  const [showMAs, setShowMAs] = useState(true);
  const [showVolMAs, setShowVolMAs] = useState(true);
  const [showVWAP, setShowVWAP] = useState(true);
  const [showSupportResistance, setShowSupportResistance] = useState(true);
  const [showRecentHighLow, setShowRecentHighLow] = useState(true);
  const [showPOC, setShowPOC] = useState(true);
  const [showPredictions, setShowPredictions] = useState(true);

  // 1. Aggregate based on timeframe
  const aggregatedData = useMemo(() => {
    let agg = aggregateData(data, timeframe);
    if (agg.length === 0) return agg;

    return agg;
  }, [data, timeframe]);

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

  // 3. Compute Support & Resistance levels based on the current window's ending position
  const supRes = useMemo(() => {
    if (aggregatedData.length === 0) return { shortRes: 0, shortSup: 0, longRes: 0, longSup: 0 };
    
    // Short term support & resistance (15 periods)
    const shortLen = 15;
    const startShort = Math.max(0, endIdx - shortLen + 1);
    const shortSlice = aggregatedData.slice(startShort, endIdx + 1);
    const shortRes = shortSlice.length > 0 ? Math.max(...shortSlice.map(d => {
      const v = Number(d.high);
      return isNaN(v) ? 0 : v;
    })) : 0;
    const shortSup = shortSlice.length > 0 ? Math.min(...shortSlice.map(d => {
      const v = Number(d.low);
      return isNaN(v) ? 0 : v;
    })) : 0;

    // Long term support & resistance (60 periods)
    const longLen = 60;
    const startLong = Math.max(0, endIdx - longLen + 1);
    const longSlice = aggregatedData.slice(startLong, endIdx + 1);
    const longRes = longSlice.length > 0 ? Math.max(...longSlice.map(d => {
      const v = Number(d.high);
      return isNaN(v) ? 0 : v;
    })) : 0;
    const longSup = longSlice.length > 0 ? Math.min(...longSlice.map(d => {
      const v = Number(d.low);
      return isNaN(v) ? 0 : v;
    })) : 0;

    return { shortRes, shortSup, longRes, longSup };
  }, [aggregatedData, endIdx]);

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
      const upper = Math.max(open, close);
      const lower = Math.min(open, close);
      
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
        upper,
        lower,
        boxRange: [lower, upper],
        wickRange: [low, high],
        ma25: ma25[i],
        ma60: ma60[i],
        ma200: ma200[i],
        volma5: cleanV5,
        volma60: cleanV60,
        vwap: vwapData[i],
        isUp,
        isPrediction: false,
      };
    });
  }, [aggregatedData, ma25, ma60, ma200, volma5, volma60, vwapData]);

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

  // 7. Append Kronos 5-day prediction to the end of the chart dataset if requested
  const chartData = useMemo(() => {
    if (!showPredictions || visibleChartData.length === 0 || windowOffset > 0) {
      return visibleChartData;
    }

    const lastReal = visibleChartData[visibleChartData.length - 1];
    const lastPrice = lastReal.close;

    // Estimate drift based on recent standard deviation
    const recentCloses = visibleChartData.map(d => d.close);
    const isUpTrend = recentCloses.length >= 2 ? recentCloses[recentCloses.length - 1] >= recentCloses[recentCloses.length - 2] : true;
    const stdDev = recentCloses.length >= 5 
      ? Math.sqrt(recentCloses.slice(-5).reduce((sq, val) => sq + Math.pow(val - (recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length), 2), 0) / 5) 
      : lastPrice * 0.015;
    const drift = isUpTrend ? (stdDev * 0.35) : -(stdDev * 0.35);

    // Create 5 future points (T+1 to T+5)
    const predictions = [];
    const timeframePrefix = timeframe === 'weekly' ? 'W' : timeframe === 'yearly' ? 'Y' : 'T';
    
    for (let i = 1; i <= 5; i++) {
      const predPrice = parseFloat((lastPrice + drift * i * (i === 3 ? 1.5 : i === 4 ? 1.2 : 1)).toFixed(2));
      const predPct = parseFloat(((predPrice - lastPrice) / lastPrice * 100).toFixed(2));
      predictions.push({
        date: `${timeframePrefix}+${i}`,
        open: null,
        high: null,
        low: null,
        close: predPrice,
        volume: 0,
        color: '#a855f7',
        boxRange: null,
        wickRange: null,
        isPrediction: true,
        predPct,
        kronosPrediction: predPrice,
      });
    }

    // Connect last real item to the first prediction item
    const connectedReal = {
      ...lastReal,
      kronosPrediction: lastReal.close
    };

    return [
      ...visibleChartData.slice(0, -1),
      connectedReal,
      ...predictions
    ];
  }, [visibleChartData, showPredictions, windowOffset, timeframe]);

  // Calculate maximum volume of the visible dataset to guarantee 100% correct scaling of Y-Axis in Recharts
  const maxVolume = useMemo(() => {
    if (chartData.length === 0) return 100;
    const volumes = chartData.map(d => Number(d.volume || 0)).filter(v => !isNaN(v));
    const maxVal = volumes.length > 0 ? Math.max(...volumes) : 100;
    return maxVal > 0 ? maxVal : 100;
  }, [chartData]);

  // Bar sizes to align K-Line candle bodies and Volume bars perfectly
  const currentWindowSize = showPredictions && windowOffset === 0 ? windowSize + 5 : windowSize;
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
      <div className="flex items-center border-b border-slate-800 bg-slate-950/40 flex-wrap p-2 gap-2 justify-between">
        {/* Timeframe aggregation switch */}
        <div className="flex bg-slate-950 p-0.5 rounded border border-slate-800">
          {[
            { key: 'daily', label: '日線' },
            { key: 'weekly', label: '周線' },
            { key: 'yearly', label: '年線' }
          ].map(tf => (
            <button
              key={tf.key}
              onClick={() => { setTimeframe(tf.key as TimeframeType); setWindowOffset(0); }}
              className={`px-3 py-1 text-[11px] rounded transition-all font-semibold ${
                timeframe === tf.key
                  ? 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>

        {/* View Window Size control */}
        <div className="flex items-center gap-1.5 bg-slate-950 p-0.5 rounded border border-slate-800">
          {([30, 60, 120, 250, 512] as const).map(w => (
            <button
              key={w}
              onClick={() => { setWindowSize(w); setWindowOffset(0); }}
              className={`px-2 py-1 text-[10px] rounded font-mono font-semibold transition-all ${
                windowSize === w
                  ? 'bg-slate-800 text-white border border-slate-700'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {w === 512 ? '512根' : `${w}天`}
            </button>
          ))}

          {/* Navigation keys */}
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

        {/* Dynamic Legend */}
        <div className="text-[10px] text-slate-500 font-mono flex items-center gap-1 bg-slate-950/60 px-2 py-1 rounded border border-slate-850">
          <span>{windowData[0]?.date} ~ {windowData[windowData.length - 1]?.date}</span>
        </div>
      </div>

      {/* ── Indicator Toggles ── */}
      <div className="flex flex-wrap items-center gap-1.5 p-2 bg-slate-950/20 border-b border-slate-800/80 text-[10px] text-slate-450">
        <span className="font-semibold text-slate-500 px-1 select-none">技術指標:</span>
        {[
          { label: '均線 (MA25/60/200)', state: showMAs, set: setShowMAs, color: 'text-orange-400' },
          { label: '量能均線 (VolMA5/60)', state: showVolMAs, set: setShowVolMAs, color: 'text-cyan-400' },
          { label: 'VWAP 均價線', state: showVWAP, set: setShowVWAP, color: 'text-yellow-400' },
          { label: '最密成交價 (POC)', state: showPOC, set: setShowPOC, color: 'text-rose-400' },
          { label: '長短期撐壓線', state: showSupportResistance, set: setShowSupportResistance, color: 'text-emerald-400' },
          { label: '波段最高最低', state: showRecentHighLow, set: setShowRecentHighLow, color: 'text-sky-400' },
          { label: 'Kronos 5日預測', state: showPredictions, set: setShowPredictions, color: 'text-purple-400 font-semibold' },
        ].map((ind, i) => (
          <button
            key={i}
            onClick={() => ind.set(!ind.state)}
            className={`px-2 py-0.5 rounded border transition-all flex items-center gap-1 ${
              ind.state 
                ? 'bg-slate-800/80 border-slate-700 text-slate-200' 
                : 'bg-transparent border-slate-900 text-slate-600'
            }`}
          >
            {ind.state ? <Eye size={10} className={ind.color} /> : <EyeOff size={10} />}
            <span>{ind.label}</span>
          </button>
        ))}
      </div>

      {/* ── Chart Area ── */}
      <div className="p-3 select-none flex-1 min-h-[420px] flex flex-col gap-2">
        {/* Main Price Chart */}
        <div className="h-[320px] relative shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart syncId="kline-volume-sync" data={chartData} margin={{ top: 12, right: 8, left: 0, bottom: 4 }} barGap="-100%">
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
                domain={['auto', 'auto']} 
                tick={{ fill: '#64748b', fontSize: 9, fontFamily: 'monospace' }} 
                tickLine={false} 
                axisLine={false} 
                width={48} 
              />
              <Tooltip content={<CustomTooltip />} />

              {/* Candle Shadow lines */}
              <Bar dataKey="wickRange" barSize={calculatedBarSize > 4 ? 1.5 : 1}>
                {chartData.map((e, i) => <Cell key={`w${i}`} fill={e.color} />)}
              </Bar>

              {/* Candle Bodies */}
              <Bar dataKey="boxRange" barSize={calculatedBarSize}>
                {chartData.map((e, i) => <Cell key={`b${i}`} fill={e.color} />)}
              </Bar>

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

              {/* Kronos Prediction path line */}
              {showPredictions && windowOffset === 0 && (
                <Line 
                  type="monotone" 
                  dataKey="kronosPrediction" 
                  stroke="#a855f7" 
                  strokeWidth={2} 
                  strokeDasharray="4 4" 
                  dot={{ r: 3, stroke: '#a855f7', fill: '#0f172a', strokeWidth: 1 }}
                  name="Kronos 預測" 
                  connectNulls={true} 
                />
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

              {/* Support & Resistance Levels */}
              {showSupportResistance && supRes.shortRes > 0 && (
                <>
                  <ReferenceLine 
                    y={supRes.shortRes} 
                    stroke="#ef4444" 
                    strokeDasharray="4 3" 
                    strokeWidth={1}
                    label={{ value: `短期壓力: ${supRes.shortRes.toFixed(1)}`, fill: '#ef4444', fontSize: 8, position: 'left' }} 
                  />
                  <ReferenceLine 
                    y={supRes.shortSup} 
                    stroke="#10b981" 
                    strokeDasharray="4 3" 
                    strokeWidth={1}
                    label={{ value: `短期支撐: ${supRes.shortSup.toFixed(1)}`, fill: '#10b981', fontSize: 8, position: 'left' }} 
                  />
                  <ReferenceLine 
                    y={supRes.longRes} 
                    stroke="#dc2626" 
                    strokeDasharray="1 3" 
                    strokeWidth={1.5}
                    label={{ value: `長期壓力: ${supRes.longRes.toFixed(1)}`, fill: '#dc2626', fontSize: 8, position: 'left' }} 
                  />
                  <ReferenceLine 
                    y={supRes.longSup} 
                    stroke="#059669" 
                    strokeDasharray="1 3" 
                    strokeWidth={1.5}
                    label={{ value: `長期支撐: ${supRes.longSup.toFixed(1)}`, fill: '#059669', fontSize: 8, position: 'left' }} 
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

        {/* Volume Sub-Chart */}
        <div className="h-[100px] border-t border-slate-850/60 pt-2 relative shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart syncId="kline-volume-sync" data={chartData} margin={{ top: 2, right: 8, left: 0, bottom: 4 }}>
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
              <Tooltip content={<CustomTooltip />} />
              
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
    </div>
  );
}
