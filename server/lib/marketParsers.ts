import http from "http";
import https from "https";

type JsonResponse = { ok: boolean; status: number; json: () => Promise<any> };

export function fetchFollowRedirects(url: string, maxRedirects = 5): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https") ? https : http;
    const request = transport.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json, text/javascript" },
    }, (response) => {
      const redirect = response.statusCode
        && response.statusCode >= 300
        && response.statusCode < 400
        && response.headers.location;
      if (redirect && maxRedirects > 0) {
        const location = new URL(redirect, url).toString();
        response.resume();
        fetchFollowRedirects(location, maxRedirects - 1).then(resolve, reject);
        return;
      }
      resolve({
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        status: response.statusCode || 0,
        json: () => new Promise((resolveJson, rejectJson) => {
          let body = "";
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => {
            try {
              resolveJson(JSON.parse(body));
            } catch (error) {
              rejectJson(error);
            }
          });
        }),
      });
    });
    request.on("error", reject);
  });
}

export function getNormalizedProp(
  value: Record<string, unknown> | null | undefined,
  candidates: string[],
): unknown {
  if (!value) return undefined;
  for (const candidate of candidates) {
    if (value[candidate] != null) return value[candidate];
    const normalizedCandidate = normalizeKey(candidate);
    const key = Object.keys(value).find((item) => normalizeKey(item) === normalizedCandidate);
    if (key && value[key] != null) return value[key];
  }
  return undefined;
}

function normalizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "").toLowerCase();
}

export function formatDateStr(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function formatTpexDateStr(date: Date): string {
  const year = date.getFullYear() - 1911;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

export const stripHtml = (value: string): string =>
  String(value || "").replace(/<[^>]*>/g, "").trim();

export const parseNum = (value: unknown): number =>
  Number.parseFloat(String(value || "").replace(/,/g, "")) || 0;

export function calcTwseLimit(previousClose: number): { up: number; down: number } {
  const tick = (price: number) => {
    if (price < 10) return 0.01;
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 500) return 0.5;
    if (price < 1000) return 1;
    return 5;
  };
  const upTarget = Math.round(previousClose * 1.1 * 10_000) / 10_000;
  const downTarget = Math.round(previousClose * 0.9 * 10_000) / 10_000;
  const up = Math.floor((upTarget + 0.0000001) / tick(upTarget - 0.00001))
    * tick(upTarget - 0.00001);
  const down = Math.ceil((downTarget - 0.0000001) / tick(downTarget + 0.00001))
    * tick(downTarget + 0.00001);
  return { up: Number(up.toFixed(2)), down: Number(down.toFixed(2)) };
}

export function parseTwseIndex(json: any) {
  try {
    const table = json?.tables?.[0];
    if (!table?.data) return null;
    const row = table.data.find((item: unknown[]) =>
      String(item[0]).includes("發行量加權股價指數")) || table.data[1];
    const index = parseNum(row[1]);
    if (index <= 0) return null;
    return { index, change: parseNum(row[3]), changePercent: parseNum(row[4]) };
  } catch {
    return null;
  }
}

export function parseTwseUpDown(json: any) {
  try {
    const table = json?.tables?.find((item: any) => item.title?.includes("每日收盤行情"));
    if (!table?.data) return null;
    const counts = { limitUp: 0, up: 0, flat: 0, down: 0, limitDown: 0 };
    for (const row of table.data as unknown[][]) countTwseRow(row, counts);
    return counts;
  } catch {
    return null;
  }
}

function countTwseRow(
  row: unknown[],
  counts: { limitUp: number; up: number; flat: number; down: number; limitDown: number },
): void {
  const id = String(row[0]);
  if (!/^[1-9]\d{3}$/.test(id)) return;
  const close = parseNum(row[8]);
  const difference = parseNum(row[10]);
  const sign = String(row[9]);
  if (close <= 0) return;
  const rising = sign.includes("red") || sign.includes("+");
  const falling = sign.includes("green") || sign.includes("-");
  const previousClose = Number((rising ? close - difference : falling ? close + difference : close).toFixed(2));
  const limits = calcTwseLimit(previousClose);
  if (rising) {
    counts[close >= limits.up - 0.005 ? "limitUp" : "up"]++;
  } else if (falling) {
    counts[close <= limits.down + 0.005 ? "limitDown" : "down"]++;
  } else {
    counts.flat++;
  }
}

export function parseTpexIndex(json: any, targetDate?: string) {
  try {
    const rows = json?.tables?.[0]?.data;
    if (!rows?.[0]) return null;
    const row = rows.find((item: unknown[]) => item[0] === targetDate) || rows.at(-1);
    const index = parseNum(row[4]);
    const change = parseNum(row[5]);
    if (index <= 0) return null;
    const changePercent = index !== 0
      ? Number(((change / (index - change)) * 100).toFixed(2))
      : 0;
    return { index, change, changePercent };
  } catch {
    return null;
  }
}

export function parseTpexUpDown(json: any) {
  try {
    const data = json?.aaData?.[0];
    if (!data || data.length < 8) return null;
    const limitUp = Number.parseInt(String(data[4]?.replace(/,/g, "") || "0")) || 0;
    const totalUp = Number.parseInt(String(data[2]?.replace(/,/g, "") || "0")) || 0;
    const flat = Number.parseInt(String(data[6]?.replace(/,/g, "") || "0")) || 0;
    const totalDown = Number.parseInt(String(data[3]?.replace(/,/g, "") || "0")) || 0;
    const limitDown = Number.parseInt(String(data[5]?.replace(/,/g, "") || "0")) || 0;
    return {
      limitUp,
      up: Math.max(0, totalUp - limitUp),
      flat,
      down: Math.max(0, totalDown - limitDown),
      limitDown,
    };
  } catch {
    return null;
  }
}
