import React from "react";
import { MarketStat } from "../types";
import { cn } from "../lib/utils";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

interface StatCardProps extends MarketStat {
  className?: string;
}

export const StatCard: React.FC<StatCardProps> = ({ title, value, change, changePercent, className }) => {
  const isPositive = change >= 0;
  
  return (
    <div className={cn("bg-slate-900 border border-slate-800 rounded-xl p-3", className)}>
      <h3 className="text-sm font-medium text-slate-400 mb-1">{title}</h3>
      <div className="flex items-baseline justify-between">
        <span className="text-2xl font-bold tracking-tight text-white">{value}</span>
      </div>
      
      <div className={cn(
        "flex items-center gap-1 mt-2 text-sm font-medium",
        isPositive ? "text-emerald-400" : "text-rose-400"
      )}>
        {isPositive ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
        <span>{isPositive ? "+" : ""}{change.toFixed(2)}</span>
        <span className="opacity-80 ml-1">({isPositive ? "+" : ""}{changePercent.toFixed(2)}%)</span>
      </div>
    </div>
  );
}
