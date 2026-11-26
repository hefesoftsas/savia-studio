import type { Exception, Period } from "./booking-types";

const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const maxWeeklyPeriods = 28;

export function validAvailabilityPeriods(periods: Exception["periods"]) {
  const sorted = [...periods].sort((a, b) => a.start.localeCompare(b.start));
  return sorted.every(
    ({ start, end }, index) =>
      clock.test(start) &&
      clock.test(end) &&
      Number(start.slice(3)) % 5 === 0 &&
      Number(end.slice(3)) % 5 === 0 &&
      start < end &&
      (!index || sorted[index - 1].end <= start),
  );
}

export function validWeeklyHours(
  weekly: Period[],
  maxPeriodsPerDay = maxWeeklyPeriods,
) {
  return (
    weekly.length <= maxWeeklyPeriods &&
    weekly.every(({ day }) => Number.isInteger(day) && day >= 0 && day < 7) &&
    Array.from({ length: 7 }, (_, day) =>
      weekly.filter((p) => p.day === day),
    ).every(
      (periods) =>
        periods.length <= maxPeriodsPerDay && validAvailabilityPeriods(periods),
    )
  );
}
