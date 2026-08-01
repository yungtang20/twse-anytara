import OpenAI from "openai";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NVIDIA_MODEL = "z-ai/glm-5.2";

export interface NvidiaReportRequest {
  system: string;
  user: string;
}

export function hasNvidiaApiKey() {
  return Boolean((process.env.NVIDIA_API_KEY || "").trim());
}

export function nvidiaModel() {
  return (process.env.NVIDIA_MODEL || DEFAULT_NVIDIA_MODEL).trim();
}

export async function generateNvidiaReport(
  request: NvidiaReportRequest,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = (process.env.NVIDIA_API_KEY || "").trim();
  if (!apiKey) throw new Error("未設定 NVIDIA_API_KEY");
  const client = new OpenAI({ apiKey, baseURL: NVIDIA_BASE_URL, timeout: 300_000, maxRetries: 1 });
  const stream = await client.chat.completions.create({
    model: nvidiaModel(),
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
    temperature: 1,
    top_p: 1,
    max_tokens: 16_384,
    seed: 42,
    stream: true,
  }, { signal });
  let report = "";
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    report += chunk.choices[0]?.delta?.content || "";
  }
  if (!report.trim()) throw new Error("NVIDIA GLM-5.2 回傳空內容");
  return report;
}
