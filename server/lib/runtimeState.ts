import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey)
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
