import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { CalendarService, type BookCalendarInput } from '../packages/integrations/src/calendar.js';

const now = Date.parse('2026-09-16T04:00:00Z'); // Wednesday, 08:00 Yerevan
const env = {
  GOOGLE_CALENDAR_ID: 'calendar@example.com',
  GOOGLE_CLIENT_ID: 'client',
  GOOGLE_CLIENT_SECRET: 'secret-do-not-leak',
  GOOGLE_REFRESH_TOKEN: 'refresh-do-not-leak',
  GOOGLE_CALENDAR_TIME_ZONE: 'Asia/Yerevan',
};
const input: BookCalendarInput = {
  sessionId: 'session-a',
  bookingKey: 'booking-a',
  summary: 'Consultation',
  start: '2026-09-16T05:00:00.000Z',
  end: '2026-09-16T05:30:00.000Z',
};
const id = createHash('sha256')
  .update(JSON.stringify([input.sessionId, input.bookingKey]))
  .digest('hex');
const event = {
  id,
  start: { dateTime: input.start },
  end: { dateTime: input.end },
  htmlLink: 'https://www.google.com/calendar/event?eid=example',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const availability = (busy: unknown[] = []) => json({ calendars: { [env.GOOGLE_CALENDAR_ID]: { busy } } });
const make = (fetcher = vi.fn<typeof fetch>()) => ({
  fetcher,
  service: new CalendarService({ env, fetch: fetcher, now: () => now }),
});

describe('Google Calendar integration', () => {
  it('refreshes OAuth server-side, caches its token, and filters occupied intervals', async () => {
    const { service, fetcher } = make();
    fetcher
      .mockResolvedValueOnce(json({ access_token: 'access', expires_in: 3600 }))
      .mockResolvedValueOnce(availability([input]))
      .mockResolvedValueOnce(availability());
    const result = await service.listSlots({ date: '2026-09-16', days: 1 });
    expect(result.provider).toBe('google');
    expect(result.slots[0].start).toBe('2026-09-16T05:30:00.000Z');
    expect(result.slots).toHaveLength(15);
    await service.listSlots({ date: '2026-09-17', days: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('grant_type=refresh_token');
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: 'Bearer access' });
  });

  it('creates a real event with stable valid id and no attendees, notifications, or default reminders', async () => {
    const { service, fetcher } = make();
    fetcher
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(availability())
      .mockResolvedValueOnce(json(event));
    const result = await service.book(input);
    expect(result).toEqual({
      ...input,
      sessionId: undefined,
      bookingKey: undefined,
      summary: undefined,
      provider: 'google',
      status: 'confirmed',
      eventId: id,
      htmlLink: event.htmlLink,
    });
    const [url, request] = fetcher.mock.calls[3];
    expect(url).toContain('/calendars/calendar%40example.com/events?sendUpdates=none');
    const body = JSON.parse(String(request?.body));
    expect(body.id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(body.attendees).toBeUndefined();
    expect(body.reminders).toEqual({ useDefault: false });
    expect(body.start.timeZone).toBe('Asia/Yerevan');
  });

  it('returns existing event on retry without testing own event as busy or creating duplicates', async () => {
    const { service, fetcher } = make();
    fetcher.mockResolvedValueOnce(json({ access_token: 'access' })).mockResolvedValueOnce(json(event));
    expect((await service.book(input)).eventId).toBe(id);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('recovers an insert conflict using the same event id', async () => {
    const { service, fetcher } = make();
    fetcher
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(availability())
      .mockResolvedValueOnce(json({}, 409))
      .mockResolvedValueOnce(json(event));
    expect((await service.book(input)).eventId).toBe(id);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('rejects a mismatched idempotent booking and a slot which became busy before confirmation', async () => {
    const { service, fetcher } = make();
    fetcher
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({ ...event, end: { dateTime: '2026-09-16T06:00:00Z' } }));
    await expect(service.book(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    fetcher.mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(availability([input]));
    await expect(service.book(input)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
    expect(fetcher.mock.calls.some(([, init]) => String(init?.body).includes('"summary"'))).toBe(false);
  });

  it('fails closed for per-calendar errors even on HTTP 200', async () => {
    const { service, fetcher } = make();
    fetcher
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(
        json({ calendars: { [env.GOOGLE_CALENDAR_ID]: { busy: [], errors: [{ reason: 'notFound' }] } } }),
      );
    await expect(service.listSlots()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('refreshes expired authorization once and does not expose credential/provider error bodies', async () => {
    const { service, fetcher } = make();
    fetcher
      .mockResolvedValueOnce(json({ access_token: 'access' }))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: 'second' }))
      .mockResolvedValueOnce(availability());
    expect((await service.listSlots()).slots.length).toBeGreaterThan(0);
    expect(fetcher.mock.calls[3][1]?.headers).toMatchObject({ Authorization: 'Bearer second' });
    const failed = make();
    failed.fetcher.mockResolvedValue(json({ error: env }, 400));
    await expect(failed.service.listSlots()).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
    await failed.service.listSlots().catch((error: Error) => {
      expect(error.message).not.toContain('secret');
      expect(error.message).not.toContain('refresh-do-not-leak');
    });
  });

  it('aborts a slow provider request with a safe error', async () => {
    const fetcher = vi.fn<typeof fetch>(
      (_, request) =>
        new Promise((_, reject) => {
          request?.signal?.addEventListener('abort', () => reject(new Error('secret-do-not-leak')));
        }),
    );
    const service = new CalendarService({ env, fetch: fetcher, now: () => now, timeoutMs: 5 });
    await expect(service.listSlots()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

describe('calendar demo and scheduling rules', () => {
  it('labels every unconfigured result as demo and serializes conflicting bookings', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = new CalendarService({ env: {}, fetch: fetcher, now: () => now });
    expect(service.status()).toMatchObject({ configured: false, provider: 'demo' });
    const results = await Promise.allSettled([
      service.book(input),
      service.book({ ...input, sessionId: 'other' }),
    ]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { provider: 'demo', status: 'demo' } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'SLOT_UNAVAILABLE' } });
    expect((await service.book(input)).htmlLink).toBeUndefined();
    expect((await service.listSlots({ days: 1 })).slots).not.toContainEqual({
      start: input.start,
      end: input.end,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects partial configuration rather than pretending a real booking succeeded', async () => {
    const service = new CalendarService({ env: { GOOGLE_CLIENT_ID: 'partial' }, now: () => now });
    expect(service.status().configurationError).toBe(true);
    await expect(service.book(input)).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });

  it('permits only one appointment for a stable booking key even when concurrent calls choose different times', async () => {
    const service = new CalendarService({ env: {}, now: () => now });
    const results = await Promise.allSettled([
      service.book(input),
      service.book({ ...input, start: '2026-09-16T06:00:00Z', end: '2026-09-16T06:30:00Z' }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'IDEMPOTENCY_CONFLICT' } });
    const retry = await service.book(input);
    expect(retry.start).toBe(input.start);
    expect((await service.listSlots({ days: 1 })).slots).toHaveLength(15);
  });

  it('rejects invalid/past/out-of-hours times and filters weekends', async () => {
    const service = new CalendarService({ env: {}, now: () => now });
    expect((await service.listSlots({ date: '2026-09-19', days: 2 })).slots).toHaveLength(0);
    await expect(service.listSlots({ date: '2026-02-30' })).rejects.toMatchObject({ code: 'INVALID_SLOT' });
    await expect(
      service.book({ ...input, start: '2026-09-16T03:00:00Z', end: '2026-09-16T03:30:00Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_SLOT' });
    await expect(
      service.book({ ...input, start: '2026-09-16T05:00:00', end: '2026-09-16T05:30:00' }),
    ).rejects.toMatchObject({ code: 'INVALID_SLOT' });
  });

  it('keeps local business hours across a daylight saving transition', async () => {
    const service = new CalendarService({
      env: { GOOGLE_CALENDAR_TIME_ZONE: 'America/New_York' },
      now: () => Date.parse('2026-10-30T00:00:00Z'),
    });
    const before = await service.listSlots({ date: '2026-10-30', days: 1 });
    const after = await service.listSlots({ date: '2026-11-02', days: 1 });
    expect(before.slots[0].start).toBe('2026-10-30T13:00:00.000Z');
    expect(after.slots[0].start).toBe('2026-11-02T14:00:00.000Z');
  });
});
