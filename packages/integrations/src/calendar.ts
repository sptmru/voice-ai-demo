import { createHash } from 'node:crypto';

export type CalendarSlot = { start: string; end: string };
export type CalendarBooking = CalendarSlot & {
  provider: 'google' | 'demo';
  eventId: string;
  htmlLink?: string;
  status: 'confirmed' | 'demo';
};
export type BookCalendarInput = CalendarSlot & {
  sessionId: string;
  bookingKey: string;
  summary: string;
  description?: string;
};
export class CalendarError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}

type Environment = Record<string, string | undefined>;
type GoogleEvent = {
  id?: string;
  htmlLink?: string;
  status?: string;
  etag?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};
const minute = 60_000;
const day = 24 * 60 * minute;
const overlaps = (a: CalendarSlot, b: CalendarSlot) =>
  Date.parse(a.start) < Date.parse(b.end) && Date.parse(a.end) > Date.parse(b.start);
const invalid = () =>
  new CalendarError('INVALID_SLOT', 'Choose a future weekday slot between 09:00 and 17:00.');

/** One configured calendar per API instance. No credentials or provider response bodies leave this service. */
export class CalendarService {
  private readonly env: Environment;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly formatter: Intl.DateTimeFormat;
  private readonly configError: boolean;
  private token?: { value: string; expires: number };
  private refreshing?: Promise<string>;
  private queue: Promise<unknown> = Promise.resolve();
  private demoBookings = new Map<string, CalendarBooking>();

  constructor(
    options: { env?: Environment; fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
  ) {
    this.env = { ...(options.env ?? process.env) };
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    const values = [
      'GOOGLE_CALENDAR_ID',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
    ].map((key) => this.env[key]?.trim());
    let timeZone = this.env.GOOGLE_CALENDAR_TIME_ZONE?.trim() || 'Asia/Yerevan';
    let badZone = false;
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format();
    } catch {
      timeZone = 'Asia/Yerevan';
      badZone = true;
    }
    this.configError = badZone || (values.some(Boolean) && !values.every(Boolean));
    this.formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  }

  status() {
    const configured = !this.configError && Boolean(this.env.GOOGLE_REFRESH_TOKEN?.trim());
    return {
      configured,
      provider: configured ? ('google' as const) : ('demo' as const),
      timeZone: this.formatter.resolvedOptions().timeZone,
      configurationError: this.configError,
    };
  }

  private assertConfiguration() {
    if (this.configError)
      throw new CalendarError(
        'CONFIGURATION_ERROR',
        'Calendar configuration is incomplete or its time zone is invalid.',
      );
  }

  private parts(timestamp: number) {
    return Object.fromEntries(this.formatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
  }
  private dateAt(timestamp: number) {
    const p = this.parts(timestamp);
    return `${p.year}-${p.month}-${p.day}`;
  }
  private localInstant(date: string, hour: number, minutes = 0) {
    const target = Date.parse(
      `${date}T${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`,
    );
    let result = target;
    // Re-evaluate the offset at the target instant to account for daylight saving changes.
    for (let n = 0; n < 3; n++) {
      const p = this.parts(result);
      const represented = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
      result += target - represented;
    }
    return result;
  }

  private candidates(date: string, days: number, duration: number): CalendarSlot[] {
    const dateMs = Date.parse(`${date}T00:00:00Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(dateMs) ||
      new Date(dateMs).toISOString().slice(0, 10) !== date ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 14 ||
      !Number.isInteger(duration) ||
      duration < 15 ||
      duration > 120 ||
      duration % 15 ||
      dateMs > this.now() + 90 * day ||
      dateMs < this.now() - day * 2
    )
      throw invalid();
    const slots: CalendarSlot[] = [];
    for (let offset = 0; offset < days; offset++) {
      const current = new Date(dateMs + offset * day);
      if ([0, 6].includes(current.getUTCDay())) continue;
      const currentDate = current.toISOString().slice(0, 10);
      for (let m = 9 * 60; m + duration <= 17 * 60; m += 30) {
        const start = this.localInstant(currentDate, Math.floor(m / 60), m % 60);
        if (start <= this.now()) continue;
        slots.push({
          start: new Date(start).toISOString(),
          end: new Date(start + duration * minute).toISOString(),
        });
      }
    }
    return slots;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      // Keep the timeout active while the response body is being received too.
      const body = await response.arrayBuffer();
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status,
        headers: response.headers,
      });
    } catch {
      throw new CalendarError(
        controller.signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE',
        'Calendar could not be reached. Retry the same booking to check its status.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private async json(response: Response): Promise<any> {
    try {
      return await response.json();
    } catch {
      throw new CalendarError('INVALID_RESPONSE', 'Calendar returned an invalid response.');
    }
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > this.now() + minute) return this.token.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const response = await this.request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.env.GOOGLE_CLIENT_ID!,
          client_secret: this.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: this.env.GOOGLE_REFRESH_TOKEN!,
        }),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!response.ok)
        throw new CalendarError(
          'AUTHORIZATION_FAILED',
          'Google Calendar authorization failed. Reconnect the configured account.',
        );
      const body = await this.json(response);
      if (typeof body?.access_token !== 'string' || !body.access_token)
        throw new CalendarError('AUTHORIZATION_FAILED', 'Google Calendar authorization failed.');
      this.token = {
        value: body.access_token,
        expires: this.now() + (Number(body.expires_in) || 3600) * 1000,
      };
      return this.token.value;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async google(path: string, init: RequestInit = {}): Promise<Response> {
    const extraHeaders: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      extraHeaders[name] = value;
    });
    const send = async () =>
      this.request(`https://www.googleapis.com/calendar/v3${path}`, {
        ...init,
        headers: {
          ...extraHeaders,
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await this.accessToken()}`,
        },
      });
    let response = await send();
    if (response.status === 401) {
      this.token = undefined;
      response = await send();
    }
    return response;
  }
  private async busy(start: string, end: string): Promise<CalendarSlot[]> {
    const response = await this.google('/freeBusy', {
      method: 'POST',
      body: JSON.stringify({
        timeMin: start,
        timeMax: end,
        timeZone: this.status().timeZone,
        items: [{ id: this.env.GOOGLE_CALENDAR_ID }],
      }),
    });
    if (!response.ok) throw new CalendarError('UNAVAILABLE', 'Calendar availability could not be checked.');
    const body = await this.json(response);
    const calendar = body?.calendars?.[this.env.GOOGLE_CALENDAR_ID!];
    if (
      !calendar ||
      calendar.errors?.length ||
      !Array.isArray(calendar.busy) ||
      calendar.busy.some(
        (slot: CalendarSlot) =>
          !slot ||
          !Number.isFinite(Date.parse(slot.start)) ||
          !Number.isFinite(Date.parse(slot.end)) ||
          Date.parse(slot.end) <= Date.parse(slot.start),
      )
    ) {
      throw new CalendarError('UNAVAILABLE', 'Calendar availability could not be checked.');
    }
    return calendar.busy;
  }

  async listSlots(input: { date?: string; days?: number; durationMinutes?: number } = {}) {
    this.assertConfiguration();
    const candidates = this.candidates(
      input.date ?? this.dateAt(this.now()),
      input.days ?? 7,
      input.durationMinutes ?? 30,
    );
    const status = this.status();
    const busy = !candidates.length
      ? []
      : status.configured
        ? await this.busy(candidates[0].start, candidates.at(-1)!.end)
        : [...this.demoBookings.values()];
    return {
      provider: status.provider,
      timeZone: status.timeZone,
      slots: candidates.filter((slot) => !busy.some((b) => overlaps(slot, b))),
    };
  }

  async book(input: BookCalendarInput): Promise<CalendarBooking> {
    // Serialize availability check and insert within this API process, including different sessions.
    const booking = this.queue.then(() => this.bookUnlocked(input));
    this.queue = booking.catch(() => undefined);
    return booking;
  }
  private async bookUnlocked(input: BookCalendarInput): Promise<CalendarBooking> {
    this.assertConfiguration();
    if (
      !input.sessionId ||
      !input.bookingKey ||
      !input.summary.trim() ||
      input.summary.length > 200 ||
      (input.description?.length ?? 0) > 4000
    )
      throw invalid();
    if (
      ![input.start, input.end].every(
        (value) =>
          /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)),
      )
    )
      throw invalid();
    const slot = { start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString() };
    const eventId = createHash('sha256')
      .update(JSON.stringify([input.sessionId, input.bookingKey]))
      .digest('hex');
    const status = this.status();
    const path = `/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID ?? '')}/events`;
    const readExisting = async (): Promise<CalendarBooking | undefined> => {
      const response = await this.google(`${path}/${eventId}`);
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw new CalendarError('UNAVAILABLE', 'The previous calendar booking could not be verified.');
      return this.bookingResult(await this.json(response), eventId, slot);
    };
    const previous = status.configured ? await readExisting() : this.demoBookings.get(eventId);
    if (previous) {
      if (previous.start !== slot.start || previous.end !== slot.end)
        throw new CalendarError(
          'IDEMPOTENCY_CONFLICT',
          'This booking key already identifies a different appointment.',
        );
      return previous;
    }
    const duration = (Date.parse(slot.end) - Date.parse(slot.start)) / minute;
    const valid = this.candidates(this.dateAt(Date.parse(slot.start)), 1, duration).some(
      (s) => s.start === slot.start && s.end === slot.end,
    );
    if (!valid) throw invalid();
    const busy = status.configured ? await this.busy(slot.start, slot.end) : [...this.demoBookings.values()];
    if (busy.some((b) => overlaps(slot, b)))
      throw new CalendarError(
        'SLOT_UNAVAILABLE',
        'That time is no longer available. Please choose another slot.',
      );
    if (!status.configured) {
      const result: CalendarBooking = {
        ...slot,
        provider: 'demo',
        status: 'demo',
        eventId: `demo-${eventId}`,
      };
      this.demoBookings.set(eventId, result);
      return result;
    }
    const response = await this.google(`${path}?sendUpdates=none`, {
      method: 'POST',
      body: JSON.stringify({
        id: eventId,
        summary: input.summary,
        description: input.description,
        start: { dateTime: slot.start, timeZone: status.timeZone },
        end: { dateTime: slot.end, timeZone: status.timeZone },
        reminders: { useDefault: false },
        extendedProperties: { private: { relaySessionId: input.sessionId } },
      }),
    });
    if (response.status === 409) {
      const existing = await readExisting();
      if (existing) return existing;
    }
    if (!response.ok)
      throw new CalendarError(
        'BOOKING_FAILED',
        'Google Calendar did not confirm the booking. Retry the same booking to check its status.',
      );
    return this.bookingResult(await this.json(response), eventId, slot);
  }
  private eventPath(eventId: string) {
    if (!/^(?:demo-)?[a-f0-9]{64}$/.test(eventId))
      throw new CalendarError('INVALID_EVENT', 'Invalid appointment reference.');
    return `/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID ?? '')}/events/${encodeURIComponent(eventId)}`;
  }
  private assertEventIdentity(input: { sessionId: string; bookingKey: string; eventId: string }) {
    const expected = createHash('sha256')
      .update(JSON.stringify([input.sessionId, input.bookingKey]))
      .digest('hex');
    if (input.eventId !== (this.status().configured ? expected : `demo-${expected}`))
      throw new CalendarError('INVALID_EVENT', 'The calendar event does not belong to this appointment.');
  }
  private async busyExcept(start: string, end: string, excludeEventId: string): Promise<CalendarSlot[]> {
    const result: CalendarSlot[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({
        timeMin: start,
        timeMax: end,
        singleEvents: 'true',
        showDeleted: 'false',
        maxResults: '2500',
        ...(pageToken ? { pageToken } : {}),
      });
      const response = await this.google(
        `/calendars/${encodeURIComponent(this.env.GOOGLE_CALENDAR_ID!)}/events?${params}`,
      );
      if (!response.ok) throw new CalendarError('UNAVAILABLE', 'Calendar availability could not be checked.');
      const body = await this.json(response);
      if (!Array.isArray(body.items))
        throw new CalendarError('INVALID_RESPONSE', 'Calendar availability could not be checked.');
      for (const event of body.items as GoogleEvent[]) {
        if (
          event.id === excludeEventId ||
          event.status === 'cancelled' ||
          event.transparency === 'transparent'
        )
          continue;
        const a =
          event.start?.dateTime ??
          (event.start?.date ? new Date(this.localInstant(event.start.date, 0)).toISOString() : '');
        const b =
          event.end?.dateTime ??
          (event.end?.date ? new Date(this.localInstant(event.end.date, 0)).toISOString() : '');
        if (!Number.isFinite(Date.parse(a)) || !Number.isFinite(Date.parse(b)))
          throw new CalendarError('INVALID_RESPONSE', 'Calendar availability could not be checked.');
        result.push({ start: a, end: b });
      }
      pageToken = body.nextPageToken;
      if (!pageToken) return result;
    }
    throw new CalendarError('UNAVAILABLE', 'Calendar availability requires a narrower review.');
  }
  async reschedule(
    input: CalendarSlot & {
      sessionId: string;
      bookingKey: string;
      eventId: string;
      previousStart: string;
      previousEnd: string;
    },
  ): Promise<CalendarBooking> {
    const work = this.queue.then(async () => {
      this.assertConfiguration();
      this.assertEventIdentity(input);
      const slot = { start: new Date(input.start).toISOString(), end: new Date(input.end).toISOString() };
      const duration = (Date.parse(slot.end) - Date.parse(slot.start)) / minute;
      const configured = this.status().configured;
      const key = input.eventId.replace(/^demo-/, '');
      let existing: GoogleEvent | undefined;
      let prior = this.demoBookings.get(key);
      if (configured) {
        const response = await this.google(this.eventPath(input.eventId));
        if (response.status === 404 || response.status === 410)
          throw new CalendarError('NOT_FOUND', 'Calendar appointment no longer exists.');
        if (!response.ok)
          throw new CalendarError('UNAVAILABLE', 'Calendar appointment could not be verified.');
        existing = await this.json(response);
        if (existing?.status === 'cancelled')
          throw new CalendarError('NOT_FOUND', 'Calendar appointment has been cancelled.');
        if (existing?.start?.dateTime && existing.end?.dateTime)
          prior = {
            start: new Date(existing.start.dateTime).toISOString(),
            end: new Date(existing.end.dateTime).toISOString(),
            provider: 'google',
            status: 'confirmed',
            eventId: input.eventId,
          };
        if (!prior)
          throw new CalendarError('INVALID_RESPONSE', 'Calendar appointment could not be verified.');
      }
      if (prior?.start === slot.start && prior.end === slot.end)
        return configured ? this.bookingResult(existing!, input.eventId, slot) : prior;
      if (
        prior &&
        (Date.parse(prior.start) !== Date.parse(input.previousStart) ||
          Date.parse(prior.end) !== Date.parse(input.previousEnd))
      )
        throw new CalendarError(
          'EXTERNAL_CHANGE',
          'The appointment changed externally. Ask an operator to verify it.',
        );
      if (
        !this.candidates(this.dateAt(Date.parse(slot.start)), 1, duration).some(
          (s) => s.start === slot.start && s.end === slot.end,
        )
      )
        throw invalid();
      const busy = configured
        ? await this.busyExcept(slot.start, slot.end, input.eventId)
        : [...this.demoBookings.entries()].filter(([id]) => id !== key).map(([, value]) => value);
      if (busy.some((b) => overlaps(slot, b)))
        throw new CalendarError(
          'SLOT_UNAVAILABLE',
          'That time is no longer available. Please choose another slot.',
        );
      if (!configured) {
        const result: CalendarBooking = { ...slot, provider: 'demo', status: 'demo', eventId: input.eventId };
        this.demoBookings.set(key, result);
        return result;
      }
      const response = await this.google(`${this.eventPath(input.eventId)}?sendUpdates=none`, {
        method: 'PATCH',
        headers: existing?.etag ? { 'If-Match': existing.etag } : {},
        body: JSON.stringify({
          start: { dateTime: slot.start, timeZone: this.status().timeZone },
          end: { dateTime: slot.end, timeZone: this.status().timeZone },
        }),
      });
      if (response.status === 412)
        throw new CalendarError(
          'EXTERNAL_CHANGE',
          'The appointment changed externally. Ask an operator to verify it.',
        );
      if (!response.ok)
        throw new CalendarError(
          'UPDATE_FAILED',
          'Calendar did not confirm the change. Retry the same change to verify its status.',
        );
      return this.bookingResult(await this.json(response), input.eventId, slot);
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  async cancel(input: {
    sessionId: string;
    bookingKey: string;
    eventId: string;
    previousStart: string;
    previousEnd: string;
  }): Promise<{ provider: 'google' | 'demo'; eventId: string; status: 'cancelled' }> {
    const work = this.queue.then(async () => {
      this.assertConfiguration();
      this.assertEventIdentity(input);
      const result = {
        provider: this.status().provider,
        eventId: input.eventId,
        status: 'cancelled' as const,
      };
      if (!this.status().configured) {
        this.demoBookings.delete(input.eventId.replace(/^demo-/, ''));
        return result;
      }
      const response = await this.google(this.eventPath(input.eventId));
      if ([404, 410].includes(response.status)) return result;
      if (!response.ok) throw new CalendarError('UNAVAILABLE', 'Calendar appointment could not be verified.');
      const existing: GoogleEvent = await this.json(response);
      if (existing.status === 'cancelled') return result;
      if (
        Date.parse(existing.start?.dateTime ?? '') !== Date.parse(input.previousStart) ||
        Date.parse(existing.end?.dateTime ?? '') !== Date.parse(input.previousEnd)
      )
        throw new CalendarError(
          'EXTERNAL_CHANGE',
          'The appointment changed externally. Ask an operator to verify it.',
        );
      const removed = await this.google(`${this.eventPath(input.eventId)}?sendUpdates=none`, {
        method: 'DELETE',
        headers: existing.etag ? { 'If-Match': existing.etag } : {},
      });
      if (![204, 404, 410].includes(removed.status))
        throw new CalendarError(
          removed.status === 412 ? 'EXTERNAL_CHANGE' : 'CANCELLATION_FAILED',
          'Calendar did not confirm cancellation. Retry the same cancellation to verify its status.',
        );
      return result;
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  private bookingResult(event: GoogleEvent, eventId: string, slot: CalendarSlot): CalendarBooking {
    if (
      !event ||
      event.id !== eventId ||
      event.status === 'cancelled' ||
      !event.start?.dateTime ||
      !event.end?.dateTime ||
      Date.parse(event.start.dateTime) !== Date.parse(slot.start) ||
      Date.parse(event.end.dateTime) !== Date.parse(slot.end)
    ) {
      throw new CalendarError(
        'IDEMPOTENCY_CONFLICT',
        'The existing calendar appointment does not match this booking.',
      );
    }
    const htmlLink =
      event.htmlLink?.startsWith('https://www.google.com/calendar/') ||
      event.htmlLink?.startsWith('https://calendar.google.com/')
        ? event.htmlLink
        : undefined;
    return { ...slot, provider: 'google', status: 'confirmed', eventId, htmlLink };
  }
}

let singleton: CalendarService | undefined;
let rehearsal: CalendarService | undefined;
export const getCalendarService = (mode?: 'rehearsal' | 'live') => {
  if (mode === 'rehearsal')
    return (rehearsal ??= new CalendarService({
      env: { GOOGLE_CALENDAR_TIME_ZONE: process.env.GOOGLE_CALENDAR_TIME_ZONE },
    }));
  const service = (singleton ??= new CalendarService());
  if (mode === 'live' && !service.status().configured)
    throw new CalendarError(
      'LIVE_UNAVAILABLE',
      'Live booking requires a configured Google Calendar. Switch to Rehearsal or configure the integration.',
    );
  return service;
};
