const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseIsoDate(value: string): Date {
  if (!ISO_DATE.test(value)) throw new Error(`Invalid ISO date: ${value}`);
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO date: ${value}`);
  return date;
}

function formatIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function listPendingCalendarDates(
  latestDate: string | null,
  todayDate: string,
  maxDays: number = 14,
): string[] {
  if (!Number.isInteger(maxDays) || maxDays < 1 || maxDays > 90) {
    throw new Error("maxDays must be an integer between 1 and 90");
  }

  const today = parseIsoDate(todayDate);
  const start = latestDate
    ? new Date(parseIsoDate(latestDate).getTime() + 86_400_000)
    : new Date(today.getTime() - (maxDays - 1) * 86_400_000);
  if (start > today) return [];

  const dayCount = Math.floor((today.getTime() - start.getTime()) / 86_400_000) + 1;
  if (dayCount > maxDays) {
    throw new Error(`Supabase is ${dayCount} calendar days behind; max catch-up is ${maxDays}`);
  }

  return Array.from({ length: dayCount }, (_, index) =>
    formatIsoDate(new Date(start.getTime() + index * 86_400_000))
  );
}
