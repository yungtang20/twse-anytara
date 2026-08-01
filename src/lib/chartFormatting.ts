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

export function mondayTicks(dates: string[]): string[] {
  return dates.filter((date) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return false;
    const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
    return day === 1;
  });
}
