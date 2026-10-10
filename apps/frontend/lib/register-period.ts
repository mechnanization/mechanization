import { municipalToday } from '@mechanization/shared-schemas';

/**
 * The periods a money register is read by — «هذا الشهر», «الشهر الماضي»,
 * «هذه السنة», «السنة الماضية» — as two days on the municipality's calendar.
 *
 * A period select rather than two free date pickers, because these four are the
 * questions the register is opened with («كم وصلنا من الصندوق البلدي هذه
 * السنة؟»), and a select answers each in one choice. Both days are inclusive;
 * the server turns them into Beirut midnights.
 *
 * "Today" is `municipalToday`, never the browser's clock: a laptop set to UTC
 * would otherwise start October three hours late.
 */
export const REGISTER_PERIODS = ['thisMonth', 'lastMonth', 'thisYear', 'lastYear'] as const;
export type RegisterPeriod = (typeof REGISTER_PERIODS)[number];

/** The last day of a month, `YYYY-MM-DD`; `month` is 1-12. */
function lastDayOf(year: number, month: number): string {
  // Day 0 of the next month is the last day of this one.
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function registerPeriodRange(
  period: RegisterPeriod,
  today: string = municipalToday(),
): { from: string; to: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  switch (period) {
    case 'thisMonth':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'lastMonth': {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;
      return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: lastDayOf(y, m) };
    }
    case 'thisYear':
      return { from: `${year}-01-01`, to: today };
    case 'lastYear':
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
  }
}
