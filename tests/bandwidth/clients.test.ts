import assert from "node:assert/strict";
import {
  createJellyfinSessionSource,
  parseJellyfinDate,
  parseJellyfinSessions,
} from "../../server/integrations/jellyfin/sessions.ts";
import {
  createSabnzbdClient,
  parseSabnzbdQueue,
  parseSabnzbdResponse,
  sabnzbdSpeedLimitValue,
} from "../../server/integrations/sabnzbd/client.ts";
import {
  describeNetworkFailure,
  redactSecrets,
  requestText,
  UpstreamRequestError,
} from "../../server/lib/upstream.ts";
import { JELLYFIN_KEY, SABNZBD_KEY } from "./helpers.ts";

type Call = { url: string; init: RequestInit };

/** A fetch that answers from a list, recording each request. */
function fakeFetch(...answers: Array<Response | Error>): typeof fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const answer = answers.shift() ?? new Error("no more answers");
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }) as typeof fetch & { calls: Call[] };
  impl.calls = calls;
  return impl;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noSleep = { sleep: () => Promise.resolve() };

// ---------------------------------------------------------------------------------------------
// SABnzbd

Deno.test("speed limits go to SABnzbd as exact bytes in its K notation, and 0 clears the limit", () => {
  assert.equal(sabnzbdSpeedLimitValue(10_000_000), "9765.625K"); // 80 Mb/s = 10 MB/s
  assert.equal(sabnzbdSpeedLimitValue(125_000), "122.0703125K"); // 1 Mb/s
  assert.equal(sabnzbdSpeedLimitValue(0), "0");

  // SABnzbd multiplies K by 1024 (misc.from_units), which must land on the same byte count.
  for (const bytes of [125_000, 1_234_567, 10_000_000, 12_500_000, 99_999_999, 1_250_000_000]) {
    const value = sabnzbdSpeedLimitValue(bytes);
    assert.match(value, /^\d+(\.\d+)?K$/);
    assert.equal(Math.trunc(Number.parseFloat(value) * 1024), bytes);
    assert.ok(Number.parseFloat(value) * 1024 > 100, "never in SABnzbd's 1-100 percent range");
  }

  assert.throws(() => sabnzbdSpeedLimitValue(500), RangeError);
  assert.throws(() => sabnzbdSpeedLimitValue(-1), RangeError);
  assert.throws(() => sabnzbdSpeedLimitValue(Number.NaN), RangeError);
});

Deno.test("SABnzbd's queue limit reads the same across versions", () => {
  const base = { kbpersec: "1296.02", speedlimit: "100", status: "Downloading", paused: false };
  assert.equal(parseSabnzbdQueue({ ...base, speedlimit_abs: "" }).speedLimitBytesPerSecond, 0);
  assert.equal(parseSabnzbdQueue({ ...base, speedlimit_abs: "0" }).speedLimitBytesPerSecond, 0);
  assert.equal(
    parseSabnzbdQueue({ ...base, speedlimit_abs: "4718592.0" }).speedLimitBytesPerSecond,
    4_718_592,
  );
  const status = parseSabnzbdQueue({ ...base, speedlimit_abs: "10000000", version: "4.5.5" });
  assert.equal(status.speedLimitBytesPerSecond, 10_000_000);
  assert.equal(status.speedLimitPercent, 100);
  assert.equal(status.downloadBytesPerSecond, Math.round(1296.02 * 1024)); // kbpersec is KiB/s
  assert.equal(status.queueStatus, "Downloading");
  assert.equal(status.paused, false);
  assert.equal(status.version, "4.5.5");

  assert.throws(() => parseSabnzbdQueue({ ...base }), UpstreamRequestError);
  assert.throws(() => parseSabnzbdQueue(null), UpstreamRequestError);
});

Deno.test("SABnzbd errors are recognized, bad keys included", () => {
  assert.throws(
    () => parseSabnzbdResponse(JSON.stringify({ status: false, error: "API Key Incorrect" })),
    (error: unknown) => error instanceof UpstreamRequestError && error.kind === "auth",
  );
  assert.throws(
    () => parseSabnzbdResponse("error: API Key Incorrect"),
    (error: unknown) => error instanceof UpstreamRequestError && error.kind === "auth",
  );
  assert.throws(
    () => parseSabnzbdResponse("<html>not sabnzbd</html>"),
    (error: unknown) => error instanceof UpstreamRequestError && error.kind === "response",
  );
  assert.throws(
    () =>
      parseSabnzbdResponse(
        JSON.stringify({ status: false, error: `bad apikey=${SABNZBD_KEY}` }),
        SABNZBD_KEY,
      ),
    (error: unknown) => error instanceof Error && !error.message.includes(SABNZBD_KEY),
  );
});

Deno.test("the SABnzbd client posts its calls with the key in the body, never the URL", async () => {
  const fetch = fakeFetch(
    json({ queue: { speedlimit_abs: "0", speedlimit: "0", kbpersec: "0.00", paused: true } }),
    json({ status: true }),
  );
  const client = createSabnzbdClient({ url: "http://sab:8080", apiKey: SABNZBD_KEY, fetch });

  const queue = await client.getQueueStatus();
  assert.equal(queue.speedLimitBytesPerSecond, 0);
  assert.equal(queue.paused, true);
  await client.setSpeedLimit(10_000_000);

  assert.equal(fetch.calls.length, 2);
  for (const call of fetch.calls) {
    assert.equal(call.url, "http://sab:8080/api");
    assert.ok(!call.url.includes(SABNZBD_KEY));
    assert.equal(call.init.method, "POST");
  }

  const queueParams = new URLSearchParams(String(fetch.calls[0].init.body));
  assert.equal(queueParams.get("mode"), "queue");
  assert.equal(queueParams.get("limit"), "1");
  assert.equal(queueParams.get("output"), "json");
  assert.equal(queueParams.get("apikey"), SABNZBD_KEY);

  const limitParams = new URLSearchParams(String(fetch.calls[1].init.body));
  assert.equal(limitParams.get("mode"), "config");
  assert.equal(limitParams.get("name"), "speedlimit");
  assert.equal(limitParams.get("value"), "9765.625K");
});

Deno.test("SABnzbd requests retry what may pass and stop at a rejected key", async () => {
  const flaky = fakeFetch(
    new Response("busy", { status: 503 }),
    new TypeError("error sending request: connection refused"),
    json({ queue: { speedlimit_abs: "0" } }),
  );
  const client = createSabnzbdClient({
    url: "http://sab:8080",
    apiKey: SABNZBD_KEY,
    fetch: flaky,
    ...noSleep,
  });
  await client.getQueueStatus();
  assert.equal(flaky.calls.length, 3);

  const rejected = fakeFetch(new Response("API Key Incorrect", { status: 403 }));
  const rejecting = createSabnzbdClient({
    url: "http://sab:8080",
    apiKey: "wrong-key",
    fetch: rejected,
    ...noSleep,
  });
  await assert.rejects(
    () => rejecting.getQueueStatus(),
    (error: unknown) =>
      error instanceof UpstreamRequestError && error.kind === "auth" &&
      error.message === "SABnzbd rejected the API key (HTTP 403)",
  );
  assert.equal(rejected.calls.length, 1, "a bad key is not retried");
});

Deno.test("network errors never quote the URL or key that Deno's error text contains", async () => {
  const leaky = new TypeError(
    `error sending request for url (http://sab:8080/api?apikey=${SABNZBD_KEY}): client error (Connect): tcp connect error: Connection refused (os error 111)`,
  );
  const client = createSabnzbdClient({
    url: "http://sab:8080",
    apiKey: SABNZBD_KEY,
    fetch: fakeFetch(leaky, leaky, leaky),
    ...noSleep,
  });

  await assert.rejects(
    () => client.setSpeedLimit(10_000_000),
    (error: unknown) =>
      error instanceof UpstreamRequestError && error.message === "SABnzbd refused the connection",
  );
});

Deno.test("requests time out, body included, and say so plainly", async () => {
  const hanging =
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;

  await assert.rejects(
    () =>
      requestText("Jellyfin", "http://jellyfin/Sessions", {}, {
        timeoutMs: 20,
        attempts: 2,
        retryDelayMs: 0,
      }, { fetch: hanging }),
    (error: unknown) =>
      error instanceof UpstreamRequestError && error.kind === "timeout" &&
      error.message === "Jellyfin did not answer within 20ms",
  );
});

Deno.test("network failures are described in fixed phrases", () => {
  assert.equal(
    describeNetworkFailure(new TypeError("dns error: failed to lookup address")),
    "could not be found (DNS lookup failed)",
  );
  assert.equal(
    describeNetworkFailure(new TypeError("Invalid URL: 'sab:8080/api'")),
    "has an invalid URL setting",
  );
  assert.equal(
    describeNetworkFailure(new TypeError("invalid peer certificate")),
    "failed the TLS handshake",
  );
  assert.equal(describeNetworkFailure(new TypeError("Network is unreachable")), "is unreachable");
  assert.equal(
    describeNetworkFailure(new Error("something else entirely")),
    "could not be reached",
  );
});

Deno.test("redaction removes given secrets and credential-looking parameters", () => {
  const text = redactSecrets(
    `GET /api?mode=queue&apikey=abc123&x=1 Authorization: MediaBrowser Token="tok-999" ${SABNZBD_KEY}`,
    [SABNZBD_KEY, undefined, ""],
  );
  assert.ok(!text.includes("abc123"));
  assert.ok(!text.includes("tok-999"));
  assert.ok(!text.includes(SABNZBD_KEY));
  assert.match(text, /apikey=\[redacted\]&x=1/);
  assert.match(text, /MediaBrowser Token="\[redacted\]"/);
});

// ---------------------------------------------------------------------------------------------
// Jellyfin

Deno.test("Jellyfin sessions: only ones with something playing are kept, for every user", () => {
  const snapshot = parseJellyfinSessions([
    {
      Id: "a",
      UserName: "remote-family",
      DeviceId: "phone",
      Client: "Jellyfin Android",
      DeviceName: "Pixel",
      LastActivityDate: "2026-11-09T19:59:58.1234567Z",
      LastPlaybackCheckIn: "2026-11-09T19:59:55.7654321Z",
      NowPlayingItem: { Id: "ep1", Name: "Pilot", SeriesName: "Some Show", Type: "Episode" },
      PlayState: { IsPaused: false, PlayMethod: "Transcode" },
    },
    {
      Id: "b",
      UserName: "admin",
      LastPausedDate: "2026-11-09T19:58:00.0000000Z",
      NowPlayingItem: { Id: "m1", Name: "A Movie", Type: "Movie" },
      PlayState: { IsPaused: true, PlayMethod: "DirectPlay" },
    },
    // Connected, browsing, nothing playing.
    { Id: "c", UserName: "kid", NowViewingItem: { Id: "x" }, PlayState: { IsPaused: false } },
    { Id: "d", UserName: "tv", LastPlaybackCheckIn: "0001-01-01T00:00:00.0000000Z" },
  ]);

  assert.equal(snapshot.totalSessions, 4);
  assert.equal(snapshot.playing.length, 2);

  const [remote, paused] = snapshot.playing;
  assert.equal(remote.userName, "remote-family");
  assert.equal(remote.itemName, "Some Show - Pilot");
  assert.equal(remote.playMethod, "Transcode");
  assert.equal(remote.isPaused, false);
  assert.equal(remote.lastSeenAt, Date.parse("2026-11-09T19:59:58.123Z"), "the later of the two");
  assert.equal(paused.isPaused, true);
  assert.equal(paused.pausedAt, Date.parse("2026-11-09T19:58:00.000Z"));
  assert.equal(paused.lastSeenAt, null, "unknown activity: treated as fresh");

  assert.throws(() => parseJellyfinSessions({ error: "nope" }), UpstreamRequestError);
});

Deno.test("Jellyfin dates are read as UTC whatever the server's time zone", () => {
  assert.equal(
    parseJellyfinDate("2026-11-09T18:04:05.1234567Z"),
    Date.parse("2026-11-09T18:04:05.123Z"),
  );
  assert.equal(
    parseJellyfinDate("2026-11-09T18:04:05.1234567"),
    Date.parse("2026-11-09T18:04:05.123Z"),
  );
  assert.equal(parseJellyfinDate("2026-11-09T18:04:05"), Date.parse("2026-11-09T18:04:05Z"));
  assert.equal(parseJellyfinDate("2026-11-09T13:04:05-05:00"), Date.parse("2026-11-09T18:04:05Z"));
  assert.equal(parseJellyfinDate("0001-01-01T00:00:00.0000000Z"), null);
  assert.equal(parseJellyfinDate("not a date"), null);
  assert.equal(parseJellyfinDate(null), null);
});

Deno.test("the Jellyfin client authenticates with an Authorization header, not the URL", async () => {
  const fetch = fakeFetch(json([]));
  const source = createJellyfinSessionSource({
    url: "http://jellyfin:8096",
    apiKey: JELLYFIN_KEY,
    fetch,
  });

  const snapshot = await source.fetchSessions();
  assert.deepEqual(snapshot, { totalSessions: 0, playing: [] });
  assert.equal(fetch.calls[0].url, "http://jellyfin:8096/Sessions");
  const headers = new Headers(fetch.calls[0].init.headers);
  assert.equal(headers.get("authorization"), `MediaBrowser Token="${JELLYFIN_KEY}"`);
});

Deno.test("a Jellyfin that rejects the key or answers garbage fails clearly", async () => {
  const rejecting = createJellyfinSessionSource({
    url: "http://jellyfin:8096",
    apiKey: JELLYFIN_KEY,
    fetch: fakeFetch(new Response("", { status: 401 })),
    ...noSleep,
  });
  await assert.rejects(
    () => rejecting.fetchSessions(),
    (error: unknown) =>
      error instanceof UpstreamRequestError &&
      error.message === "Jellyfin rejected the API key (HTTP 401)",
  );

  const garbled = createJellyfinSessionSource({
    url: "http://jellyfin:8096",
    apiKey: JELLYFIN_KEY,
    fetch: fakeFetch(new Response("<html>proxy error</html>", { status: 200 })),
  });
  await assert.rejects(
    () => garbled.fetchSessions(),
    (error: unknown) => error instanceof UpstreamRequestError && error.kind === "response",
  );
});
