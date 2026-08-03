export type CloudHealthResult =
  | { success: true }
  | { success: false; error: string };

const HEALTH_TIMEOUT_MS = 3_000;

export async function checkSupabaseReachability(): Promise<CloudHealthResult> {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || "";
  if (!url || !anonKey) {
    return { success: false, error: "Supabase is not configured for cloud mode." };
  }

  try {
    const endpoint = new URL(
      "rest/v1/stock_meta?select=stock_id&limit=1",
      url.endsWith("/") ? url : `${url}/`,
    );
    const response = await fetch(endpoint, {
      method: "GET",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return { success: false, error: `Supabase is unreachable (HTTP ${response.status}).` };
    }
    return { success: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Supabase is unreachable: ${detail}` };
  }
}
