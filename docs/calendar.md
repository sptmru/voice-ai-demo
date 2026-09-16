# Google Calendar appointment integration

Appointment and lead demos can check availability and create a real event in one
configured Google Calendar. The integration runs on the API server. The browser
receives provider/configuration status and booking results, never OAuth credentials.

## Configure a calendar

1. Create a dedicated demo calendar in Google Calendar. Copy its **Calendar ID**
   from Settings → Integrate calendar. Use an account with permission to create
   events in this calendar.
2. In Google Cloud Console, enable **Google Calendar API** in your project and
   configure the OAuth consent screen. Add your account as a test user if the
   application is in Testing mode.
3. Create an OAuth client of type **Web application**. For initial manual setup
   with [Google OAuth Playground](https://developers.google.com/oauthplayground),
   add `https://developers.google.com/oauthplayground` as an authorized redirect
   URI. In Playground settings enable **Use your own OAuth credentials** and enter
   that client's ID and secret.
4. Authorize these scopes in Playground:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.events.freebusy`
5. Exchange the authorization code for tokens. Copy the refresh token into the
   local `.env`; keep offline access enabled. Never paste credentials into chat,
   source files, URLs, or frontend configuration. Google's
   [server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
   documents offline authorization and refresh tokens. External apps in Testing
   can receive refresh tokens that expire after seven days; renew authorization
   or configure the appropriate publishing status before repeated client demos.
6. Set these API environment variables and restart the application:

   ```dotenv
   GOOGLE_CALENDAR_ID=your-calendar-id
   GOOGLE_CLIENT_ID=your-oauth-client-id
   GOOGLE_CLIENT_SECRET=your-oauth-client-secret
   GOOGLE_REFRESH_TOKEN=your-refresh-token
   GOOGLE_CALENDAR_TIME_ZONE=Asia/Yerevan
   ```

The zone must be an IANA time zone, for example `Europe/Berlin`. Slots use that
calendar zone independently of the browser/server zone and account for daylight
saving time. Demo opening hours are Monday–Friday, 09:00–17:00; starts are on the
half hour. Default duration is 30 minutes. The service accepts 15–120 minutes in
15-minute increments, searches up to 14 days per request and limits dates to the
next 90 days.

## Confirm the integration

1. Start an appointment or lead demo. Check that calendar mode is Google Calendar.
   `configured: true` means required environment values are present; it does not
   claim the OAuth credentials have been tested.
2. Request available slots. The server checks Google's
   [FreeBusy endpoint](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
   and removes overlapping occupied times. Authorization and per-calendar errors
   fail closed; unavailable calendars never silently become demo availability.
3. Choose a time and explicitly confirm the booking. The server rechecks that
   time immediately before inserting an event. Open the result's Google Calendar
   link and verify the event in the configured calendar.
4. Retry the same confirmed action: it should return the existing event. The
   deterministic event ID uses the session ID and stable booking key, allowing
   retries after a lost response to recover the event without inserting another.
5. For a conflict check, put a busy event in the configured calendar and verify
   the overlapping slot is absent. After testing, remove your test event manually.

No customer invitations are sent: the event has no attendees, uses
`sendUpdates=none`, and disables default reminders. Customer email addresses are
not used to send messages. Google's
[event insertion contract](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
defines the event ID and notification behavior.

## Demo mode, errors, and operating limits

With all four credential/calendar fields empty, availability and booking use an
explicit `provider: demo`, `status: demo` result. Demo appointments exist only in
API memory for availability conflict checks; the application's booking records
are also persisted in PostgreSQL and remain in session history after restart.
The in-memory availability reservations reset on restart. Demo bookings have no external event link. A partially
configured integration or invalid time zone returns a configuration error;
credentials are never silently ignored. To return to demo mode deliberately,
clear all four fields and restart.

Each outbound request has a 10-second timeout including response-body download.
Expired access tokens refresh on the server, with one retry on HTTP 401. Error
responses never contain Google's response body, tokens, or client secret. An
insert timeout is an unknown outcome: retry the **same** booking key to look up
the deterministic event ID before attempting another insert.

Bookings are serialized within one API process. Google Calendar does not offer
an atomic free/busy-check-and-book operation: an external calendar editor can
write between the check and insertion. Run a single API instance and a dedicated
calendar for this demo. Multiple API replicas or stronger booking guarantees
need a shared durable reservation mechanism; external calendar writers still
need coordination. Existing Google events survive local session deletion and
must be cancelled in Google Calendar explicitly.

## Verification performed during implementation

`corepack pnpm exec vitest run tests/calendar.test.ts` covers OAuth refresh,
availability filtering, event insertion, stable IDs and conflict recovery,
redacted errors, timeouts, demo mode, concurrent booking conflicts, partial
configuration, business-hour validation and daylight saving transitions.

These are mocked HTTP tests. A live Google Calendar booking has **not** been
verified; credentials must be configured and the confirmation steps above run
against your calendar.
