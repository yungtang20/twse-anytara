import { ArrowUpRight, ArrowDownRight, Clock } from "lucide-react";
import { cn } from "../lib/utils";

const movers = [
  { symbol: "2330.TW", name: "台積電", price: 820.0, change: 15.0, changePercent: 1.86 },
  { symbol: "2317.TW", name: "鴻海", price:  150.5, change: 3.5, changePercent: 2.38 },
  { symbol: "2454.TW", name: "聯發科", price: 1120.0, change: -25.0, changePercent: -2.18 },
  { symbol: "2382.TW", name: "廣達", price: 285.0, change: 12.5, changePercent: 4.58 },
  { symbol: "2308.TW", name: "台達電", price: 345.0, change: 8.0, changePercent: 2.37 }
];

export function MoversList({ className }: { className?: string }) {
  return (
    <div className={cn("bg-slate-900 border border-slate-800 rounded-xl overflow-hidden flex flex-col", className)}>
      <div className="p-5 border-b border-slate-800 flex items-center justify-between">
        <h3 className="text-base font-semibold text-white tracking-tight">熱門動能股</h3>
        <span className="text-xs font-medium px-2.5 py-1 bg-slate-800 text-slate-400 rounded-md flex items-center gap-1.5">
          <Clock size={12} />
          成交量排行
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-sm whitespace-nowrap">
          <thead className="bg-slate-900/50 text-slate-400 sticky top-0 border-b border-slate-800">
            <tr>
              <th className="px-5 py-3 font-medium">代號</th>
              <th className="px-5 py-3 font-medium text-right">股價</th>
              <th className="px-5 py-3 font-medium text-right">漲跌</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {movers.map((mover) => {
              const isPositive = mover.change >= 0;
              return (
                <tr key={mover.symbol} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="font-medium text-slate-200">{mover.symbol}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{mover.name}</div>
                  </td>
                  <td className="px-5 py-3.5 text-right font-mono font-medium text-slate-200">
                    {mover.price.toFixed(1)}
                  </td>
                  <td className="px-5 py-3.5 text-right">
                    <div className={cn(
                      "inline-flex items-center justify-end gap-1 font-medium font-mono",
                      isPositive ? "text-emerald-400" : "text-rose-400"
                    )}>
                      {isPositive ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                      {isPositive ? "+" : ""}{mover.changePercent.toFixed(2)}%
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
