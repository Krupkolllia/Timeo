export function toISODate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeekMonday(date: Date): Date {
  const day = date.getDay(); // 0 = Sunday .. 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const result = new Date(date);
  result.setDate(date.getDate() + diffToMonday);
  return result;
}

/**
 * Полные недели (пн-вс), покрывающие [start, end] — сетка календаря дополняется
 * днями соседних периодов, чтобы не резать неделю посередине.
 */
export function buildWeeks(start: Date, end: Date): Date[][] {
  const gridStart = startOfWeekMonday(start);
  const gridEnd = startOfWeekMonday(end);
  gridEnd.setDate(gridEnd.getDate() + 6);

  const weeks: Date[][] = [];
  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}
