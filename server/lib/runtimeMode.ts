export type RuntimeMode = "cloud" | "test";

export function resolveRuntimeMode(value = process.env.MARKET_DATA_MODE): RuntimeMode {
  const mode = value?.trim().toLowerCase() || "cloud";
  if (mode === "cloud" || mode === "test") return mode;
  throw new Error(`Invalid MARKET_DATA_MODE: ${value}. Expected "cloud" or "test".`);
}
