import type { SnapshotRow } from "./stockSnapshot";

export const FINMIND_CACHE_TTL_MS = 30 * 60 * 1000;
export const FINMIND_CACHE_CAPACITY = 128;

export interface FinMindCacheRequest {
  stockId: string;
  dataset: string;
  startDate: string;
  endDate: string;
}

export type FinMindCacheStatus = "hit" | "miss" | "shared";

export interface FinMindCacheResult {
  rows: SnapshotRow[];
  status: FinMindCacheStatus;
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

interface CacheOptions {
  capacity?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface FinMindMemoryCache {
  load(request: FinMindCacheRequest, loader: () => Promise<SnapshotRow[]>): Promise<FinMindCacheResult>;
}

export interface BoundedMemoryCache<T> {
  load(key: string, loader: () => Promise<T>): Promise<{ value: T; status: FinMindCacheStatus }>;
}

function cacheKey(request: FinMindCacheRequest): string {
  return [request.stockId, request.dataset, request.startDate, request.endDate].join(":");
}

export function createBoundedMemoryCache<T>(options: CacheOptions = {}): BoundedMemoryCache<T> {
  const capacity = Math.max(1, options.capacity ?? FINMIND_CACHE_CAPACITY);
  const ttlMs = Math.max(1, options.ttlMs ?? FINMIND_CACHE_TTL_MS);
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry<T>>();
  const inFlight = new Map<string, Promise<T>>();

  const store = (key: string, value: T) => {
    while (entries.size >= capacity) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      entries.delete(oldestKey);
    }
    entries.set(key, { value, expiresAt: now() + ttlMs });
    return value;
  };

  return {
    async load(key, loader) {
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) {
        entries.delete(key);
        entries.set(key, cached);
        return { value: cached.value, status: "hit" };
      }
      if (cached) entries.delete(key);
      const pending = inFlight.get(key);
      if (pending) return { value: await pending, status: "shared" };

      const requestPromise = loader().then((rows) => store(key, rows));
      inFlight.set(key, requestPromise);
      try {
        return { value: await requestPromise, status: "miss" };
      } finally {
        if (inFlight.get(key) === requestPromise) inFlight.delete(key);
      }
    },
  };
}

export function createFinMindMemoryCache(options: CacheOptions = {}): FinMindMemoryCache {
  const cache = createBoundedMemoryCache<SnapshotRow[]>(options);
  return {
    async load(request, loader) {
      const result = await cache.load(cacheKey(request), loader);
      return { rows: result.value, status: result.status };
    },
  };
}

export const finMindMemoryCache = createFinMindMemoryCache();
