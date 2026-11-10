# ObservaRR

Internal Unraid Docker app for receiving home server webhooks, managing future notification
recipient profiles, and later sending notifications. The app runs a Deno/Hono backend, a Vite React
admin panel, local SQLite persistence, local username/password auth, Docker packaging, GHCR
publishing, and an Unraid template.

SMS delivery is implemented through Textbelt and is disabled by default. Email templates are stored
for future use, but email delivery is not implemented.

## Architecture

- Backend: Deno + TypeScript + Hono
- Frontend: Vite + React + TypeScript + Material UI
- Persistence: single local SQLite database
- Auth: local username/password with server-side SQLite sessions
- Live events: ephemeral in-memory Event Console streamed with Server-Sent Events
- Media timelines: identified media events persisted for audit and gap analysis
- Notification profiles: local recipient profiles with contacts, SMS consent, external mappings,
  preferences, and Jellyfin avatar imports
- Event templates: global SMS/email templates per source/event with safe `{variableName}` rendering
- SMS receipts: durable Textbelt submission and delivery-status receipts
- Bandwidth automation: optional SABnzbd speed cap while Jellyfin is streaming
- Production: one Docker container
- Image: `ghcr.io/sweett00th/observarr`
- Unraid template: `templates/observarr.xml`

In production, the Deno/Hono server handles API and webhook routes and serves the built React app
from `client/dist`.

In local development, the backend runs on port `3020` and Vite runs separately. Vite proxies `/api`,
`/health`, and `/webhook` to `http://localhost:3020`.

SQLite uses `deno.land/x/sqlite@v3.9.1`, a WASM-based Deno SQLite module. That keeps the runtime
self-contained and avoids `--allow-ffi`; the tradeoff is that this library does not support SQLite
WAL mode.

## Local Development

Start the backend:

```powershell
$env:DB_PATH=".data/observarr.db"
$env:ADMIN_PASSWORD="change-me"
deno task dev:server
```

Start the frontend:

```powershell
deno task dev:client
```

Run the backend, frontend, and a local mock event stream together:

```powershell
deno task dev:mock
```

Build the frontend:

```powershell
deno task build:client
```

Start the production server locally after building the frontend:

```powershell
deno task start
```

Typecheck the backend:

```powershell
deno task check
```

Run the backend tests (no network needed; Jellyfin and SABnzbd are faked):

```powershell
deno task test
```

Format backend/Deno files:

```powershell
deno task fmt
```

Frontend typechecking is part of the client build and can also be run directly:

```powershell
npm --prefix client run typecheck
```

## Routes

- `GET /` serves the React admin panel when `client/dist` exists.
- `GET /health` returns service health and Deno runtime info.
- `GET /api/version` returns app, version, runtime, environment, and build metadata.
- `GET /api/auth/status` returns whether any local user exists.
- `GET /api/auth/me` returns the current user or `401`.
- `POST /api/auth/login` creates a server-side session and sets an HttpOnly cookie.
- `POST /api/auth/logout` deletes the current session and clears the cookie.
- `POST /api/auth/password` changes the current user's password after verifying the current
  password.
- `GET /api/admin/overview` returns SQLite-backed dashboard counts and provider configuration
  status. It requires login.
- `GET /api/events/recent` returns current in-memory Event Console events. It requires login.
- `GET /api/events/stream` streams live Event Console events with Server-Sent Events. It requires
  login.
- `GET /api/media-timelines` lists persisted media timelines. It requires login.
- `DELETE /api/media-timelines` deletes selected media timelines by id. It requires login.
- `POST /api/media-timelines/from-event` resolves the media timeline for a live event. It requires
  login.
- `GET /api/media-timelines/:id` returns a media timeline. It requires login.
- `GET /api/notification-profiles/event-catalog` returns the stable notification event catalog. It
  requires login.
- `GET /api/notification-profiles?query=` searches notification recipient profiles. It requires
  login.
- `POST /api/notification-profiles` creates a manual notification recipient profile. It requires
  login.
- `GET /api/notification-profiles/:id` returns profile details, identities, and saved preferences.
  It requires login.
- `PATCH /api/notification-profiles/:id` updates profile identity, contacts, enabled state, and
  external mappings. It requires login.
- `PUT /api/notification-profiles/:id/preferences` replaces the saved event preference set. It
  requires login.
- `GET /api/notification-profiles/:id/avatar` streams a cached imported avatar. It requires login.
- `POST /api/notification-profiles/:id/merge` with `{"sourceProfileId": n}` links another profile
  into this one (the same person imported twice) and deletes the other. It requires login.
- `GET /api/integrations/jellyfin/status` returns safe Jellyfin configuration status. It requires
  login.
- `POST /api/integrations/jellyfin/import-users` imports Jellyfin users into notification profiles.
  It requires login.
- `GET /api/integrations/steamreviews/status` returns whether the Steam import is configured. It
  requires login.
- `POST /api/integrations/steamreviews/import-users` imports steamreviews' Steam users into
  notification profiles. It requires login.
- `GET /api/bandwidth-automation` returns bandwidth automation's settings, status and recent
  errors. It requires login.
- `PATCH /api/bandwidth-automation/settings` validates and saves bandwidth automation settings,
  `enabled` included. It requires login.
- `POST /api/bandwidth-automation/reconcile` checks Jellyfin and SABnzbd now, correcting SABnzbd's
  speed limit when automation is on. It requires login.
- `GET /api/event-templates/catalog` returns the canonical template catalog, variables, defaults,
  and current template summaries. It requires login.
- `GET /api/event-templates` lists global event templates. It requires login.
- `GET /api/event-templates/:source/:eventType` returns one global template. It requires login.
- `PATCH /api/event-templates/:source/:eventType` edits one global template and increments its
  revision. It requires login.
- `POST /api/event-templates/:source/:eventType/preview` renders a sample preview and sends no
  messages. It requires login.
- `POST /api/event-templates/:source/:eventType/reset` resets one global template to the catalog
  default. It requires login.
- `GET /api/message-receipts` searches durable SMS receipts. It requires login.
- `GET /api/message-receipts/:id` returns safe receipt details. It requires login.
- `POST /webhook/test` accepts JSON, logs a summary, emits a live test event, and returns the
  summary. It does not send SMS.
- `POST /webhook/jellyfin`, `/webhook/seerr`, `/webhook/radarr`, `/webhook/sonarr`,
  `/webhook/sabnzbd` and `/webhook/steamreviews` accept JSON, emit normalized live events, and
  dispatch SMS to subscribed, opted-in profiles as described under Event Templates and SMS Delivery.

Unknown `/api/*` and `/webhook/*` routes return JSON 404 responses. Unknown non-API routes fall back
to the React `index.html` for future client-side routing.

## Webhook Secret

Webhook routes support an optional shared secret. If `SHARED_SECRET` is set, every webhook request
must present it in one of these ways, whichever the sending app can do:

```text
x-sms-secret: your-secret
Authorization: Bearer your-secret        ("Bearer " is optional)
POST /webhook/sabnzbd?secret=your-secret
```

Requests without it get a 401. Prefer a header when the sender has one, since a query parameter can
end up in the sender's logs. Where each app puts it:

- **Seerr**: the webhook agent's **Authorization Header** field, `Bearer your-secret`. It has no
  other header field.
- **Jellyfin** (Webhook plugin): a header on the destination, `x-sms-secret` = `your-secret`.
- **Radarr / Sonarr**: append `?secret=your-secret` to the webhook URL, or add an `x-sms-secret`
  header if the connection has a Headers field.
- **SABnzbd** through Apprise: `json://host:3020/webhook/sabnzbd?+x-sms-secret=your-secret` (the `+`
  makes Apprise send it as a header). A notification script can send the header itself.
- **steamreviews** sends `x-sms-secret` from its `OBSERVARR_SECRET`.

If `SHARED_SECRET` is unset, webhook requests are allowed and the server logs a startup warning. Set
it in Unraid for normal use. The Steam import needs it.

## Event Console

The authenticated app includes a collapsible terminal-like Event Console fixed to the bottom of the
viewport. It shows recent webhook events and streams new events live with Server-Sent Events from
`/api/events/stream`.

The Event Console buffer is intentionally ephemeral and in-memory only:

- Events are lost when the container restarts.
- The server keeps only a short runtime ring buffer.

Separately, every identifiable media webhook event is persisted to Media Timelines (see Media
Timelines for what is left out). If an event can be associated to a movie or series, the app creates
or updates that media item and appends the event to its timeline.

The default ring buffer keeps events from the last `10` minutes and caps the list at `250` events.
Override those with:

```env
EVENT_BUFFER_MINUTES=10
EVENT_BUFFER_MAX=250
EVENT_RAW_MAX_BYTES=20000
```

External apps still need to be configured to push webhooks into this app. This feature does not poll
Jellyfin, Jellyseerr/Seerr, Radarr, Sonarr, SABnzbd, or any other app API.
Bandwidth Automation, below, polls Jellyfin's sessions and SABnzbd's queue for its own use only;
nothing from it reaches the Event Console.

The console supports source filters for Jellyfin, Seerr, Radarr, Sonarr, SABnzbd, and System/Test.
Webhook payloads are normalized into compact events. Expanding an event row shows the sanitized raw
webhook payload. Obvious secret-looking fields such as tokens, passwords, API keys, and
authorization headers are recursively redacted. If the sanitized raw payload exceeds
`EVENT_RAW_MAX_BYTES`, the expanded view shows a truncated preview with byte metadata.

## Media Timelines

The dashboard includes a `Media Timelines` widget. Open it to see media items identified from
webhook events. The page has a searchable media list, a scrollable sorted event list for the
selected item, and a horizontal timeline graph. The graph groups events into evenly spaced dots, one
per stretch of time, so even thousands of events stay readable: a dot shows how many events it holds,
is colored by source (split when it mixes sources), and has a red ring if any of them failed. Hover
over a dot for its time range, its events by type, and the gap from the previous dot.

Clicking a subscribed title on a notification profile opens Media Timelines narrowed to that
title's timelines. **Show all** clears the filter.

Media timeline rows can be selected individually or in bulk from the left column and deleted
manually. Deleting a media item removes its associated timeline events through SQLite cascade
cleanup.

Timeline persistence is automatic:

1. A webhook event arrives.
2. The server normalizes the event.
3. The server identifies the distinct piece of media using strong IDs, structured fields, or loose
   normalized title matching.
4. If the media has been seen before, the event is appended to that media timeline.
5. If the media is new, a timeline is created and the event is appended.

Media matching is intentionally loose in this pass. The app first tries derived keys from common
fields such as `movie.title`, `series.title`, `tmdbId`, `imdbId`, `tvdbId`, `title`, `subject`, and
media type hints. If that misses, incoming events are compared against existing media titles, as
whole words, in the event's title, message, and entity title. Placeholders such as "Jellyfin event"
(a payload that names nothing) never create or match a timeline.

Jellyfin specifics:

- Episode and season events belong to their series' timeline, named by `SeriesName` and keyed by
  `SeriesId`, not to a timeline of their own. The episode's name stays on the event itself.
- Events that aren't about media (sign-ins, sessions, user and plugin changes, server tasks) and the
  `PlaybackProgress` and `UserDataSaved` pings sent while something plays appear in the Event
  Console but never on a timeline.
- Database migration 10 cleaned up timelines recorded before these rules, once: it removed those
  events, renamed per-episode timelines after their series, and merged them into the series'
  existing timeline, subscriptions included.

Media Timelines also stores a thumbnail URL when webhook payloads provide one through common
poster/image fields such as `posterUrl`, `thumbnailUrl`, `imageUrl`, `movie.remotePoster`,
`series.remotePoster`, or image arrays from media managers. If no thumbnail is available, the UI
shows an initial-based fallback.

When an event type normalizes to `MEDIA_AVAILABLE`, the media item is marked available and scheduled
for cleanup after 14 days. Cleanup runs once on startup and then once per day while the container is
running.

For local development, the repo includes a mock webhook event generator. It posts synthetic
Jellyfin, Seerr, Radarr, Sonarr, SABnzbd, and test events into the same webhook endpoints external
apps use:

```powershell
deno task mock:events
```

Send one event and exit:

```powershell
deno task mock:events:once
```

The tool emits realistic multi-step media journeys. A movie flow looks like Seerr request, Seerr
approval, Radarr grab, SABnzbd download, Radarr import, Seerr available, Jellyfin library update,
and Jellyfin playback. Series flows use Sonarr in the equivalent steps. Events in one journey share
media IDs/titles so Media Timelines can reconstruct end-to-end behavior.

The tool reads `.env`, sends `SHARED_SECRET` as `x-sms-secret` when set, and defaults to
`http://localhost:$PORT`. Optional local knobs:

```env
WEBHOOK_BASE_URL=http://localhost:3020
MOCK_EVENT_INTERVAL_MS=2500
```

## Notification Profiles

The authenticated dashboard includes a Notification Profiles management dialog. These profiles
represent future notification recipients and are separate from local ObservaRR admin login users.

Profiles store:

- Display name and enabled/disabled state
- Optional phone number and email address
- Explicit SMS opt-in/out timestamps
- Optional Jellyfin and Seerr identity mappings
- Imported Jellyfin avatar metadata
- Event-specific interest, future SMS preference, and future email preference

Saving profile preferences does not send messages by itself. Imported Jellyfin users are not
automatically subscribed to any notification event, delivery channel, or SMS consent.

The stable template/event catalog is served by the backend at `/api/event-templates/catalog` so the
API and UI use the same source, event type, variable, and default-template values.

## Event Templates and SMS Delivery

Event templates are global per `(source, event_type)`. A profile preference decides whether that
recipient is interested in the event and wants SMS or email, but it does not own a private copy of
the template. Editing a template from a profile event row changes it for every profile subscribed to
that event.

Template syntax is deliberately small:

```text
{variableName}
```

Use `{{` for a literal `{` and `}}` for a literal `}`. Only variables listed by
`/api/event-templates/catalog` are allowed. Unknown variables and malformed braces block saving.
Templates cannot execute JavaScript, expressions, loops, conditionals, dot paths, or arbitrary
payload access.

SMS templates and email subject/body templates are stored and previewed. Email transport is not
configured yet, so ObservaRR does not send email and does not create fake email receipts.

Textbelt is the only SMS provider. Real SMS requires all of these:

- `NOTIFICATIONS_ENABLED=true`
- `TEXTBELT_KEY` configured server-side
- an enabled notification profile
- an enabled profile phone number
- explicit phone-number SMS opt-in recorded in ObservaRR
- profile event preference enabled with SMS selected
- a valid global SMS template for that source/event

Imported Jellyfin profiles are not automatically opted into SMS. `/webhook/test` and Event Console
test events never send SMS.

Even when every rule above is satisfied, a recipient never gets more than one SMS for the same event
type about the same movie, or the same season of a series — e.g. a second `grab` (or `episode_added`
within an already-notified season) never re-sends, even if the upstream event's own ID differs from
the first one. Different event types about the same title are unaffected and each still send their
own one-time SMS when subscribed (a `request_available` text still goes out even if that recipient
already got a `grab` text for the same movie). The receipt for a suppressed repeat is recorded with
submission status `skipped` rather than silently dropped. This is separate from — and layered in
front of — the existing exact-duplicate-event protection described below, which only catches literal
redelivery of one specific event.

## Message Receipts

Every attempted outbound SMS creates a durable receipt before provider submission. Receipts preserve
the rendered message body, template revision, masked destination, safe render context, provider
message ID, provider response metadata, quota remaining, and separate submission/delivery statuses.

Submission status tracks whether ObservaRR submitted the request to Textbelt:

```text
pending, submitted, rejected, failed, submission_unknown, render_failed, skipped
```

Delivery status tracks later provider delivery state:

```text
not_applicable, unknown, sending, sent, delivered, failed
```

`submitted` or `sent` does not guarantee handset delivery. A background in-process poller checks
recent Textbelt message IDs every 10 minutes and updates delivery status when Textbelt reports
progress.

Receipts never store the Textbelt API key, raw webhook payloads, unmasked phone numbers, email
addresses, authorization headers, or provider request bodies. Receipts are linked to the profile
phone-number row that was used for dispatch when available.

### Textbelt reply webhooks and SMS opt-in

ObservaRR exposes `POST /webhook/textbelt/reply` for Textbelt SMS replies. Textbelt sends reply JSON
with `fromNumber` and `text`; ObservaRR matches the sender to a profile phone number, stores the
reply text, and marks the number opted in when the response contains consent language such as `Y`,
`Yes`, `OK`, `okay`, `confirmed`, `agree`, `start`, or `subscribe`. Stop/unsubscribe style replies
mark the number opted out.

Opt-in welcome texts are never sent automatically. An admin must explicitly send the opt-in text for
one phone number or all unsent phone numbers on a profile. The welcome consent message is a global
editable template, `system:sms_opt_in_welcome`, available from the phone-number section in profile
management. It supports the catalog variables shown in the template editor, including
`{profileName}`, `{optInKeyword}`, and `{optOutKeyword}`. `WEBHOOK_BASE_URL` must be reachable by
Textbelt for reply handling; ObservaRR passes `${WEBHOOK_BASE_URL}/webhook/textbelt/reply` as
Textbelt's `replyWebhookUrl` on opt-in welcome messages.

Profiles can store multiple phone numbers. Each number has its own enabled flag, opt-in lifecycle,
last reply, and linked receipts. Imported profiles remain unsubscribed until an admin adds a phone
number and sends an opt-in welcome text.

### Media interests

Profiles now have a normalized media-interest table for future subscription management. The default
is zero movie or series interests, so media notifications are gated until an enabled profile media
interest matches the event's identified media. ObservaRR uses TMDB IDs when available, including
Seerr `media.tmdbId`, Radarr/Sonarr payload IDs, and Jellyfin `Provider_tmdb`. Jellyfin `SeriesId`
is retained so orphan Season `ItemAdded` events can later be associated with the Series `ItemAdded`
event that contains TMDB metadata. SABnzbd events fall back to title/year matching through the
existing media timeline identity logic.

## Jellyfin Profile Import

Jellyfin import is optional and requires these server-only environment variables:

```env
JELLYFIN_URL=
JELLYFIN_API_KEY=
```

`JELLYFIN_URL` should be the internal Jellyfin base URL reachable from the ObservaRR container, such
as `http://192.168.1.50:8096`. `JELLYFIN_API_KEY` is secret, is never returned to the browser, and
should be masked in Unraid.

Importing Jellyfin users:

1. Fetches Jellyfin users from the server side.
2. Uses Jellyfin user ID as the stable external identity key.
3. Creates or updates local notification profiles idempotently.
4. Refreshes Jellyfin username and identity sync metadata.
5. Caches primary avatars under `/data/avatars` when available.
6. Preserves local phone number, email address, enabled state, Seerr mapping, and all event
   preferences on repeat import.

Avatar files are not exposed as an unrestricted static directory. The browser loads them only
through the authenticated `/api/notification-profiles/:id/avatar` endpoint.

## Steam Reviews Integration

[steamreviews](https://github.com/sweett00th/steamreviews) explains why a Steam game gets negative
reviews. People sign in to it with Steam and watch games. ObservaRR takes two things from it:

1. **Steam users.** `Import Steam Users` fetches everyone who signed in to steamreviews, from its LAN
   address (`STEAMREVIEWS_URL`, e.g. `http://192.168.1.50:3040`), authenticated with
   `SHARED_SECRET` in an `x-observarr-secret` header. steamreviews knows the same value as
   `OBSERVARR_SECRET` and answers only requests that did not come through its public reverse proxy.
   Each Steam user becomes a profile with a `steam` identity (their SteamID64), or updates the
   profile that already has it. Nobody is opted in to anything, and a profile that has a picture
   keeps it; otherwise the Steam avatar is cached, fetched only from Steam's avatar CDN.
2. **"Analysis ready" events** at `POST /webhook/steamreviews`, sent by steamreviews with
   `x-sms-secret` when it finishes analyzing a game. The payload lists the game's watchers by
   SteamID64. An event is texted only to profiles whose Steam identity is among those watchers, and
   only if the usual rules hold (event preference with SMS, enabled and opted-in phone number).
   Without a watcher list, nobody is texted. These events are not movies or series: they don't
   appear in Media Timelines. The global template `steamreviews:analysis_ready` has the variables
   `{gameTitle}`, `{ratingLabel}`, `{topComplaints}`, `{analysisUrl}` and `{steamUrl}`.

### Linking profiles

The same person can arrive twice: from Jellyfin and from Steam, or someone with only one of them.
Any profile can be the person's canonical profile. Open it and use `Link another profile` to fold
the other one into it:

- identities, phone numbers (each keeping its own opt-in state), media interests and message
  receipts move over, and the other profile is deleted;
- where both profiles have a preference for the same event, the kept profile's setting stays, so
  linking never turns on anything the kept profile had off;
- two profiles that each have an identity of the same kind (say two Jellyfin users) can't be
  linked: remove one of the identities first.

Receipts moving over keeps the one-text-per-event rule for the linked person.

## Bandwidth Automation

Caps SABnzbd's download speed while anything is playing on Jellyfin, so unrestricted downloads
don't make streams (transcodes especially) buffer or freeze, and lifts the cap once playback has
stopped. It is off by default. Turn it on from the **Bandwidth Automation** panel on the
dashboard.

### Setup

1. Set these on the container (the Unraid template has fields for them) and restart it:
   - `JELLYFIN_URL` and `JELLYFIN_API_KEY`: the same ones the profile import uses.
   - `SABNZBD_URL`: SABnzbd's LAN address as its web UI opens, including its URL base if it has
     one, e.g. `http://192.168.1.50:8080`.
   - `SABNZBD_API_KEY`: the API key from SABnzbd's **Config > General > Security** (not the NZB
     key).
2. Open the dashboard. With automation off, **Reconcile now** only checks Jellyfin and SABnzbd,
   so use it to see both connect. Adjust the settings, then switch automation on.
3. Strongly recommended: set `SHARED_SECRET`, and on the Jellyfin Webhook plugin's ObservaRR
   destination (`/webhook/jellyfin`):
   - enable **Playback Start**, **Playback Stop** and **Playback Progress** (the plugin has no
     separate pause or resume event: a pause or resume is a Playback Progress whose `IsPaused`
     changed);
   - tick **Send All Properties** (or use a template that sends `NotificationType`, `ItemId`,
     `DeviceId` and `IsPaused` as top-level JSON fields; the Event Console already relies on
     `NotificationType`);
   - add a request header `x-sms-secret` with the secret (see [Webhook Secret](#webhook-secret)).

   With an authenticated webhook, SABnzbd is capped the moment playback starts. Without
   `SHARED_SECRET` anyone on the LAN could send a fake playback event, so webhooks then only
   trigger a check of Jellyfin's sessions (about a second later) and never change SABnzbd on their
   own word. Polling works without webhooks too and catches any that go missing.

### How it decides

- A stream counts when a Jellyfin session has something playing: any user, remote family
  included, and direct play, direct stream and transcodes alike. Sessions that are only connected
  (browsing, an app left open) never count.
- Paused streams follow the paused-streams setting below.
- A playing session that hasn't checked in with Jellyfin for 5 minutes is stale and doesn't
  count. That is Jellyfin's own threshold for idle playback, and it catches clients that vanished
  without stopping.
- One counted stream or more: SABnzbd is capped at the throttled speed. None: the cap stays for
  the recovery grace period, then comes off entirely. Something starting during the grace period
  keeps the cap, with nothing written to SABnzbd.
- If Jellyfin can't be read (down, timing out, rejecting the key), the cap goes on, or stays on.
  An outage never lifts it. Once Jellyfin answers again with nothing playing, the grace period
  starts from then.

Event first, with polling as the safety net:

- **Playback starts or resumes** (an authenticated Playback Start, or a Playback Progress for a
  stream that was paused or not known yet): the cap is written to SABnzbd straight away. There is
  no Jellyfin request and no SABnzbd read on the way. It doesn't wait for checks that are running
  or queued, even one stuck on a slow Jellyfin; at most it waits for a SABnzbd request already
  under way. A check of Jellyfin's sessions follows. A start Jellyfin's sessions don't list yet
  counts as a stream for up to a minute, so a slow-to-update Jellyfin can't lift the cap again.
  Repeated starts write nothing once SABnzbd is capped. (One exception: if SABnzbd hasn't answered
  at all since startup and automation doesn't own its limit yet, it is read once first, so the
  right limit can be put back when automation is turned off.)
- **Playback stops or pauses**: never lifts the cap by itself. It triggers a check of Jellyfin's
  sessions right away: anything still counting (another user, a paused stream under the
  paused-streams setting) keeps the cap; otherwise the recovery grace period starts. When it ends,
  Jellyfin is checked again before the cap comes off. A start during the grace period cancels it.
- **Plain Playback Progress pings** (every few seconds per stream) are ignored: no requests, no log
  lines.
- **Polling** is adaptive: every idle interval (15 s) while nothing plays, every active interval
  (60 s) while capped, and every idle interval while Jellyfin or SABnzbd is failing. It runs
  sooner when the grace period ends or a paused or stale stream stops counting. It catches missed
  webhooks, stale sessions, SABnzbd restarts and changes made by hand.
- SABnzbd is written to only when its limit should change or has drifted (SABnzbd restarted,
  someone changed it by hand, another controller set it).

Races are handled explicitly:

- Every SABnzbd write goes through one lock, so two writes never overlap or contradict each other.
  Playback starts jump to the front of it.
- Checks (polls, webhook-triggered checks, settings changes, **Reconcile now**) still run one at a
  time and share a waiting run. Webhook-triggered checks are at least a second apart.
- Each playback start bumps an activity counter. A check whose Jellyfin read began before a newer
  start can't start the grace period or lift the cap on that older answer. SABnzbd is read inside
  the lock just before deciding, so a start that arrives during that read is still seen.
- Each request to Jellyfin or SABnzbd times out after 3 seconds. Timeouts, refused connections and
  5xx answers are retried twice; a rejected API key isn't. A failed write is retried by the
  follow-up check and then every idle interval, and shows in the panel.
- At startup it checks right away, so a restart can't leave SABnzbd wrongly capped or uncapped. If
  ObservaRR restarts while SABnzbd is capped and nothing is playing, the cap comes off one grace
  period after startup.

### Settings

| Setting               | Default                  | Range                                             |
| --------------------- | ------------------------ | ------------------------------------------------- |
| Enabled               | Off                      |                                                   |
| Throttled speed       | 80 Mb/s (10 MB/s)        | 1 to 10,000 Mb/s, entered in Mb/s or MB/s         |
| Idle check interval   | 15 s                     | 2 to 300 s (also the retry interval on errors)    |
| Active check interval | 60 s                     | 2 to 600 s                                        |
| Recovery grace period | 30 s                     | 0 to 3600 s                                       |
| Paused streams        | Count for a grace period | Count for a grace period, always, or never        |
| Paused grace period   | 120 s                    | 0 to 3600 s (only for "count for a grace period") |

"Always" keeps the cap for as long as anything is paused, and "never" lifts it as soon as nothing is
actually playing (after the recovery grace). Settings are kept in SQLite. URLs and keys only ever
come from the environment.

The two check intervals replace the single polling interval of earlier versions (migration 12). A
polling interval left at the old 5 s default moves to the new defaults. One that was changed
becomes the idle interval, and the active interval too if it was longer than 60 s. Other saved
settings are kept.

### Megabits and megabytes

Rates are decimal: 1 Mb/s is 1,000,000 bits/s (125,000 bytes/s) and 1 MB/s is 1,000,000 bytes/s,
so 80 Mb/s = 10 MB/s. ObservaRR sends SABnzbd the exact byte count. SABnzbd shows speeds in binary
units that it labels "MB/s" (1 MiB = 1,048,576 bytes), so it displays the default cap as about 9.5
"MB/s". It's the same limit.

### What it changes in SABnzbd

Only the global speed limit (`mode=config&name=speedlimit`). It never pauses or resumes the queue,
and never touches jobs, categories, priorities, scripts or post-processing. A paused queue stays
paused; the limit simply applies when it resumes. "Unrestricted" means no limit at all, not "100%
of SABnzbd's maximum line speed", which is still a limit and is cleared once when nothing plays.

SABnzbd forgets a limit set through its API when it restarts. ObservaRR notices at the next check
and sets it again.

While automation is on, ObservaRR owns the speed limit: a change made in SABnzbd (its speed-limit
control included) is set back at the next check, and the panel says so. To set the limit by hand,
turn automation off first.

### Turning it off

ObservaRR puts back the limit SABnzbd had before automation first changed it, but only if SABnzbd
still has the limit ObservaRR last set. If someone changed it since, that deliberate change stays.
If SABnzbd can't be reached, ObservaRR retries every 30 seconds, and at the next start, until it
can. If automation never changed anything, nothing is written.

A stopped ObservaRR can't lift a cap. Before removing ObservaRR, or stopping it for good, while
SABnzbd is capped, turn automation off (SABnzbd would otherwise keep the cap until it restarts).

### Other speed-limit controllers

Only one thing should manage SABnzbd's speed limit. These conflict with bandwidth automation:

- SABnzbd's own scheduler (**Config > Scheduling**) with **Speedlimit** actions;
- scripts or containers that throttle SABnzbd for Plex, Jellyfin or Tautulli playback;
- anything else that calls SABnzbd's `speedlimit` API.

Two controllers undo each other's changes at every check. ObservaRR logs each outside change
(`bandwidth.external_change`), and after 3 within 15 minutes the panel warns that another
controller is probably active. Turn one of them off. SABnzbd's scheduled pause and resume don't
conflict, since bandwidth automation never pauses or resumes.

### Status and logs

The panel shows:

- the controller mode: Unrestricted, Throttled, Recovery grace or Protective (error), the last
  meaning Jellyfin can't be read and the cap is held;
- the active stream count, including starts that only a webhook has reported so far, and what is
  playing;
- SABnzbd's current limit and measured download speed, and whether Jellyfin and SABnzbd answer;
- the last successful reconciliation and the last speed-limit change;
- the last trigger (webhook, scheduled poll, manual, startup or settings change);
- the last playback webhook and what it did, and the last webhook-to-SABnzbd timing;
- whether instant capping is on (it needs `SHARED_SECRET`);
- recent errors (kept in memory, the latest 20).

Its logs are JSON lines:

- `bandwidth.webhook`: one line per playback start, resume, pause or stop, never per progress
  ping, with the outcome and, for a cap, the timings;
- `bandwidth.limit_changed` and `bandwidth.mode_changed`;
- `bandwidth.jellyfin_failed` / `bandwidth.jellyfin_recovered` and `bandwidth.sabnzbd_failed` /
  `bandwidth.sabnzbd_recovered`;
- `bandwidth.external_change` and `bandwidth.conflict_suspected`;
- `bandwidth.settings_saved` and `bandwidth.restore_skipped`.

### Measuring webhook-to-SABnzbd latency

The timing covers ObservaRR's part: from the moment the webhook request reached ObservaRR to
SABnzbd acknowledging the new limit. It is measured on a monotonic clock. Jellyfin's own delay
between someone pressing Play and the plugin sending the webhook isn't included, and neither is
the network trip from Jellyfin to ObservaRR. The panel's **Webhook → SABnzbd cap** shows three
parts:

- receipt to the SABnzbd request;
- the request itself;
- receipt to the end of the Jellyfin check that followed.

On a healthy LAN the target is under 250 ms, most of it SABnzbd's answer.

To check it on Unraid:

1. Start something in Jellyfin while nothing else plays and SABnzbd is unrestricted. Then look at
   the panel, or `GET /api/bandwidth-automation` (logged in) for `lastWebhookThrottle`.
2. Or read the container log: `docker logs observarr 2>&1 | grep bandwidth.webhook`. A cap logs
   `"outcome":"capped"` with `receivedToRequestMs`, `requestMs` and `receivedToAckMs`.
3. To test without playing anything, post a fake start from a machine on the LAN. It really caps
   SABnzbd:

   ```sh
   curl -s -X POST "http://UNRAID-IP:3020/webhook/jellyfin" \
     -H "Content-Type: application/json" -H "x-sms-secret: YOUR-SECRET" \
     -d '{"NotificationType":"PlaybackStart","ItemId":"test","DeviceId":"latency-test"}'
   ```

   Jellyfin never lists that stream, so the cap comes off by itself after about 90 seconds (the
   one-minute window for unconfirmed starts, then the recovery grace). Posting the matching stop
   (the same command with `PlaybackStop`) ends the window at once, and the cap then comes off
   after the grace period. Both show up in the Event Console like any Jellyfin event. Neither
   sends a text (playback starts and stops aren't notification events) or makes a timeline entry
   (they name no media).

API keys never appear in logs, the panel, API responses or the database. SABnzbd's key travels in
the request body rather than the URL, and Jellyfin's in the `Authorization` header.

Bandwidth automation is separate from the Event Console: its polling never feeds the console or
Media Timelines, and Jellyfin webhooks reach both exactly as before.

## SQLite Persistence

The app stores local state in one SQLite database file. By default:

```text
/data/observarr.db
```

Override it with `DB_PATH`. In Unraid, `/mnt/user/appdata/observarr` is mounted to `/data`, so the
database survives container updates.

Migrations run automatically on startup and are tracked in `schema_migrations`. Current tables
include `users`, `sessions`, `message_receipts`, `notification_profiles`,
`profile_external_identities`, `profile_event_preferences`, `event_templates`, `provider_settings`,
`webhook_events`, `media_items`, `media_events`, `bandwidth_automation_settings`, and
`bandwidth_automation_state`. Legacy placeholder tables
`event_templates_legacy` and `message_receipts_legacy` may exist on upgraded databases. Older
development tables `tracked_media` and `tracked_media_events` may also exist on upgraded local
databases.

To reset the app in local development, stop the server and delete the SQLite file you used for
`DB_PATH`. To also remove imported avatar cache, delete the avatar directory. This removes local
ObservaRR data, users, profiles, mappings, preferences, and media timelines.

```powershell
Remove-Item .data\observarr.db
Remove-Item -Recurse .data\avatars
```

## Local Auth

The first admin user is bootstrapped only when the `users` table is empty.

- Set `ADMIN_PASSWORD` before first start.
- `ADMIN_USERNAME` defaults to `admin`.
- Passwords are stored as PBKDF2-SHA256 hashes with per-user salts.
- `ADMIN_PASSWORD` is ignored after any user exists.
- There is no public registration and no third-party login.

Sessions are random opaque tokens stored in an HttpOnly `observarr_session` cookie. Only a SHA-256
hash of each session token is stored in SQLite. `SESSION_TTL_DAYS` controls expiry and defaults to
`7`. Keep `COOKIE_SECURE=false` for local HTTP/LAN use; set it to `true` only behind HTTPS.

Authenticated users can open the profile drawer by clicking their username in the upper-right app
bar. The drawer shows local account details and allows changing the password. Password changes
require the current password and store a fresh PBKDF2-SHA256 hash.

## First Tests

```powershell
curl http://localhost:3020/health
```

```powershell
curl http://localhost:3020/api/version
```

```powershell
curl http://localhost:3020/api/auth/status
```

Unauthenticated admin API calls should return `401`:

```powershell
curl http://localhost:3020/api/admin/overview
```

Log in from the React UI at `http://localhost:3020/`, or use the API and keep the returned cookie in
your client.

```powershell
curl -Method POST http://localhost:3020/webhook/test `
  -ContentType "application/json" `
  -Headers @{ "x-sms-secret" = "your-secret" } `
  -Body '{"source":"manual","message":"hello from curl"}'
```

Example source webhooks:

```powershell
curl -Method POST http://localhost:3020/webhook/radarr `
  -ContentType "application/json" `
  -Headers @{ "x-sms-secret" = "your-secret" } `
  -Body '{"eventType":"MovieDownloaded","movie":{"title":"Example Movie"},"message":"Download complete"}'
```

## Docker

Build locally:

```powershell
docker build -t observarr .
```

Run locally:

```powershell
docker run --rm -p 3020:3020 `
  -e PORT=3020 `
  -e TZ=America/New_York `
  -e DB_PATH=/data/observarr.db `
  -e ADMIN_USERNAME=admin `
  -e ADMIN_PASSWORD=change-me `
  -e SESSION_TTL_DAYS=7 `
  -e COOKIE_SECURE=false `
  -e EVENT_BUFFER_MINUTES=10 `
  -e EVENT_BUFFER_MAX=250 `
  -e NOTIFICATIONS_ENABLED=false `
  -e TEXTBELT_KEY=replace-with-unraid-secret `
  -e TEXTBELT_SENDER=ObservaRR `
  -e JELLYFIN_URL=http://jellyfin.local:8096 `
  -e JELLYFIN_API_KEY=replace-with-unraid-secret `
  -e SABNZBD_URL=http://sabnzbd.local:8080 `
  -e SABNZBD_API_KEY=replace-with-unraid-secret `
  -v ${PWD}\.data:/data `
  observarr
```

Open the admin panel:

```text
http://localhost:3020/
```

The final image runs the Deno server, not the Vite dev server. The Docker build compiles the
frontend first, copies `client/dist` into the final Deno image, creates `/data/avatars`, and runs
with explicit Deno permissions for env, network, `/app` reads, `/data` reads, and `/data` writes.

## GitHub Actions and GHCR

`.github/workflows/docker-publish.yml` builds the Docker image on pushes to `main`, pull requests,
and semver tags like `v0.1.0`.

Pull requests build but do not push images. Pushes to `main` and tags publish to:

```text
ghcr.io/sweett00th/observarr
```

Expected tags include:

- `latest` for the default branch
- `v0.1.0` style semver tags
- `sha-<commit>` for commit builds

## Unraid

The Unraid template points to:

```text
ghcr.io/sweett00th/observarr:latest
```

The WebUI opens the admin panel at:

```text
http://[IP]:[PORT:3020]/
```

To add the custom template repository in Unraid, use:

```text
https://github.com/sweett00th/observarr
```

Keep the app LAN-only. This scaffold does not assume public proxying, Cloudflare, NPM, or any
external ingress.

Set `ADMIN_PASSWORD` before the first start so the app can create the initial local admin user.
After that, changing `ADMIN_USERNAME` or `ADMIN_PASSWORD` in the template will not overwrite
existing users.

## Environment Variables

Copy `.env.example` for local reference only. In Unraid, set values through the container template.

| Variable                 | Required             | Description                                                                                                                            |
| ------------------------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | No                   | HTTP port inside the container. Defaults to `3020`.                                                                                    |
| `TZ`                     | No                   | Timezone. Defaults to `America/New_York` in the Unraid template.                                                                       |
| `DB_PATH`                | No                   | SQLite database path. Defaults to `/data/observarr.db`.                                                                                |
| `ADMIN_USERNAME`         | Bootstrap            | Initial admin username used only when no users exist. Defaults to `admin`.                                                             |
| `ADMIN_PASSWORD`         | Bootstrap            | Initial admin password used only when no users exist. No safe default; set in Unraid before first start.                               |
| `SESSION_TTL_DAYS`       | No                   | Server-side session lifetime in days. Defaults to `7`.                                                                                 |
| `COOKIE_SECURE`          | No                   | Adds the Secure cookie flag when `true`. Keep `false` for LAN HTTP.                                                                    |
| `EVENT_BUFFER_MINUTES`   | No                   | In-memory Event Console retention window in minutes. Defaults to `10`.                                                                 |
| `EVENT_BUFFER_MAX`       | No                   | Maximum in-memory Event Console event count. Defaults to `250`.                                                                        |
| `EVENT_RAW_MAX_BYTES`    | No                   | Maximum sanitized raw payload bytes included per in-memory event. Defaults to `20000`.                                                 |
| `WEBHOOK_BASE_URL`       | Textbelt replies/dev | Base URL used by dev helpers and Textbelt opt-in replies. Textbelt must be able to reach `${WEBHOOK_BASE_URL}/webhook/textbelt/reply`. |
| `MOCK_EVENT_INTERVAL_MS` | Dev only             | Mock event generator interval. Defaults to `2500`.                                                                                     |
| `SHARED_SECRET`          | Recommended          | Optional webhook secret: `x-sms-secret` header, `Authorization` header, or `?secret=` (see Webhook Secret). Set this in Unraid.        |
| `NOTIFICATIONS_ENABLED`  | No                   | Defaults to `false`. Must be `true` before any real SMS can be sent.                                                                   |
| `TEXTBELT_KEY`           | SMS only             | Secret Textbelt API key. Required only when SMS notifications are enabled.                                                             |
| `TEXTBELT_SENDER`        | No                   | Optional approved Textbelt sender name.                                                                                                |
| `JELLYFIN_URL`           | Import/bandwidth     | Internal Jellyfin base URL used only by the server, for profile import and bandwidth automation.                                       |
| `JELLYFIN_API_KEY`       | Import/bandwidth     | Secret Jellyfin API key used only by the server, for profile import and bandwidth automation.                                          |
| `SABNZBD_URL`            | Bandwidth only       | SABnzbd's LAN address (with its URL base, if any) for bandwidth automation, e.g. `http://192.168.1.50:8080`.                           |
| `SABNZBD_API_KEY`        | Bandwidth only       | Secret SABnzbd API key, used only by the server to read the queue and set its speed limit. Never returned or logged.                   |
| `STEAMREVIEWS_URL`       | Import only          | steamreviews' LAN address for importing its Steam users. Uses `SHARED_SECRET` (steamreviews' `OBSERVARR_SECRET`).                      |

Do not commit real secrets. Textbelt keys must never be committed. Twilio is no longer supported.
Email templates are stored, but email transport is not implemented.
