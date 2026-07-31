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
  const pivots = candidates.filter((point) => {
    if (point.index < pivotRadius) return false;
    const neighborStart = point.index - pivotRadius;
    const neighborEnd = Math.min(endIndex, point.index + pivotRadius);
    const neighbors = data
      .slice(neighborStart, neighborEnd + 1)
      .map((row, offset) => ({
        index: neighborStart + offset,
        value: Number(row[field]),
      }))
      .filter((neighbor) => (
        neighbor.index !== point.index
        && Number.isFinite(neighbor.value)
        && neighbor.value > 0
      ));
    if (neighbors.length < pivotRadius) return false;
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
  const pivotGroups: TrendAnchor[][] = [];
  for (const pivot of pivots) {
    const currentGroup = pivotGroups[pivotGroups.length - 1];
    const previousPivot = currentGroup?.[currentGroup.length - 1];
    if (previousPivot && pivot.index - previousPivot.index <= pivotRadius) {
      currentGroup.push(pivot);
    } else {
      pivotGroups.push([pivot]);
    }
  }
  const distinctPivots = pivotGroups.map((group) => [...group].sort(byPrice)[0]);
  if (distinctPivots.length < 2) return [];
  return distinctPivots.sort(byPrice).slice(0, 2);
}

export function selectEnvelopeAnchors(
  data: PriceData[],
  endIndex: number,
  period: number,
  field: PriceField,
  highest: boolean,
): TrendAnchor[] {
  const startIndex = Math.max(0, endIndex - period + 1);
  const points = data.slice(startIndex, endIndex + 1)
    .map((row, offset) => ({
      index: startIndex + offset,
      value: Number(row[field]),
    }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0);
  let best: { anchors: TrendAnchor[]; averageGap: number } | null = null;
  for (let firstIndex = 0; firstIndex < points.length - 1; firstIndex++) {
    for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex++) {
      const first = points[firstIndex];
      const second = points[secondIndex];
      const slope = (second.value - first.value) / (second.index - first.index);
      let totalGap = 0;
      let valid = true;
      for (const point of points) {
        const projected = first.value + slope * (point.index - first.index);
        const gap = highest ? projected - point.value : point.value - projected;
        if (gap < -1e-8) {
          valid = false;
          break;
        }
        totalGap += gap;
      }
      const averageGap = totalGap / points.length;
      if (valid && (!best || averageGap < best.averageGap - 1e-8)) {
        best = { anchors: [first, second], averageGap };
      }
    }
  }
  return best?.anchors ?? [];
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
      selectTrendAnchors(data, endIndex, 25, "high", true),
    ),
    shortSupport: extendedSeries(
      data.length,
      shortStartIndex,
      endIndex,
      selectTrendAnchors(data, endIndex, 25, "low", false),
    ),
    longResistance: extendedSeries(
      data.length,
      longStartIndex,
      endIndex,
      selectEnvelopeAnchors(data, endIndex, 60, "high", true),
    ),
    longSupport: extendedSeries(
      data.length,
      longStartIndex,
      endIndex,
      selectEnvelopeAnchors(data, endIndex, 60, "low", false),
    ),
  };
}
