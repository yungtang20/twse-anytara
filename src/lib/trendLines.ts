import type { PriceData } from "./indicators";

export interface SupportResistanceLines {
  shortResistance: Array<number | null>;
  shortSupport: Array<number | null>;
  longResistance: Array<number | null>;
  longSupport: Array<number | null>;
}

type PriceField = "high" | "low";

function extremePoints(
  data: PriceData[],
  endIndex: number,
  period: number,
  field: PriceField,
  highest: boolean,
) {
  const startIndex = Math.max(0, endIndex - period + 1);
  const candidates = data
    .slice(startIndex, endIndex + 1)
    .map((row, offset) => ({
      index: startIndex + offset,
      value: Number(row[field]),
    }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0);
  const byPrice = (left: { index: number; value: number }, right: { index: number; value: number }) => {
      const priceOrder = highest
        ? right.value - left.value
        : left.value - right.value;
      return priceOrder || left.index - right.index;
  };
  return candidates.sort(byPrice).slice(0, 2);
}

function extendedSeries(
  length: number,
  startIndex: number,
  endIndex: number,
  points: Array<{ index: number; value: number }>,
) {
  const series: Array<number | null> = Array(length).fill(null);
  if (points.length !== 2) return series;
  const [first, second] = [...points].sort((left, right) => left.index - right.index);
  if (first.index === second.index) return series;
  const slope = (second.value - first.value) / (second.index - first.index);
  for (let index = startIndex; index <= endIndex; index++) {
    series[index] = first.value + slope * (index - first.index);
  }
  return series;
}

export function buildSupportResistanceLines(
  data: PriceData[],
  endIndex: number,
): SupportResistanceLines {
  const shortStartIndex = Math.max(0, endIndex - 25 + 1);
  const longStartIndex = Math.max(0, endIndex - 60 + 1);
  return {
    shortResistance: extendedSeries(
      data.length,
      shortStartIndex,
      endIndex,
      extremePoints(data, endIndex, 25, "high", true),
    ),
    shortSupport: extendedSeries(
      data.length,
      shortStartIndex,
      endIndex,
      extremePoints(data, endIndex, 25, "low", false),
    ),
    longResistance: extendedSeries(
      data.length,
      longStartIndex,
      endIndex,
      extremePoints(data, endIndex, 60, "high", true),
    ),
    longSupport: extendedSeries(
      data.length,
      longStartIndex,
      endIndex,
      extremePoints(data, endIndex, 60, "low", false),
    ),
  };
}
