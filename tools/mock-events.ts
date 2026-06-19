type MockSource = "jellyfin" | "seerr" | "radarr" | "sonarr" | "sabnzbd" | "test";
type MediaKind = "movie" | "series";

type MockEvent = {
  source: MockSource;
  payload: Record<string, unknown>;
};

type Journey = {
  id: string;
  kind: MediaKind;
  title: string;
  year: number;
  externalId: number;
  user: string;
  quality: string;
  step: number;
  steps: Array<(journey: Journey) => MockEvent>;
};

const movieTitles = [
  "Arrival",
  "Blade Runner 2049",
  "Dune: Part Two",
  "The Grand Budapest Hotel",
  "No Country for Old Men",
];
const seriesTitles = ["Severance", "Andor", "The Expanse", "Silo", "For All Mankind"];
const users = ["alex", "jordan", "sam", "taylor", "morgan"];
const qualities = ["1080p WEB-DL", "2160p WEB-DL", "Bluray-1080p", "Remux-2160p"];

const args = new Set(Deno.args);
const once = args.has("--once");
const intervalMs = readIntegerEnv("MOCK_EVENT_INTERVAL_MS", 2500);
const baseUrl = getBaseUrl();
const sharedSecret = Deno.env.get("SHARED_SECRET")?.trim();
const activeJourneys: Journey[] = [];

if (args.has("--help")) {
  printHelp();
  Deno.exit(0);
}

async function postMockEvent(event: MockEvent): Promise<void> {
  const response = await fetch(`${baseUrl}/webhook/${event.source}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sharedSecret ? { "x-sms-secret": sharedSecret } : {}),
    },
    body: JSON.stringify(event.payload),
  });

  const status = response.ok ? "ok" : "failed";
  console.log(
    `${new Date().toLocaleTimeString()} ${status} ${event.source} ${response.status} ${
      String(event.payload.eventType || event.payload.notificationType || "event")
    } ${String(event.payload.title || event.payload.subject || "")}`,
  );

  if (!response.ok) {
    console.log(await response.text());
  }
}

function nextJourneyEvent(): MockEvent {
  if (activeJourneys.length === 0 || Math.random() < 0.35) {
    activeJourneys.push(createJourney());
  }

  const journey = pick(activeJourneys);
  const event = journey.steps[journey.step](journey);
  journey.step += 1;

  if (journey.step >= journey.steps.length) {
    activeJourneys.splice(activeJourneys.indexOf(journey), 1);
  }

  return event;
}

function createJourney(): Journey {
  const kind: MediaKind = Math.random() < 0.55 ? "movie" : "series";
  const title = kind === "movie" ? pick(movieTitles) : pick(seriesTitles);
  const year = pick([2017, 2019, 2021, 2023, 2024, 2025]);
  const externalId = randomInt(100000, 999999);
  const base = {
    id: crypto.randomUUID(),
    kind,
    title,
    year,
    externalId,
    user: pick(users),
    quality: pick(qualities),
    step: 0,
  };

  return {
    ...base,
    steps: getJourneySteps(kind),
  };
}

const movieJourneySteps: Journey["steps"] = [
  (journey) => seerrEvent(journey, "MEDIA_PENDING", "Request submitted"),
  (journey) => seerrEvent(journey, "MEDIA_APPROVED", "Request approved"),
  (journey) => radarrEvent(journey, "MovieGrabbed", "Release grabbed from indexer"),
  (journey) => sabnzbdEvent(journey, "DownloadStarted", "Download started"),
  (journey) => sabnzbdEvent(journey, "DownloadComplete", "Download completed"),
  (journey) => radarrEvent(journey, "MovieDownloaded", "Movie imported"),
  (journey) => seerrEvent(journey, "MEDIA_AVAILABLE", "Media available"),
  (journey) => jellyfinEvent(journey, "ItemAdded", "Library item added"),
  (journey) => jellyfinEvent(journey, "PlaybackStart", `${journey.user} started playback`),
];

const seriesJourneySteps: Journey["steps"] = [
  (journey) => seerrEvent(journey, "MEDIA_PENDING", "Series request submitted"),
  (journey) => seerrEvent(journey, "MEDIA_APPROVED", "Series request approved"),
  (journey) => sonarrEvent(journey, "EpisodeGrabbed", "Episode grabbed"),
  (journey) => sabnzbdEvent(journey, "DownloadStarted", "Download started"),
  (journey) => sabnzbdEvent(journey, "DownloadComplete", "Download completed"),
  (journey) => sonarrEvent(journey, "Download", "Episode imported"),
  (journey) => seerrEvent(journey, "MEDIA_AVAILABLE", "Series available"),
  (journey) => jellyfinEvent(journey, "ItemAdded", "Episode added to library"),
  (journey) => jellyfinEvent(journey, "PlaybackStart", `${journey.user} started playback`),
];

function getJourneySteps(kind: MediaKind): Journey["steps"] {
  return kind === "movie" ? movieJourneySteps : seriesJourneySteps;
}

function seerrEvent(journey: Journey, notificationType: string, message: string): MockEvent {
  return {
    source: "seerr",
    payload: {
      notificationType,
      subject: journey.title,
      title: journey.title,
      mediaType: journey.kind,
      tmdbId: journey.kind === "movie" ? journey.externalId : undefined,
      tvdbId: journey.kind === "series" ? journey.externalId : undefined,
      year: journey.year,
      requestedBy: journey.user,
      message,
      requestId: journey.id,
    },
  };
}

function radarrEvent(journey: Journey, eventType: string, message: string): MockEvent {
  return {
    source: "radarr",
    payload: {
      eventType,
      mediaType: "movie",
      movie: {
        title: journey.title,
        year: journey.year,
        tmdbId: journey.externalId,
      },
      quality: journey.quality,
      downloadClient: "SABnzbd",
      message,
    },
  };
}

function sonarrEvent(journey: Journey, eventType: string, message: string): MockEvent {
  return {
    source: "sonarr",
    payload: {
      eventType,
      mediaType: "series",
      series: {
        title: journey.title,
        year: journey.year,
        tvdbId: journey.externalId,
      },
      episode: {
        title: `Episode ${randomInt(1, 10)}`,
        seasonNumber: 1,
        episodeNumber: randomInt(1, 10),
      },
      quality: journey.quality,
      downloadClient: "SABnzbd",
      message,
    },
  };
}

function sabnzbdEvent(journey: Journey, eventType: string, message: string): MockEvent {
  return {
    source: "sabnzbd",
    payload: {
      eventType,
      title: journey.title,
      mediaType: journey.kind,
      tmdbId: journey.kind === "movie" ? journey.externalId : undefined,
      tvdbId: journey.kind === "series" ? journey.externalId : undefined,
      name: `${journey.title}.${journey.quality.replaceAll(" ", ".")}`,
      status: eventType === "DownloadComplete" ? "Completed" : "Downloading",
      message,
    },
  };
}

function jellyfinEvent(journey: Journey, eventType: string, message: string): MockEvent {
  return {
    source: "jellyfin",
    payload: {
      eventType,
      title: journey.title,
      mediaType: journey.kind,
      tmdbId: journey.kind === "movie" ? journey.externalId : undefined,
      tvdbId: journey.kind === "series" ? journey.externalId : undefined,
      itemType: journey.kind === "movie" ? "Movie" : "Episode",
      userName: journey.user,
      message,
    },
  };
}

function getBaseUrl(): string {
  const explicitUrl = Deno.env.get("WEBHOOK_BASE_URL")?.trim();
  return explicitUrl ? explicitUrl.replace(/\/+$/, "") : `http://localhost:${Deno.env.get("PORT")?.trim() || "3020"}`;
}

function readIntegerEnv(name: string, fallback: number): number {
  const rawValue = Deno.env.get(name);
  const value = rawValue ? Number(rawValue) : fallback;

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name} value: ${rawValue}`);
  }

  return value;
}

function pick<T>(items: T[]): T {
  return items[randomInt(0, items.length - 1)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function printHelp(): void {
  console.log(`Mock webhook event generator

Usage:
  deno task mock:events
  deno task mock:events:once

Environment:
  WEBHOOK_BASE_URL          Target base URL. Defaults to http://localhost:$PORT.
  PORT                      Used for default target URL. Defaults to 3020.
  SHARED_SECRET             Sent as x-sms-secret when set.
  MOCK_EVENT_INTERVAL_MS    Continuous mode interval. Defaults to 2500.
`);
}

async function main(): Promise<void> {
  console.log(
    `Mock webhook target: ${baseUrl} (${once ? "one event" : `every ${intervalMs}ms`})`,
  );

  if (once) {
    await postMockEvent(nextJourneyEvent());
    return;
  }

  while (true) {
    await postMockEvent(nextJourneyEvent());
    await delay(intervalMs);
  }
}

await main();
