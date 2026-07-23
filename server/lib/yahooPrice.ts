export async function scrapePriceFromYahoo(stockId: string, startDate: string, endDate?: string, market?: string): Promise<any[]> {
  const p1 = Math.floor(new Date(startDate).getTime() / 1000);
  const p2 = Math.floor((endDate ? new Date(endDate) : new Date()).getTime() / 1000) + 86400;
  
  const suffix = (market === "OTC" || market === "TPEX" || market === "two") ? ".TWO" : ".TW";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${stockId}${suffix}?period1=${p1}&period2=${p2}&interval=1d`;
  const headers = { "User-Agent": "Mozilla/5.0" };
  
  let res = await fetch(url, { headers });
  if (!res.ok) {
    const altSuffix = suffix === ".TW" ? ".TWO" : ".TW";
    res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${stockId}${altSuffix}?period1=${p1}&period2=${p2}&interval=1d`, { headers });
  }
  if (!res.ok) return [];

  const json = await res.json() as any;
  const result = json?.chart?.result?.[0];
  if (!result) return [];

  const t = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];

  const data: any[] = [];
  for (let i = 0; i < t.length; i++) {
    const date = new Date(t[i] * 1000).toISOString().split("T")[0];
    const open = q.open?.[i];
    const close = q.close?.[i];
    if (open == null || close == null) continue;
    
    data.push({
      date,
      open: Number(open.toFixed(2)),
      high: Number((q.high?.[i] ?? open).toFixed(2)),
      low: Number((q.low?.[i] ?? open).toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Math.round(q.volume?.[i] || 0),
      amount: Math.round((q.volume?.[i] || 0) * close),
      trade_count: 0,
      spread: 0,
      adj_close: adj[i] ? Number(adj[i].toFixed(2)) : Number(close.toFixed(2))
    });
  }
  return data;
}

