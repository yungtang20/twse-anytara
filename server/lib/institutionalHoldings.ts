const SOURCE_ROOT =
  "https://raw.githubusercontent.com/voidful/tw-institutional-stocker/main/docs/data/timeseries";
const CACHE_TTL_MS = 30 * 60 * 1_000;

export interface InstitutionalHoldingSnapshot {
  stockId: string;
  date: string;
  foreignRatio: number;
  trustRatio: number;
  dealerRatio: number;
  totalRatio: number;
  sourceUrl: string;
  estimated: true;
}

interface CachedSnapshot {
  expiresAt: number;
  value: InstitutionalHoldingSnapshot;
}

const cache = new Map<string, CachedSnapshot>();

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRecord(stockId: string, sourceUrl: string, value: unknown) {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const date = typeof row.date === "string" ? row.date : "";
  const foreignRatio = finiteNumber(row.foreign_ratio);
  const trustRatio = finiteNumber(row.trust_ratio);
  const dealerRatio = finiteNumber(row.dealer_ratio);
  const totalRatio = finiteNumber(row.three_inst_ratio);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || [foreignRatio, trustRatio, dealerRatio, totalRatio].includes(null)) return null;
  return { stockId, date, foreignRatio, trustRatio, dealerRatio, totalRatio, sourceUrl, estimated: true } as InstitutionalHoldingSnapshot;
}

export function parseInstitutionalHoldingSeries(stockId: string, sourceUrl: string, payload: unknown) {
  if (!Array.isArray(payload)) throw new Error("法人持股來源格式錯誤");
  const rows = payload.map((row) => parseRecord(stockId, sourceUrl, row))
    .filter((row): row is InstitutionalHoldingSnapshot => row !== null)
    .sort((left, right) => right.date.localeCompare(left.date));
  if (!rows[0]) throw new Error(`查無 ${stockId} 法人持股資料`);
  return rows[0];
}

export async function fetchInstitutionalHoldingSnapshot(stockId: string, signal?: AbortSignal) {
  if (!isOrdinaryStockId(stockId)) throw new Error("法人持股僅支援普通股");
  const cached = cache.get(stockId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const sourceUrl = `${SOURCE_ROOT}/${stockId}.json`;
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(sourceUrl, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`法人持股來源回覆 HTTP ${response.status}`);
  const value = parseInstitutionalHoldingSeries(stockId, sourceUrl, await response.json());
  cache.set(stockId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

export function formatInstitutionalHoldingEvidence(value: InstitutionalHoldingSnapshot) {
  return [
    "[InstitutionalHoldingsLatest]",
    `date=${value.date}`,
    `foreign_ratio=${value.foreignRatio.toFixed(4)}%`,
    `trust_ratio_est=${value.trustRatio.toFixed(4)}%`,
    `dealer_ratio_est=${value.dealerRatio.toFixed(4)}%`,
    `three_inst_ratio_est=${value.totalRatio.toFixed(4)}%`,
    "method=外資官方持股比率；投信與自營商為歷史買賣超累計估算，來源目前未提供實際基準持股",
  ].join("\n");
}
import { isOrdinaryStockId } from "./stockUniverse";
