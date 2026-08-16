import { useState, type FormEvent } from "react";
import { CheckCircle2, Eye, EyeOff, Key, Link2, RefreshCw, Save, Trash2 } from "lucide-react";
import { testAIProviderConnection } from "../../lib/api";
import {
  clearAIProviderOverride,
  loadAIProviderOverride,
  readHcnsecPrivacyAccepted,
  saveAIProviderOverride,
  setHcnsecPrivacyAccepted,
} from "../../lib/aiProviderSettings";

type Status = { kind: "success" | "error"; message: string } | null;

const inputClass = "mt-1 w-full rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5 font-mono text-sm text-slate-200 outline-none focus:border-blue-500";

export function SettingsView() {
  const initial = loadAIProviderOverride();
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial.apiKey ?? "");
  const [model, setModel] = useState(initial.model ?? "");
  const [privacyAccepted, setPrivacyAccepted] = useState(readHcnsecPrivacyAccepted);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const persist = () => {
    saveAIProviderOverride({ baseUrl, apiKey, model });
    setHcnsecPrivacyAccepted(privacyAccepted);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    persist();
    setStatus({ kind: "success", message: "個人 AI 設定已儲存於本次工作階段" });
  };

  const clear = () => {
    clearAIProviderOverride();
    setHcnsecPrivacyAccepted(false);
    setBaseUrl(""); setApiKey(""); setModel(""); setPrivacyAccepted(false);
    setStatus({ kind: "success", message: "已清除個人設定，將使用免費 HCNSEC" });
  };

  const test = async () => {
    persist();
    setTesting(true); setStatus(null);
    try {
      const result = await testAIProviderConnection();
      setStatus({ kind: "success", message: `連線成功，可用模型 ${result.modelCount} 個` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ai_provider_test_failed";
      setStatus({ kind: "error", message: `連線失敗：${message}` });
    } finally {
      setTesting(false);
    }
  };

  return <div className="mx-auto w-full max-w-3xl space-y-4 py-2" id="settings-view-container">
    <header className="text-center">
      <h2 className="text-2xl font-bold text-white">AI 連線設定</h2>
      <p className="mt-2 text-sm text-slate-400">
        欄位留空即使用免費 HCNSEC；個人設定只保存在目前分頁的 sessionStorage，關閉分頁後即清除。
      </p>
    </header>

    <form onSubmit={save} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 shadow-xl">
      <div className="rounded-xl border border-blue-500/25 bg-blue-500/5 p-3 text-sm text-blue-100">
        <p className="font-semibold">預設模式：免費 HCNSEC</p>
        <p className="mt-1 text-xs text-slate-400">Base URL、API Key、Model 都留空即可。伺服器端預設金鑰不會傳到瀏覽器。</p>
      </div>

      <label className="block text-sm text-slate-200" htmlFor="ai-provider-base-url">
        <span className="flex items-center gap-2"><Link2 size={16} />Base URL（選填）</span>
        <input id="ai-provider-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="例如 https://provider.example/v1" autoComplete="url" className={inputClass} />
      </label>

      <label className="block text-sm text-slate-200" htmlFor="ai-provider-key">
        <span className="flex items-center gap-2"><Key size={16} />API Key（選填）</span>
        <span className="relative block">
          <input id="ai-provider-key" type={showKey ? "text" : "password"} value={apiKey}
            onChange={(event) => setApiKey(event.target.value)} placeholder="使用個人供應商時填入"
            autoComplete="off" className={`${inputClass} pr-11`} />
          <button type="button" aria-label={showKey ? "隱藏 API Key" : "顯示 API Key"}
            onClick={() => setShowKey((value) => !value)}
            className="absolute right-3 top-1/2 mt-0.5 -translate-y-1/2 text-slate-500 hover:text-slate-200">
            {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        </span>
      </label>

      <label className="block text-sm text-slate-200" htmlFor="ai-provider-model">
        Model（選填）
        <input id="ai-provider-model" value={model} onChange={(event) => setModel(event.target.value)}
          placeholder="留空使用供應商預設模型" autoComplete="off" className={inputClass} />
      </label>

      <label className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-xs text-amber-100">
        <input type="checkbox" checked={privacyAccepted}
          onChange={(event) => setPrivacyAccepted(event.target.checked)} className="mt-0.5" />
        <span>我了解：HCNSEC 表示可能至少保留 180 天的請求時間、IP、裝置資料、提示內容與回應內容。我不會傳送個人資料、機密資訊、身分驗證資訊或未公開商業資訊，並同意將研究資料傳送給第三方 HCNSEC。</span>
      </label>

      <div className="grid gap-2 sm:grid-cols-3">
        <button type="submit" className="flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">
          <Save size={17} />儲存至本次工作階段
        </button>
        <button type="button" onClick={() => void test()} disabled={testing}
          className="flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 px-3 py-2.5 text-sm text-emerald-200 disabled:opacity-50">
          {testing ? <RefreshCw className="animate-spin" size={17} /> : <CheckCircle2 size={17} />}測試連線
        </button>
        <button type="button" onClick={clear}
          className="flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-3 py-2.5 text-sm text-slate-300 hover:bg-slate-800">
          <Trash2 size={17} />清除個人設定
        </button>
      </div>

      {status && <p role="status" className={`rounded-xl p-3 text-sm ${status.kind === "success"
        ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-200"}`}>{status.message}</p>}
    </form>
  </div>;
}
