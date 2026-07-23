import { Bell, Search } from "lucide-react";

export function Header() {
  return (
    <header className="h-16 bg-slate-900 border-b border-slate-800 px-6 flex items-center justify-between sticky top-0 z-10">
      <div className="flex items-center gap-4 text-sm text-slate-400">
      </div>

      <div className="flex items-center gap-6">
        <div className="relative hidden sm:block">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input 
            type="text" 
            placeholder="搜尋股票代號或名稱..." 
            className="w-64 bg-slate-800/50 border border-slate-700/50 rounded-full pl-9 pr-4 py-1.5 text-sm outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all text-slate-200 placeholder:text-slate-500"
          />
        </div>
        <button className="text-slate-400 hover:text-slate-200 transition-colors relative">
          <Bell size={20} />
          <span className="absolute top-0 right-0 w-2 h-2 bg-blue-500 rounded-full border-2 border-slate-900"></span>
        </button>
        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 border border-slate-700 flex items-center justify-center text-sm font-medium text-white shadow-sm overflow-hidden">
          A
        </div>
      </div>
    </header>
  );
}
