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

function backwardEnvelopeSeries(
  data: PriceData[],
  endIndex: number,
  period: number,
  field: PriceField,
  highest: boolean,
) {
  const startIndex = Math.max(0, endIndex - period + 1);
  const points = data.slice(startIndex, endIndex + 1)
    .map((row, offset) => ({
      index: startIndex + offset,
      high: Number(row.high),
      low: Number(row.low),
    }))
    .filter((point) => (
      Number.isFinite(point.high)
      && Number.isFinite(point.low)
      && point.high > 0
      && point.low > 0
    ));
  const series: Array<number | null> = Array(data.length).fill(null);
  if (points.length < 2) return series;

  const meanIndex = points.reduce((sum, point) => sum + point.index, 0) / points.length;
  const meanMidpoint = points.reduce(
    (sum, point) => sum + (point.high + point.low) / 2,
    0,
  ) / points.length;
  const denominator = points.reduce(
    (sum, point) => sum + (point.index - meanIndex) ** 2,
    0,
  );
  const slope = denominator === 0
    ? 0
    : points.reduce(
      (sum, point) => sum
        + (point.index - meanIndex)
        * (((point.high + point.low) / 2) - meanMidpoint),
      0,
    ) / denominator;
  const intercept = meanMidpoint - slope * meanIndex;

  // The active window is anchored at its newest candle. Walk backwards so an
  // older high/low can only push the corresponding boundary outwards.
  let correction = highest ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (let position = points.length - 1; position >= 0; position--) {
    const point = points[position];
    const residual = point[field] - (intercept + slope * point.index);
    correction = highest
      ? Math.max(correction, residual)
      : Math.min(correction, residual);
  }
  for (let index = startIndex; index <= endIndex; index++) {
    series[index] = intercept + slope * index + correction;
  }
  return series;
}

export function buildSupportResistanceLines(
  data: PriceData[],
  endIndex: number,
): SupportResistanceLines {
  return {
    shortResistance: backwardEnvelopeSeries(data, endIndex, 25, "high", true),
    shortSupport: backwardEnvelopeSeries(data, endIndex, 25, "low", false),
    longResistance: backwardEnvelopeSeries(data, endIndex, 60, "high", true),
    longSupport: backwardEnvelopeSeries(data, endIndex, 60, "low", false),
  };
}
