type SupabaseError = { code?: unknown; message?: unknown };

export function describeSupabaseError(error: SupabaseError, supabaseUrl = "") {
  const code = typeof error?.code === "string" ? error.code : null;
  const rawMessage = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : "Supabase 未提供錯誤訊息";

  if (code === "PGRST002" || rawMessage.includes("schema cache")) {
    const projectRef = (() => {
      try { return new URL(supabaseUrl).hostname.split(".")[0] || null; }
      catch { return null; }
    })();
    return {
      code: "PGRST002",
      message: "Supabase Data API 無法建立 schema cache；這不是 URL 或 anon key 格式錯誤。",
      dashboardUrl: projectRef
        ? `https://supabase.com/dashboard/project/${projectRef}/integrations/data_api/overview`
        : null,
      steps: [
        "登入 Supabase Dashboard 的 Data API 設定。",
        "確認 Exposed schemas 只包含資料庫中實際存在的 schema，移除已刪除的項目後儲存。",
        "若 schema 必須保留，先在 SQL Editor 暫時重建它，再修正 Exposed schemas。",
        "設定修正後在 SQL Editor 執行 NOTIFY pgrst, 'reload schema';。",
      ],
    };
  }

  return { code, message: `連線失敗: ${rawMessage}` };
}
