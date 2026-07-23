/**
 * Strategy Engine - TypeScript port of SupportResistanceEngine from Python
 * Mirrors twstock/strategy/sr_analyzer.py logic for market scanning
 */

interface PriceRow {
  date: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SwingPoint {
  date: number;
  price: number;
}

interface AccelBand {
  accel_date: number;
  vwap_center: number;
  band_low: number;
  band_high: number;
  band_mid: number;
}

interface DensityBox {
  box_low: number;
  box_high: number;
  peak_low: number;
  peak_high: number;
}

interface DensityResult {
  status: string;
  boxes: DensityBox[];
  meta: { n_effective: number };
}

interface MergedLevel {
  level: number;
  count: number;
  members: number[];
}

interface AnalysisResult {
  latest_date: number;
  last_close: number;
  atr14: number;
  ma25: number;
  std25: number;
  recent_resistance_swing_high: SwingPoint | null;
  recent_support_swing_low: SwingPoint | null;
  key_close_levels_top5: any[];
  acceleration_support_band: AccelBand | null;
  price_density_box: DensityResult;
  merged_resistance_levels: MergedLevel[];
  merged_support_levels: MergedLevel[];
  nearest_resistance: number | null;
  nearest_support: number | null;
}

interface ScoreResult {
  code: string;
  name: string;
  close: number;
  vol: number;
  amount: number;
  dist: number;
  tags: string;
  score: number;
  nearest_s: number;
}

// --- Config (mirrors StrategyConfig) ---
const ATR_PERIOD = 14;
const SWING_LEFT = 5;
const SWING_RIGHT = 5;
const SWING_WINDOW = 120;
const KEY_CLOSE_WINDOW = 120;
const KEY_CLOSE_RETURN_THRESHOLD = 0.06;
const KEY_CLOSE_NEAR_HIGH_RATIO = 0.20;
const KEY_CLOSE_VOL_MULTIPLIER = 1.5;
const ACCEL_WINDOW = 120;
const ACCEL_BOX_WINDOW = 20;
const ACCEL_ATR_MULTIPLIER = 0.8;
const ACCEL_VOL_MULTIPLIER = 1.5;
const ACCEL_COST_WINDOW = 7;
const DENSITY_WINDOW = 250;
const DENSITY_BINS = 60;
const DENSITY_BAND_PERCENT = 0.30;
const DENSITY_USE_LOG_BINS = true;
const MERGE_ATR_TOLERANCE = 0.8;
const MIN_DISTANCE_PERCENT = 0.01;
const MAX_SCAN_RESULTS = 40;

function getTickSize(price: number): number {
  if (price < 10) return 0.01;
  if (price < 50) return 0.05;
  if (price < 100) return 0.1;
  if (price < 500) return 0.5;
  if (price < 1000) return 1.0;
  return 5.0;
}

function toDateInt(val: any): number {
  try {
    let s = String(val);
    if (s.includes('T')) s = s.split('T')[0];
    s = s.replace(/-/g, '');
    return parseInt(s);
  } catch { return 0; }
}

function scoreResult(a: Record<string, any>, code: string, name: string, df: PriceRow[]): ScoreResult | null {
  const price = a.last_close;
  if (price <= 0) return null;
  const vol = df.length > 0 ? df[df.length - 1].volume : 0;
  const ns = a.nearest_support;
  if (!ns || ns <= 0) return null;
  const dist = ((price - ns) / ns) * 100;
  if (dist > 8) return null;
  const tags: string[] = [];
  let score = 0;
  if (dist <= 2) { tags.push("近支撐"); score += 1; }
  tags.push("有支撐"); score += 1;
  if (a.acceleration_support_band) { tags.push("加速帶"); score += 1; }
  const boxes = a.price_density_box?.boxes || [];
  if (boxes.length > 0) {
    const b = boxes[0];
    if (b.box_low * 0.98 <= price && price <= b.box_high * 1.02) { tags.push("密集區"); score += 1; }
  }
  for (const g of a.merged_support_levels || []) {
    if (g.count >= 2 && ns && Math.abs(g.level - ns) < 1e-5) { tags.push("強支撐"); score += 2; }
  }
  return {
    code, name, close: price,
    vol: Math.floor(vol / 1000),
    amount: (price * vol) / 1e8,
    dist, tags: tags.join("/"), score, nearest_s: ns,
  };
}

// ── Full Engine Port ─────────────────────────────────────

export class SupportResistanceEngine {
  rows: PriceRow[];
  last_close: number;
  atr14: number;

  constructor(rows: PriceRow[]) {
    this.rows = this._clean(rows);
    this.last_close = this.rows.length > 0 ? this.rows[this.rows.length - 1].close : 0;
    this.atr14 = this._computeATR();
  }

  private _clean(rows: PriceRow[]): PriceRow[] {
    let cleaned = rows.filter(r => r.open > 0 && r.high > 0 && r.low > 0 && r.close > 0);
    cleaned = cleaned.map(r => ({
      ...r,
      high: Math.max(r.open, r.high, r.low, r.close),
      low: Math.min(r.open, r.high, r.low, r.close),
      volume: Math.max(r.volume, 0),
    }));
    return cleaned.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }

  private _computeATR(period = ATR_PERIOD): number {
    if (this.rows.length < 2) return this.last_close * 0.02;
    const tick = getTickSize(this.last_close);
    let sumTR = 0;
    const start = Math.max(1, this.rows.length - period);
    for (let i = start; i < this.rows.length; i++) {
      const tr = Math.max(
        this.rows[i].high - this.rows[i].low,
        Math.abs(this.rows[i].high - this.rows[i - 1].close),
        Math.abs(this.rows[i].low - this.rows[i - 1].close),
      );
      sumTR += Math.max(tr, 2 * tick);
    }
    return sumTR / (this.rows.length - start);
  }

  private _findSwing(arr: number[], dates: (string | number)[], mode: 'high' | 'low'): SwingPoint | null {
    const n = SWING_LEFT + SWING_RIGHT + 1;
    if (arr.length < n) {
      if (arr.length >= 10) {
        const seg = arr.slice(-10);
        const idx = mode === 'high' ? seg.indexOf(Math.max(...seg)) : seg.indexOf(Math.min(...seg));
        return { date: toDateInt(dates[arr.length - 10 + idx]), price: seg[idx] };
      }
      return null;
    }
    for (let i = arr.length - SWING_RIGHT - 1; i >= SWING_LEFT; i--) {
      if (i <= 0) break;
      const win = arr.slice(i - SWING_LEFT, i + SWING_RIGHT + 1);
      const extreme = mode === 'high' ? Math.max(...win) : Math.min(...win);
      if (arr[i] === extreme) {
        const idxs = win.map((v, j) => v === extreme ? j : -1).filter(j => j >= 0);
        if (idxs[idxs.length - 1] === SWING_LEFT) {
          return { date: toDateInt(dates[i]), price: arr[i] };
        }
      }
    }
    if (arr.length >= 10) {
      const seg = arr.slice(-10);
      const idx = mode === 'high' ? seg.indexOf(Math.max(...seg)) : seg.indexOf(Math.min(...seg));
      return { date: toDateInt(dates[arr.length - 10 + idx]), price: seg[idx] };
    }
    return null;
  }

  private _findSwingPoints(): [SwingPoint | null, SwingPoint | null] {
    const tail = this.rows.slice(-SWING_WINDOW);
    const highs = tail.map(r => r.high);
    const lows = tail.map(r => r.low);
    const dates = tail.map(r => r.date);
    return [
      this._findSwing(highs, dates, 'high'),
      this._findSwing(lows, dates, 'low'),
    ];
  }

  private _recentExtremes(): [SwingPoint | null, SwingPoint | null] {
    if (this.rows.length < 10) return [null, null];
    const tail = this.rows.slice(-10);
    const highs = tail.map(r => r.high);
    const lows = tail.map(r => r.low);
    const dates = tail.map(r => r.date);
    const hiIdx = highs.indexOf(Math.max(...highs));
    const loIdx = lows.indexOf(Math.min(...lows));
    return [
      { date: toDateInt(dates[hiIdx]), price: highs[hiIdx] },
      { date: toDateInt(dates[loIdx]), price: lows[loIdx] },
    ];
  }

  private _keyCloseLevels(): any[] {
    if (this.rows.length < 20) return [];
    const tail = this.rows.slice(-KEY_CLOSE_WINDOW);
    const results: any[] = [];
    for (let i = 1; i < tail.length; i++) {
      const ret = tail[i].close / tail[i - 1].close - 1;
      if (ret >= KEY_CLOSE_RETURN_THRESHOLD && 
          (tail[i].high - tail[i].close) <= KEY_CLOSE_NEAR_HIGH_RATIO * (tail[i].high - tail[i].low)) {
        // Check volume
        const volSlice = tail.slice(Math.max(0, i - 20), i);
        const volMA = volSlice.reduce((s, r) => s + r.volume, 0) / Math.max(volSlice.length, 1);
        if (tail[i].volume >= KEY_CLOSE_VOL_MULTIPLIER * volMA) {
          results.push({ date: tail[i].date, close: tail[i].close, ret });
        }
      }
    }
    return results.slice(0, 5);
  }

  private _accelerationBand(): AccelBand | null {
    const bw = ACCEL_BOX_WINDOW;
    if (this.rows.length < bw + 1) return null;
    const recent = this.rows.slice(-ACCEL_WINDOW);
    const closes = recent.map(r => r.close);
    const highs = recent.map(r => r.high);
    const lows = recent.map(r => r.low);
    const vols = recent.map(r => r.volume);
    const volMA20: number[] = [];
    for (let i = 0; i < recent.length; i++) {
      const slice = recent.slice(Math.max(0, i - 19), i + 1);
      volMA20.push(slice.reduce((s, r) => s + r.volume, 0) / slice.length);
    }
    let accelIdx = -1;
    for (let i = recent.length - 1; i >= bw; i--) {
      const highSlice = highs.slice(i - bw, i);
      const priceOK = closes[i] > Math.max(...highSlice);
      const volOK = volMA20[i] > 0 ? vols[i] >= ACCEL_VOL_MULTIPLIER * volMA20[i] : true;
      const prevATR = this.atr14 || (highs[0] - lows[0]);
      const rangeOK = (highs[i] - lows[i]) >= ACCEL_ATR_MULTIPLIER * prevATR;
      if (priceOK && volOK && rangeOK) {
        accelIdx = i;
        break;
      }
    }
    if (accelIdx < ACCEL_COST_WINDOW) return null;
    const costSlice = recent.slice(accelIdx - ACCEL_COST_WINDOW, accelIdx);
    const typicalPrices = costSlice.map(r => (r.high + r.low + r.close) / 3);
    const vols2 = costSlice.map(r => r.volume);
    let vwap: number;
    const totalVol = vols2.reduce((s, v) => s + v, 0);
    if (totalVol > 0) {
      vwap = typicalPrices.reduce((s, tp, i) => s + tp * vols2[i], 0) / totalVol;
    } else {
      vwap = costSlice.reduce((s, r) => s + r.close, 0) / costSlice.length;
    }
    const atrVal = this.atr14 || vwap * 0.02;
    return {
      accel_date: toDateInt(recent[accelIdx].date),
      vwap_center: vwap,
      band_low: vwap - 0.5 * atrVal,
      band_high: vwap + 0.5 * atrVal,
      band_mid: vwap,
    };
  }

  private _priceDensity(): DensityResult {
    const tail = this.rows.slice(-DENSITY_WINDOW);
    const tps = tail.map(r => (r.high + r.low + r.close) / 3).filter(tp => tp > 0);
    if (tps.length < 10) return { status: "NO_DATA", boxes: [], meta: { n_effective: tps.length } };
    const lo = Math.min(...tps);
    const hi = Math.max(...tps);
    let edges: number[];
    if (DENSITY_USE_LOG_BINS && lo > 0) {
      edges = logspace(lo, hi, DENSITY_BINS + 1);
    } else {
      edges = linspace(lo, hi, DENSITY_BINS + 1);
    }
    const hist = new Array(DENSITY_BINS).fill(0);
    for (const tp of tps) {
      for (let i = 0; i < DENSITY_BINS; i++) {
        if (tp >= edges[i] && tp < edges[i + 1]) {
          hist[i]++;
          break;
        }
      }
    }
    const maxVal = Math.max(...hist);
    if (maxVal === 0) return { status: "NO_DATA", boxes: [], meta: { n_effective: tps.length } };
    const peakIdx = hist.indexOf(maxVal);
    const threshold = maxVal * (1 - DENSITY_BAND_PERCENT);
    let left = peakIdx;
    while (left > 0 && hist[left - 1] >= threshold) left--;
    let right = peakIdx;
    while (right < DENSITY_BINS - 1 && hist[right + 1] >= threshold) right++;
    return {
      status: "OK",
      boxes: [{
        box_low: edges[left],
        box_high: edges[right + 1],
        peak_low: edges[peakIdx],
        peak_high: edges[peakIdx + 1],
      }],
      meta: { n_effective: tps.length },
    };
  }

  private _mergeLevels(levels: number[], atrRef: number): MergedLevel[] {
    const valid = levels.filter(l => l !== null && !isNaN(l)).sort((a, b) => a - b);
    if (valid.length === 0) return [];
    const tick = getTickSize(this.last_close);
    const tol = Math.max(tick * 2, Math.min(0.01 * this.last_close, MERGE_ATR_TOLERANCE * atrRef));
    const groups: number[][] = [];
    let cur = [valid[0]];
    for (let i = 1; i < valid.length; i++) {
      const mean = cur.reduce((s, v) => s + v, 0) / cur.length;
      if (Math.abs(valid[i] - mean) <= tol) {
        cur.push(valid[i]);
      } else {
        groups.push(cur);
        cur = [valid[i]];
      }
    }
    groups.push(cur);
    const results = groups.map(g => ({
      level: g.reduce((s, v) => s + v, 0) / g.length,
      count: g.length,
      members: g,
    }));
    results.sort((a, b) => b.count - a.count || a.level - b.level);
    return results;
  }

  private _classify(
    swingHi: SwingPoint | null,
    swingLo: SwingPoint | null,
    keyCloses: any[],
    accel: AccelBand | null,
    density: DensityResult,
    recentHi: SwingPoint | null,
    recentLo: SwingPoint | null,
  ): [number[], number[]] {
    const raw: number[] = [];
    const windows = [5, 10, 20, 25, 60].filter(w => this.rows.length >= w);
    for (const w of windows) {
      const ma = this.rows.slice(-w).reduce((s, r) => s + r.close, 0) / w;
      raw.push(ma);
    }
    if (this.rows.length >= 2) {
      const prev = this.rows[this.rows.length - 2];
      const P = (prev.high + prev.low + prev.close) / 3;
      raw.push(P, 2 * P - prev.low, 2 * P - prev.high, P + (prev.high - prev.low), P - (prev.high - prev.low));
    }
    if (this.rows.length > 0) {
      const cur = this.rows[this.rows.length - 1];
      const cVal = cur.close, hVal = cur.high, lVal = cur.low;
      const atrVal = this.atr14 || cVal * 0.02;
      const pVal = (hVal + lVal + cVal) / 3;
      raw.push(2 * pVal - lVal, pVal + (hVal - lVal), hVal + 2 * (pVal - lVal));
      raw.push(2 * pVal - hVal, pVal - (hVal - lVal), lVal - 2 * (hVal - pVal));
      raw.push(cVal + atrVal, cVal + 2 * atrVal, cVal - atrVal, cVal - 2 * atrVal);
    }
    if (recentHi) raw.push(recentHi.price);
    if (recentLo) raw.push(recentLo.price);
    if (swingHi) raw.push(swingHi.price);
    if (swingLo) raw.push(swingLo.price);
    for (const kc of keyCloses) raw.push(kc.close);
    if (density.status === 'OK' && density.boxes.length > 0) {
      raw.push(density.boxes[0].box_high, density.boxes[0].box_low);
    }
    if (accel) {
      raw.push(accel.band_low, accel.band_mid, accel.band_high);
    }
    const res = raw.filter(v => v > this.last_close);
    const sup = raw.filter(v => v < this.last_close);
    return [res, sup];
  }

  private _nearest(merged: MergedLevel[], above: boolean): number | null {
    const margin = MIN_DISTANCE_PERCENT;
    if (above) {
      const valid = merged.filter(g => g.level > this.last_close * (1 + margin));
      if (valid.length > 0) return Math.min(...valid.map(v => v.level));
      // Fallback: find swing highs
      const highs = this.rows.map(r => r.high);
      const allHighs: number[] = [];
      if (highs.length >= SWING_LEFT + SWING_RIGHT + 1) {
        for (let i = SWING_LEFT; i < highs.length - SWING_RIGHT; i++) {
          const win = highs.slice(i - SWING_LEFT, i + SWING_RIGHT + 1);
          if (highs[i] === Math.max(...win)) allHighs.push(highs[i]);
        }
      }
      const validHighs = allHighs.filter(h => h > this.last_close * (1 + margin));
      if (validHighs.length > 0) return Math.min(...validHighs);
      const absMax = Math.max(...highs);
      return absMax > this.last_close * (1 + margin) ? absMax : null;
    } else {
      const valid = merged.filter(g => g.level < this.last_close * (1 - margin));
      if (valid.length > 0) return Math.max(...valid.map(v => v.level));
      const lows = this.rows.map(r => r.low);
      const allLows: number[] = [];
      if (lows.length >= SWING_LEFT + SWING_RIGHT + 1) {
        for (let i = SWING_LEFT; i < lows.length - SWING_RIGHT; i++) {
          const win = lows.slice(i - SWING_LEFT, i + SWING_RIGHT + 1);
          if (lows[i] === Math.min(...win)) allLows.push(lows[i]);
        }
      }
      const validLows = allLows.filter(l => l < this.last_close * (1 - margin));
      if (validLows.length > 0) return Math.max(...validLows);
      const absMin = Math.min(...lows);
      return absMin < this.last_close * (1 - margin) ? absMin : null;
    }
  }

  analyze(compact = false): AnalysisResult | Record<string, any> {
    if (this.rows.length === 0) return {};
    try {
      const [swingHi, swingLo] = this._findSwingPoints();
      const [recentHi, recentLo] = this._recentExtremes();
      let finalSwingHi = swingHi;
      let finalSwingLo = swingLo;
      if (recentHi && (!swingHi || recentHi.price > swingHi.price)) finalSwingHi = recentHi;
      if (recentLo && (!swingLo || recentLo.price < swingLo.price)) finalSwingLo = recentLo;
      const keyCloses = this._keyCloseLevels();
      const accel = this._accelerationBand();
      const density = this._priceDensity();
      const [resCand, supCand] = this._classify(finalSwingHi, finalSwingLo, keyCloses, accel, density, recentHi, recentLo);
      const atrRef = this.atr14 || this.last_close * 0.02;
      const mergedR = this._mergeLevels(resCand, atrRef);
      const mergedS = this._mergeLevels(supCand, atrRef);
      mergedR.sort((a, b) => Math.abs(a.level - this.last_close) - Math.abs(b.level - this.last_close));
      mergedS.sort((a, b) => Math.abs(a.level - this.last_close) - Math.abs(b.level - this.last_close));
      const nearestR = this._nearest(mergedR, true);
      const nearestS = this._nearest(mergedS, false);
      const closes = this.rows.map(r => r.close);
      let ma25 = closes.slice(-25).reduce((s, v) => s + v, 0) / Math.min(25, closes.length);
      if (closes.length < 25) ma25 = this.last_close;
      const recent25 = closes.slice(-25);
      const mean = recent25.reduce((s, v) => s + v, 0) / recent25.length;
      const std25 = Math.sqrt(recent25.reduce((s, v) => s + (v - mean) ** 2, 0) / recent25.length);
      return {
        latest_date: toDateInt(this.rows[this.rows.length - 1].date),
        last_close: this.last_close,
        atr14: atrRef,
        ma25: ma25 || this.last_close,
        std25: std25 || 0,
        recent_resistance_swing_high: finalSwingHi,
        recent_support_swing_low: finalSwingLo,
        key_close_levels_top5: keyCloses,
        acceleration_support_band: accel,
        price_density_box: density,
        merged_resistance_levels: mergedR,
        merged_support_levels: mergedS,
        nearest_resistance: nearestR,
        nearest_support: nearestS,
      };
    } catch (e) {
      return {};
    }
  }
}

// ── Helper functions ──────────────────────────────────────

function linspace(start: number, end: number, num: number): number[] {
  const step = (end - start) / (num - 1);
  return Array.from({ length: num }, (_, i) => start + step * i);
}

function logspace(start: number, end: number, num: number): number[] {
  const logStart = Math.log10(start);
  const logEnd = Math.log10(end);
  const lin = linspace(logStart, logEnd, num);
  return lin.map(v => Math.pow(10, v));
}

// ── Scan scoring for market scan (matches Python _score) ────

export function scanAndScoreStock(
  rows: PriceRow[], code: string, name: string,
): { stock_id: string; stock_name: string; close: number; volume: number; amount: number; dist: number; tags: string; score: number; support: number } | null {
  if (rows.length < 60) return null;
  const engine = new SupportResistanceEngine(rows);
  const result = engine.analyze();
  if (!result || Object.keys(result).length === 0) return null;
  const ar = result as AnalysisResult;
  const price = ar.last_close;
  const ns = ar.nearest_support;
  if (!ns || ns <= 0) return null;
  const dist = ((price - ns) / ns) * 100;
  if (dist > 8) return null;
  const tags: string[] = [];
  let score = 0;
  if (dist <= 2) { tags.push("近支撐"); score += 1; }
  tags.push("有支撐"); score += 1;
  if (ar.acceleration_support_band) { tags.push("加速帶"); score += 1; }
  const boxes = ar.price_density_box?.boxes || [];
  if (boxes.length > 0) {
    const b = boxes[0];
    if (b.box_low * 0.98 <= price && price <= b.box_high * 1.02) { tags.push("密集區"); score += 1; }
  }
  for (const g of ar.merged_support_levels || []) {
    if (g.count >= 2 && ns && Math.abs(g.level - ns) < 1e-5) { tags.push("強支撐"); score += 2; }
  }
  const vol = rows[rows.length - 1]?.volume || 0;
  return {
    stock_id: code,
    stock_name: name,
    close: price,
    volume: Math.floor(vol / 1000),
    amount: parseFloat(((price * vol) / 1e8).toFixed(2)),
    dist: parseFloat(dist.toFixed(2)),
    tags: tags.join("/"),
    score,
    support: ns,
  };
}

// ── Fast SR scan using full engine ─────────────────────────

export async function runFullSRScan(
  getRows: (stockId: string) => Promise<PriceRow[]>,
  candidates: { stock_id: string; stock_name: string; close: number; volume: number; amount: number }[],
  sortBy: string,
  limit: number,
): Promise<any[]> {
  const results: any[] = [];
  for (const c of candidates) {
    try {
      const rows = await getRows(c.stock_id);
      const score = scanAndScoreStock(rows, c.stock_id, c.stock_name);
      if (score) results.push(score);
    } catch { /* skip */ }
  }
  if (sortBy === "1") results.sort((a, b) => a.dist - b.dist);
  else results.sort((a, b) => b.amount - a.amount);
  return results.slice(0, limit);
}
