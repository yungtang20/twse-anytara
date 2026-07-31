export function formatPriceAxisTick(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(2);
}

export function formatTrendLegendLabel(
  label: string,
  value: number | null | undefined,
): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${label} ${formatPriceAxisTick(value)}`
    : label;
}
