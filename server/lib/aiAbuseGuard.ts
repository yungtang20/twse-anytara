type AIAbuseGuardErrorCode = "ai_rate_limited" | "ai_shared_daily_limit"
  | "ai_concurrency_limit" | "ai_guard_config_invalid" | "ai_client_invalid";

export class AIAbuseGuardError extends Error {
  constructor(readonly code: AIAbuseGuardErrorCode) {
    super(code);
    this.name = "AIAbuseGuardError";
  }
}

interface AIAbuseGuardConfig {
  requestsPerWindow: number;
  windowMs: number;
  sharedDailyLimit: number;
  maxConcurrency: number;
}

interface ClientWindow {
  startedAt: number;
  count: number;
  lastSeenAt: number;
}

interface AcquireInput {
  clientId: string;
  usesSharedProvider: boolean;
  nowMs?: number;
}

const MAX_CLIENTS = 10_000;
const DAY_MS = 86_400_000;

export class AIAbuseGuard {
  private readonly clients = new Map<string, ClientWindow>();
  private active = 0;
  private sharedDay = -1;
  private sharedCount = 0;

  constructor(private readonly config: AIAbuseGuardConfig) {}

  acquire(input: AcquireInput): () => void {
    const clientId = input.clientId.trim();
    if (!clientId || clientId.length > 256 || /[\r\n\0]/.test(clientId)) {
      throw new AIAbuseGuardError("ai_client_invalid");
    }
    const now = input.nowMs ?? Date.now();
    const day = Math.floor(now / DAY_MS);
    if (day !== this.sharedDay) {
      this.sharedDay = day;
      this.sharedCount = 0;
    }
    this.pruneClients(now, clientId);
    const existing = this.clients.get(clientId);
    const window = !existing || now - existing.startedAt >= this.config.windowMs
      ? { startedAt: now, count: 0, lastSeenAt: now }
      : existing;
    if (window.count >= this.config.requestsPerWindow) {
      throw new AIAbuseGuardError("ai_rate_limited");
    }
    if (input.usesSharedProvider && this.sharedCount >= this.config.sharedDailyLimit) {
      throw new AIAbuseGuardError("ai_shared_daily_limit");
    }
    if (this.active >= this.config.maxConcurrency) {
      throw new AIAbuseGuardError("ai_concurrency_limit");
    }

    window.count += 1;
    window.lastSeenAt = now;
    this.clients.set(clientId, window);
    if (input.usesSharedProvider) this.sharedCount += 1;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }

  private pruneClients(now: number, incomingClientId: string): void {
    if (this.clients.has(incomingClientId) || this.clients.size < MAX_CLIENTS) return;
    const staleBefore = now - this.config.windowMs * 2;
    for (const [clientId, entry] of this.clients) {
      if (entry.lastSeenAt < staleBefore) this.clients.delete(clientId);
    }
    if (this.clients.size < MAX_CLIENTS) return;
    const oldest = [...this.clients.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
    if (oldest) this.clients.delete(oldest[0]);
  }
}

type Env = Record<string, string | undefined>;

function integer(env: Env, name: string, fallback: number, maximum: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new AIAbuseGuardError("ai_guard_config_invalid");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new AIAbuseGuardError("ai_guard_config_invalid");
  }
  return value;
}

export function createAIAbuseGuard(env: Env = process.env): AIAbuseGuard {
  return new AIAbuseGuard({
    requestsPerWindow: integer(env, "AI_RATE_LIMIT_REQUESTS", 10, 10_000),
    windowMs: integer(env, "AI_RATE_LIMIT_WINDOW_MS", 600_000, DAY_MS),
    sharedDailyLimit: integer(env, "AI_SHARED_DAILY_LIMIT", 100, 10_000_000),
    maxConcurrency: integer(env, "AI_MAX_CONCURRENCY", 2, 1_000),
  });
}
