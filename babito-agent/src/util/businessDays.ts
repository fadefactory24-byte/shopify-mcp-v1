/** Israeli business days (Sunday to Thursday) elapsed after `from`, up to and including `now`'s date. */
export function businessDaysSince(from: string | Date, now: Date = new Date()): number {
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) return 0;
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let n = 0;
  for (let t = day(start) + 86_400_000; t <= day(now); t += 86_400_000) {
    const wd = new Date(t).getUTCDay(); // 0 Sunday .. 6 Saturday
    if (wd <= 4) n++;
  }
  return n;
}
