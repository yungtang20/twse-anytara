import type { PriceData } from "./indicators";

export interface SupportResistanceLines {
  shortResistance: Array<number | null>;
  shortSupport: Array<number | null>;
  longResistance: Array<number | null>;
  longSupport: Array<number | null>;
}

type PriceField = "high" | "low" | "close";

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
    const containsStrictExtreme = neighbors.some((neighbor) => highest
      ? point.value > neighbor.value
      : point.value < neighbor.value);
    return containsStrictExtreme && neighbors.every((neighbor) => highest
      ? point.value >= neighbor.value
      : point.value <= neighbor.value);
  });
  const byPrice = (left: TrendAnchor, right: TrendAnchor) => {
    const priceOrder = highest
      ? right.value - left.value
      : left.value - right.value;
    return priceOrder || right.index - left.index;
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
  return distinctPivots
    .sort((left, right) => right.index - left.index)
    .slice(0, 2)
    .map((anchor) => ({ ...anchor }));
}

export function selectExtremeAnchors(
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
    .filter((anchor) => Number.isFinite(anchor.value) && anchor.value > 0);
  const pivotRadius = 2;
  const pivots = candidates.filter((point) => {
    const neighbors = candidates.filter((candidate) => (
      candidate.index !== point.index
      && Math.abs(candidate.index - point.index) <= pivotRadius
    ));
    if (neighbors.length < pivotRadius) return false;
    return neighbors.every((neighbor) => highest
      ? point.value >= neighbor.value
      : point.value <= neighbor.value);
  });
  const rankedPivots = pivots
    .sort((left, right) => {
      const priceOrder = highest
        ? right.value - left.value
        : left.value - right.value;
      return priceOrder || right.index - left.index;
    })
    .filter((point, index, ranked) => (
      ranked.findIndex((candidate) => (
        Math.abs(candidate.index - point.index) <= pivotRadius
      )) === index
    ));
  const selected = rankedPivots.length >= 2 ? rankedPivots : candidates.sort(
    (left, right) => (highest
      ? right.value - left.value
      : left.value - right.value) || right.index - left.index,
  );
  return selected.slice(0, 2)
    .sort((left, right) => right.index - left.index);
}

function extendedBoundarySeries(
  data: PriceData[],
  startIndex: number,
  endIndex: number,
  field: PriceField,
  highest: boolean,
  anchors: TrendAnchor[],
) {
  const series = extendedSeries(data.length, startIndex, endIndex, anchors);
  let adjustment = 0;
  for (let index = startIndex; index <= endIndex; index++) {
    const projected = series[index];
    const value = Number(data[index]?.[field]);
    if (projected === null || !Number.isFinite(value) || value <= 0) continue;
    const difference = value - projected;
    adjustment = highest
      ? Math.max(adjustment, difference)
      : Math.min(adjustment, difference);
  }
  if (adjustment === 0) return series;
  return series.map((value) => value === null ? null : value + adjustment);
}

function adjustOlderAnchor(
  data: PriceData[],
  startIndex: number,
  endIndex: number,
  field: PriceField,
  highest: boolean,
  anchors: TrendAnchor[],
): TrendAnchor[] {
  if (anchors.length !== 2) return [];
  let [newer, older] = anchors;
  const maxCorrections = (endIndex - startIndex + 1) * 2;
  for (let correction = 0; correction < maxCorrections; correction++) {
    let boundaryBreak: TrendAnchor | null = null;
    for (let index = endIndex; index >= startIndex; index--) {
      if (index === newer.index || index === older.index) continue;
      const value = Number(data[index]?.[field]);
      if (!Number.isFinite(value) || value <= 0) continue;
      const slope = (newer.value - older.value) / (newer.index - older.index);
      const projected = older.value + slope * (index - older.index);
      if (highest ? value > projected : value < projected) {
        boundaryBreak = { index, value };
        break;
      }
    }
    if (!boundaryBreak) break;
    if (boundaryBreak.index > newer.index) newer = boundaryBreak;
    else older = boundaryBreak;
  }
  return [newer, older];
}

function extendedSeries(
  length: number,
  startIndex: number,
  endIndex: number,
  anchors: TrendAnchor[],
) {
  const series: Array<number | null> = Array(length).fill(null);
  if (anchors.length !== 2) return series;
  const [newer, older] = anchors;
  if (newer.index === older.index) return series;
  const slope = (newer.value - older.value) / (newer.index - older.index);
  for (let index = startIndex; index <= endIndex; index++) {
    series[index] = older.value + slope * (index - older.index);
  }
  return series;
}

export function buildSupportResistanceLines(
  data: PriceData[],
  endIndex: number,
): SupportResistanceLines {
  const shortStartIndex = Math.max(0, endIndex - 25 + 1);
  const longStartIndex = Math.max(0, endIndex - 60 + 1);
  const shortResistanceAnchors = adjustOlderAnchor(
    data,
    shortStartIndex,
    endIndex,
    "high",
    true,
    selectTrendAnchors(data, endIndex, 25, "high", true),
  );
  const shortSupportAnchors = adjustOlderAnchor(
    data,
    shortStartIndex,
    endIndex,
    "low",
    false,
    selectTrendAnchors(data, endIndex, 25, "low", false),
  );
  const longResistanceAnchors = selectExtremeAnchors(
    data, endIndex, 60, "close", true,
  );
  const longSupportAnchors = selectExtremeAnchors(
    data, endIndex, 60, "close", false,
  );
  return {
    shortResistance: extendedSeries(
      data.length,
      shortStartIndex,
      endIndex,
      shortResistanceAnchors,
    ),
    shortSupport: extendedSeries(
      data.length,
      shortStartIndex,
      endIndex,
      shortSupportAnchors,
    ),
    longResistance: extendedBoundarySeries(
      data,
      longStartIndex,
      endIndex,
      "close",
      true,
      longResistanceAnchors,
    ),
    longSupport: extendedBoundarySeries(
      data,
      longStartIndex,
      endIndex,
      "close",
      false,
      longSupportAnchors,
    ),
  };
}
