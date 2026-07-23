// Fallback helper to safely access env vars in both vite and node
const getEnv = (key: string) => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key];
  }
  if (typeof import.meta !== 'undefined' && (import.meta as any).env) {
    return (import.meta as any).env[key];
  }
  return undefined;
};

export const API_CONFIG = {
  FINMIND_BASE_URL: getEnv('VITE_FINMIND_BASE_URL') || getEnv('FINMIND_BASE_URL') || "https://api.finmindtrade.com/api/v4/data",
  LONGCAT_BASE_URL: getEnv('VITE_LONGCAT_BASE_URL') || getEnv('LONGCAT_BASE_URL') || "https://api.longcat.chat/openai/v1",
  TWSE_BASE_URL: getEnv('VITE_TWSE_BASE_URL') || getEnv('TWSE_BASE_URL') || "https://www.twse.com.tw",
  TPEX_BASE_URL: getEnv('VITE_TPEX_BASE_URL') || getEnv('TPEX_BASE_URL') || "https://www.tpex.org.tw/web"
};
