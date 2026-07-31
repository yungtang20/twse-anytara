export interface InstitutionalPoint {
  date: string;
  foreign_net: number;
  trust_net: number;
}

export interface ShareholdingPoint {
  date: string;
  ratio: number;
}

export interface IntegratedMarketPoint {
  date: string;
  foreign: number | null;
  trust: number | null;
  whaleRatio: number | null;
}

const toLots = (shares: number | undefined) =>
  Number.isFinite(shares) ? Math.round((shares || 0) / 1000) : null;

export function buildIntegratedMarketData(
  visibleDates: string[],
  institutional: InstitutionalPoint[],
  shareholding: ShareholdingPoint[],
): IntegratedMarketPoint[] {
  const institutionalByDate = new Map(
    institutional.map((row) => [row.date, row]),
  );
  const weeklyShareholding = [...shareholding].sort((a, b) =>
    a.date.localeCompare(b.date)
  );
  let shareholdingIndex = -1;

  return visibleDates.map((date) => {
    while (
      shareholdingIndex + 1 < weeklyShareholding.length
      && weeklyShareholding[shareholdingIndex + 1].date <= date
    ) {
      shareholdingIndex += 1;
    }
    const institutionalRow = institutionalByDate.get(date);
    const shareholdingRow = weeklyShareholding[shareholdingIndex];
    return {
      date,
      foreign: institutionalRow ? toLots(institutionalRow.foreign_net) : null,
      trust: institutionalRow ? toLots(institutionalRow.trust_net) : null,
      whaleRatio: shareholdingRow?.ratio ?? null,
    };
  });
}
