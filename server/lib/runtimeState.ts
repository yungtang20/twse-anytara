import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const serverClientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
};

export const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, serverClientOptions)
  : null;

// Server-only privileged client. Never export this client to frontend code.
export const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, serverClientOptions)
  : null;

export const debugState = {
  debugLogs: [] as Array<{ time: string; type: string; status: string; detail: string }>,
  activeSyncProcess: {
    running: false,
    logs: [] as string[],
    startTime: null as string | null,
    error: null as string | null,
  },
};

export function addLog(type: string, status: string, detail: string): void {
  const time = new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" });
  debugState.debugLogs.unshift({ time, type, status, detail });
  if (debugState.debugLogs.length > 50) debugState.debugLogs.pop();
}

export function pushSyncLog(line: string): void {
  const logs = debugState.activeSyncProcess.logs;
  logs.push(line);
  if (logs.length > 500) logs.splice(0, logs.length - 500);
}
