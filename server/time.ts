import { DateTime } from 'luxon';
import * as chrono from 'chrono-node';

export type DateWindow = { start: string; end: string; label: string };
export type TimeContext = { now: string; timezone: string; windows: DateWindow[]; warning?: string };
const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function timeContext(text: string, timezone: string, instant = new Date()): TimeContext {
  const now = DateTime.fromJSDate(instant, { zone: timezone });
  if (!now.isValid) throw new Error('Invalid timezone');
  const context: TimeContext = { now: now.toISO()!, timezone, windows: [] };
  const window = (date: DateTime, month = false): DateWindow => ({
    start: date.startOf(month ? 'month' : 'day').toUTC().toISO()!,
    end: date.startOf(month ? 'month' : 'day').plus(month ? { months: 1 } : { days: 1 }).toUTC().toISO()!,
    label: date.toFormat(month ? 'LLLL yyyy' : 'cccc, d LLLL yyyy'),
  });
  // Prefer an explicit calendar date to a weekday; validate both if supplied.
  const dated = /\b\d{4}-\d{2}-\d{2}\b|\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)|(?:jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+\d{1,2}(?:st|nd|rd|th)?)(?:,?\s+\d{4})?\b/i.exec(text);
  const weekday = /\b(last\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.exec(text);
  if (dated) {
    const parsed = chrono.parse(dated[0], { instant, timezone: now.offset })[0];
    if (!parsed) return context;
    const yearKnown = parsed.start.isCertain('year');
    let date = DateTime.fromObject({ year: parsed.start.get('year')!, month: parsed.start.get('month')!, day: parsed.start.get('day')! }, { zone: timezone });
    if (!yearKnown && date.startOf('day') > now) date = date.minus({ years: 1 });
    if (!date.isValid) { context.warning = 'The supplied calendar date is invalid. Ask for a correction.'; return context; }
    context.windows = [window(date)];
    // Query prior years too; history, rather than a guessed year, resolves this.
    if (!yearKnown) context.windows.push(window(date.minus({ years: 1 })), window(date.minus({ years: 2 })));
    if (weekday && weekdays.indexOf(weekday[2].toLowerCase()) + 1 !== date.weekday) {
      context.warning = `The weekday and date do not match in ${date.year}. Use matching historical evidence or ask which date was intended.`;
    }
    return context;
  }
  if (weekday) {
    const day = weekdays.indexOf(weekday[2].toLowerCase()) + 1;
    let daysBack = (now.weekday - day + 7) % 7;
    if (weekday[1] && daysBack === 0) daysBack = 7;
    context.windows = [window(now.minus({ days: daysBack }))];
    return context;
  }
  const period = /\b(last|this)\s+(week|month)\b/i.exec(text);
  if (period) {
    const unit = period[2].toLowerCase() as 'week' | 'month';
    const start = now.startOf(unit).minus(period[1].toLowerCase() === 'last' ? (unit === 'week' ? { weeks: 1 } : { months: 1 }) : {});
    context.windows = [{ start: start.toUTC().toISO()!, end: start.plus(unit === 'week' ? { weeks: 1 } : { months: 1 }).toUTC().toISO()!, label: `${period[0]} (${start.toISODate()})` }];
    return context;
  }
  if (/\byesterday\b/i.test(text)) context.windows = [window(now.minus({ days: 1 }))];
  else if (/\btoday\b/i.test(text) && /\b(ask|said|discuss|chat|earlier)\w*\b/i.test(text)) context.windows = [window(now)];
  else {
    const month = /\b(?:in|during|on)\s+(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s+(\d{4}))?\b/i.exec(text);
    if (month) {
      const parsed = chrono.parse(`${month[1]} 1 ${month[2] || now.year}`, instant)[0];
      if (parsed) {
        let date = now.set({ month: parsed.start.get('month')!, day: 1 });
        if (month[2]) date = date.set({ year: Number(month[2]) });
        else if (date > now) date = date.minus({ years: 1 });
        context.windows = [window(date, true)];
      }
    }
  }
  return context;
}
