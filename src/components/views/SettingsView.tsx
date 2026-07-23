import React, { useState, useEffect } from 'react';
import { Key, Eye, EyeOff, Save, CheckCircle2, Shield, Server, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export function SettingsView() {
  const [finmindApiKey, setFinmindApiKey] = useState('');
  const [longcatApiKey, setLongcatApiKey] = useState('');
  const [longcatBaseUrl, setLongcatBaseUrl] = useState('');
  const [longcatModel, setLongcatModel] = useState('');
  const [hasFinmindKey, setHasFinmindKey] = useState(false);
  const [hasLongcatKey, setHasLongcatKey] = useState(false);

  const [showFinmind, setShowFinmind] = useState(false);
  const [showLongcat, setShowLongcat] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    fetchCurrentSettings();
  }, []);

  const fetchCurrentSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        setHasFinmindKey(Boolean(data.hasFinmindKey));
        setHasLongcatKey(Boolean(data.hasLongcatKey));
        setLongcatBaseUrl('https://api.longcat.chat');
        setLongcatModel(data.longcatModel || '');
      }
    } catch (error) {
      console.error('Fetch settings error:', error);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveStatus('idle');

    try {
      const body: Record<string, string> = {
        longcatBaseUrl: longcatBaseUrl || 'https://api.longcat.chat',
        longcatModel: longcatModel || 'LongCat-2.0',
      };
      if (finmindApiKey.trim()) body.finmindApiKey = finmindApiKey.trim();
      if (longcatApiKey.trim()) body.longcatApiKey = longcatApiKey.trim();

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error('儲存設定失敗');
      
      setSaveStatus('success');
      setFinmindApiKey('');
      setLongcatApiKey('');
      await fetchCurrentSettings();
    } catch (error) {
      console.error('Save settings failed:', error);
      setSaveStatus('error');
    } finally {
      setIsSaving(false);
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto py-2 px-1" id="settings-view-container">
      <div className="mb-3 text-center">
        <h2 className="text-2xl font-bold text-white tracking-tight mb-2">系統 API 金鑰設定</h2>
        <p className="text-slate-400 text-sm">
          金鑰只會寫入本機 .env，伺服器不會再把明文金鑰回傳到瀏覽器或存進 Supabase。
        </p>
      </div>

      <form onSubmit={handleSaveSettings} className="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-3 md:p-4 space-y-3 backdrop-blur-md shadow-xl" id="settings-form">
        <div className="space-y-3">
          {/* Finmind API Key */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label className="text-sm font-medium text-slate-200 flex items-center gap-2">
                <Key size={16} className="text-blue-400" />
                FinMind API Token {hasFinmindKey && <span className="text-emerald-400 text-xs">（已設定）</span>}
              </label>
              <a 
                href="https://finmindtrade.com/" 
                target="_blank" 
                referrerPolicy="no-referrer"
                className="text-xs text-blue-400 hover:underline"
              >
                獲取 Token
              </a>
            </div>
            <div className="relative">
              <input 
                id="finmind-key-input"
                type={showFinmind ? "text" : "password"} 
                value={finmindApiKey}
                onChange={(e) => setFinmindApiKey(e.target.value)}
                placeholder={hasFinmindKey ? "留空以保留現有金鑰" : "請輸入 FinMind API 金鑰"}
                className="w-full bg-slate-950/80 border border-slate-800 rounded-xl pl-3 pr-10 py-2 text-sm text-slate-300 font-mono focus:outline-none focus:border-blue-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowFinmind(!showFinmind)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showFinmind ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              用於抓取台灣股市日K線、三大法人籌碼、融資融券等公開歷史數據。
            </p>
          </div>

          {/* Longcat API Key */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label className="text-sm font-medium text-slate-200 flex items-center gap-2">
                <Key size={16} className="text-indigo-400" />
                LongCat API Key {hasLongcatKey && <span className="text-emerald-400 text-xs">（已設定）</span>}
              </label>
              <a 
                href="https://longcat.chat/" 
                target="_blank" 
                referrerPolicy="no-referrer"
                className="text-xs text-indigo-400 hover:underline"
              >
                獲取 API Key
              </a>
            </div>
            <div className="relative">
              <input 
                id="longcat-key-input"
                type={showLongcat ? "text" : "password"} 
                value={longcatApiKey}
                onChange={(e) => setLongcatApiKey(e.target.value)}
                placeholder={hasLongcatKey ? "留空以保留現有金鑰" : "請輸入 LongCat API 金鑰"}
                className="w-full bg-slate-950/80 border border-slate-800 rounded-xl pl-3 pr-10 py-2 text-sm text-slate-300 font-mono focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowLongcat(!showLongcat)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showLongcat ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <p className="text-xs text-slate-500">
              用於驅動多投行與波克夏董事會大師級框架，生成數萬字深度分析報告。
            </p>
          </div>

          {/* 高級折疊設定 */}
          <div className="pt-2 border-t border-slate-800/40">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-slate-400 hover:text-white transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <span>{showAdvanced ? '[-] 隱藏進階 AI 路由設定' : '[+] 顯示進階 AI 路由設定'}</span>
            </button>

            {showAdvanced && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="space-y-3 mt-3 pt-1"
              >
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                    <Server size={12} />
                    LongCat Base URL
                  </label>
                  <input
                    type="text"
                    value={longcatBaseUrl}
                    onChange={(e) => setLongcatBaseUrl(e.target.value)}
                    placeholder="https://api.longcat.chat"
                    className="w-full bg-slate-950/40 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 font-mono focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                    <Sparkles size={12} />
                    LongCat Model
                  </label>
                  <input
                    type="text"
                    value={longcatModel}
                    onChange={(e) => setLongcatModel(e.target.value)}
                    placeholder="LongCat-2.0"
                    className="w-full bg-slate-950/40 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-300 font-mono focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
              </motion.div>
            )}
          </div>
        </div>

        <div className="pt-2">
          <button 
            type="submit"
            disabled={isSaving}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-medium py-2 rounded-xl flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-600/15 cursor-pointer hover:-translate-y-0.5 active:translate-y-0"
          >
            {isSaving ? (
              <>
                <RefreshCw className="animate-spin" size={18} />
                <span>儲存中...</span>
              </>
            ) : (
              <>
                <Save size={18} />
                <span>儲存金鑰設定</span>
              </>
            )}
          </button>

          <AnimatePresence>
            {saveStatus === 'success' && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-2 text-emerald-400 text-sm justify-center"
              >
                <CheckCircle2 size={16} />
                金鑰已成功儲存！報告引擎已就緒。
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </form>
    </div>
  );
}

// 為了維持與可能有的舊代碼兼容，重新導入 RefreshCw 避免 TypeScript 未使用錯誤
import { RefreshCw } from 'lucide-react';
