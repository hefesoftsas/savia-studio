const dayMilliseconds = 86400000;

function dayFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function calendarDate(formatter: Intl.DateTimeFormat, instant: Date | number) {
  const parts = formatter.formatToParts(instant);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year").padStart(4, "0")}-${value("month")}-${value("day")}`;
}

export function bookingDateInZone(instant: Date, timeZone: string): string {
  return calendarDate(dayFormatter(timeZone), instant);
}

export function bookingDayRange(date: string, timeZone: string) {
  const formatter = dayFormatter(timeZone);
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const nextMidnight = midnight + dayMilliseconds;
  return {
    from: dateBoundary(date, midnight, formatter),
    to: dateBoundary(
      new Date(nextMidnight).toISOString().slice(0, 10),
      nextMidnight,
      formatter,
    ),
  };
}

function dateBoundary(
  date: string,
  midnight: number,
  formatter: Intl.DateTimeFormat,
): Date {
  // Search for the date change so a missing local midnight still starts the day.
  let before = (midnight - dayMilliseconds * 2) / 1000;
  let after = (midnight + dayMilliseconds * 2) / 1000;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (calendarDate(formatter, middle * 1000) < date) before = middle;
    else after = middle;
  }
  return new Date(after * 1000);
}
