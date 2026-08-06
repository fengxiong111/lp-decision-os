import type { LastSwap, MarketSession, SessionState } from "@/packages/models/src";

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number };

const nyZone = "America/New_York";
const beijingZone = "Asia/Shanghai";

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month"), day: value("day"), hour: value("hour"), minute: value("minute") };
}

function dateKey(parts: ZonedParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function observedFixedHoliday(year: number, month: number, day: number): Date {
  const date = utcDate(year, month, day);
  const weekday = date.getUTCDay();
  if (weekday === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (weekday === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

function nthWeekday(year: number, month: number, weekday: number, nth: number): Date {
  const date = utcDate(year, month, 1);
  const offset = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + offset + (nth - 1) * 7);
  return date;
}

function lastWeekday(year: number, month: number, weekday: number): Date {
  const date = new Date(Date.UTC(year, month, 0));
  const offset = (date.getUTCDay() - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date;
}

function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

function holidaysForYear(year: number): Map<string, string> {
  const holidays = new Map<string, string>();
  const add = (date: Date, name: string) => {
    holidays.set(date.toISOString().slice(0, 10), name);
  };
  add(observedFixedHoliday(year, 1, 1), "新年");
  add(nthWeekday(year, 1, 1, 3), "马丁·路德·金纪念日");
  add(nthWeekday(year, 2, 1, 3), "总统日");
  const goodFriday = easterSunday(year);
  goodFriday.setUTCDate(goodFriday.getUTCDate() - 2);
  add(goodFriday, "耶稣受难日");
  add(lastWeekday(year, 5, 1), "阵亡将士纪念日");
  add(observedFixedHoliday(year, 6, 19), "六月节");
  add(observedFixedHoliday(year, 7, 4), "独立日");
  add(nthWeekday(year, 9, 1, 1), "劳动节");
  add(nthWeekday(year, 11, 4, 4), "感恩节");
  add(observedFixedHoliday(year, 12, 25), "圣诞节");
  return holidays;
}

function earlyCloseForDate(parts: ZonedParts): number | null {
  const date = utcDate(parts.year, parts.month, parts.day);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  if (parts.month === 11 && weekday === 5 && parts.day >= 23 && parts.day <= 29) return 13 * 60;
  if (parts.month === 7 && (parts.day === 3 || parts.day === 5)) return 13 * 60;
  if (parts.month === 12 && parts.day === 24) return 13 * 60;
  return null;
}

function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function zonedDateForLocal(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const targetCalendarMinutes = Date.UTC(year, month - 1, day, hour, minute) / 60_000;
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const actual = zonedParts(guess, timeZone);
  const actualCalendarMinutes = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute) / 60_000;
  return new Date(guess.getTime() + (targetCalendarMinutes - actualCalendarMinutes) * 60_000);
}

function findNextOpen(now: Date): Date | null {
  for (let offset = 0; offset <= 14; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const parts = zonedParts(candidate, nyZone);
    const weekday = utcDate(parts.year, parts.month, parts.day).getUTCDay();
    const holiday = holidaysForYear(parts.year).has(dateKey(parts));
    if (weekday === 0 || weekday === 6 || holiday) continue;
    const currentMinute = parts.hour * 60 + parts.minute;
    if (offset === 0 && currentMinute >= 9 * 60 + 30) {
      continue;
    }
    return zonedDateForLocal(parts.year, parts.month, parts.day, 9, 30, nyZone);
  }
  return null;
}

export function getMarketSession(now = new Date(), lastSwap: LastSwap | null = null): MarketSession {
  const ny = zonedParts(now, nyZone);
  const weekday = utcDate(ny.year, ny.month, ny.day).getUTCDay();
  const holidayName = holidaysForYear(ny.year).get(dateKey(ny)) ?? null;
  const minute = ny.hour * 60 + ny.minute;
  const earlyClose = holidayName === null ? earlyCloseForDate(ny) : null;
  const tradingDay = weekday !== 0 && weekday !== 6 && holidayName === null;
  let state: SessionState;
  if (weekday === 0 || weekday === 6) state = "周末";
  else if (holidayName) state = "假日休市";
  else if (earlyClose !== null && minute >= earlyClose && minute < 20 * 60) state = "提前收市";
  else if (minute >= 4 * 60 && minute < 9 * 60 + 30) state = "盘前";
  else if (minute >= 9 * 60 + 30 && minute < (earlyClose ?? 16 * 60)) state = "盘中";
  else if (minute >= (earlyClose ?? 16 * 60) && minute < 20 * 60) state = "盘后";
  else state = "隔夜休市";

  const nextOpen = findNextOpen(now);
  const minutesToNextOpen = nextOpen === null ? null : Math.max(0, Math.round((nextOpen.getTime() - now.getTime()) / 60_000));
  const referenceAgeSeconds = lastSwap?.blockTime ? Math.max(0, Math.round((now.getTime() - new Date(lastSwap.blockTime).getTime()) / 1000)) : null;
  const chainActivity = referenceAgeSeconds === null ? "等待参考价格样本" : referenceAgeSeconds <= 120 ? "正常" : referenceAgeSeconds <= 1800 ? "低活跃" : "等待参考价格样本";
  const confidenceAdjustment = state === "盘中" ? 0 : state === "盘前" || state === "盘后" ? -7 : -15;

  return {
    state,
    nyTime: formatDate(now, nyZone),
    beijingTime: formatDate(now, beijingZone),
    nextOpen: nextOpen ? formatDate(nextOpen, nyZone) : null,
    minutesToNextOpen,
    isTradingDay: tradingDay,
    confidenceAdjustment,
    chainActivity,
    referenceAgeSeconds,
    holidayName,
  };
}
