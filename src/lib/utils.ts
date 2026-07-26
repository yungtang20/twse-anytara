import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTaipeiTime(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
  const d = dayNames[date.getDay()];
  return `${yyyy}-${mm}-${dd} (${d}) ${hh}:${min}:${ss}`;
}

export function getMarketStatus(): boolean {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Taipei" }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // Sunday or Saturday
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const timeNum = hours * 100 + minutes;
  return timeNum >= 900 && timeNum <= 1330;
}

export function normalizeVolumes<T extends Record<string, any>>(data: T[], key: string = 'volume'): T[] {
  // Ponytail: 移除非平凡的統計猜測邏輯，避免誤傷爆量真實數據。資料單位應由來源或後端保證。
  return data;
}
