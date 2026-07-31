import type { PriceData } from "./indicators";

export interface SupportResistanceLines {
  shortResistance: Array<number | null>;
  shortSupport: Array<number | null>;
  longResistance: Array<number | null>;
  longSupport: Array<number | null>;
}

type PriceField = "high" | "low";

export interface TrendAnchor {
  index: number;
  value: number;
}

export function selectTrendAnchors(
  data: PriceData[],
  endIndex: number,
  period: number,
  field: PriceField,
  highest: boolean,
): TrendAnchor[] {
  const startIndex = Math.max(0, endIndex - period + 1);
  const candidates = data
    .slice(startIndex, endIndex + 1)
    .map((row, offset) => ({
      index: startIndex + offset,
      value: Number(row[field]),
    }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0);
  const pivotRadius = 2;
  const pivots = candidates.filter((point, candidateIndex) => {
    if (
      candidateIndex < pivotRadius
      || candidateIndex >= candidates.length - pivotRadius
    ) return false;
    const neighbors = candidates.slice(
      candidateIndex - pivotRadius,
      candidateIndex + pivotRadius + 1,
    );
    return neighbors.every((neighbor) => highest
      ? point.value >= neighbor.value
      : point.value <= neighbor.value);
  });
  const byPrice = (left: { index: number; value: number }, right: { index: number; value: number }) => {
      const priceOrder = highest
        ? right.value - left.value
        : left.value - right.value;
      return priceOrder || left.index - right.index;
  };
  if (pivots.length < 2) return [];
  return pivots.sort(byPrice).slice(0, 2);
}

function extendedSeries(
  length: number,
  endIndex: number,
  points: Array<{ index: number; value: number }>,
) {
  const series: Array<number | null> = Array(length).fill(null);
  if (points.length !== 2) return series;
  const [first, second] = [...points].sort((left, right) => left.index - right.index);
  if (first.index === second.index) return series;
  const slope = (second.value - first.value) / (second.index - first.index);
  for (let index = first.index; index <= endIndex; index++) {
    series[index] = first.value + slope * (index - first.index);
  }
  return series;
}

export function buildSupportResistanceLines(
  data: PriceData[],
  endIndex: number,
): SupportResistanceLines {
  return {
    shortResistance: extendedSeries(
      data.length,
      endIndex,
      selectTrendAnchors(data, endIndex, 25, "high", true),
    ),
    shortSupport: extendedSeries(
      data.length,
      endIndex,
      selectTrendAnchors(data, endIndex, 25, "low", false),
    ),
    longResistance: extendedSeries(
      data.length,
      endIndex,
      selectTrendAnchors(data, endIndex, 60, "high", true),
    ),
    longSupport: extendedSeries(
      data.length,
      endIndex,
      selectTrendAnchors(data, endIndex, 60, "low", false),
    ),
  };
}
