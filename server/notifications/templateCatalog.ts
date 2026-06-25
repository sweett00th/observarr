export type TemplateVariable = {
  name: string;
  label: string;
  description: string;
  example: string;
};

export type TemplateCatalogEvent = {
  source: string;
  sourceLabel: string;
  eventType: string;
  label: string;
  description: string;
  defaultSmsTemplate: string;
  defaultEmailSubjectTemplate: string;
  defaultEmailBodyTemplate: string;
  variables: TemplateVariable[];
  sampleContext: Record<string, string>;
};

const commonVariables: TemplateVariable[] = [
  {
    name: "appName",
    label: "App name",
    description: "The ObservaRR product name.",
    example: "ObservaRR",
  },
  {
    name: "source",
    label: "Source",
    description: "The application that produced the event.",
    example: "Seerr",
  },
  {
    name: "eventType",
    label: "Event type",
    description: "The stable ObservaRR event type.",
    example: "request_available",
  },
  {
    name: "eventTitle",
    label: "Event title",
    description: "Short normalized event title.",
    example: "Movie available",
  },
  {
    name: "eventMessage",
    label: "Event message",
    description: "Safe normalized event summary.",
    example: "The requested movie is available.",
  },
  {
    name: "occurredAt",
    label: "Occurred at",
    description: "Event timestamp in ISO format.",
    example: "2026-06-25T12:00:00.000Z",
  },
  {
    name: "profileName",
    label: "Profile name",
    description: "Recipient profile display name.",
    example: "Alex",
  },
  {
    name: "mediaTitle",
    label: "Media title",
    description: "Best known media title.",
    example: "Example Movie",
  },
  {
    name: "mediaYear",
    label: "Media year",
    description: "Best known media year when available.",
    example: "2026",
  },
  {
    name: "quality",
    label: "Quality",
    description: "Quality label when provided by the source.",
    example: "1080p",
  },
  {
    name: "fileSize",
    label: "File size",
    description: "Human-readable file size when provided.",
    example: "8.4 GB",
  },
  {
    name: "libraryName",
    label: "Library name",
    description: "Jellyfin or media library name when available.",
    example: "Movies",
  },
  {
    name: "errorMessage",
    label: "Error message",
    description: "Safe error summary when available.",
    example: "Playback failed",
  },
];

const movieVariables: TemplateVariable[] = [
  {
    name: "movieTitle",
    label: "Movie title",
    description: "Movie title when available.",
    example: "Example Movie",
  },
  {
    name: "movieYear",
    label: "Movie year",
    description: "Movie release year when available.",
    example: "2026",
  },
];

const episodeVariables: TemplateVariable[] = [
  {
    name: "seriesTitle",
    label: "Series title",
    description: "Series title when available.",
    example: "Example Series",
  },
  {
    name: "episodeTitle",
    label: "Episode title",
    description: "Episode title when available.",
    example: "Pilot",
  },
  {
    name: "seasonNumber",
    label: "Season",
    description: "Season number when available.",
    example: "1",
  },
  {
    name: "episodeNumber",
    label: "Episode",
    description: "Episode number when available.",
    example: "2",
  },
];

const seerrVariables: TemplateVariable[] = [
  {
    name: "requestStatus",
    label: "Request status",
    description: "Request status from Seerr.",
    example: "available",
  },
  {
    name: "requesterName",
    label: "Requester name",
    description: "Display name of the requester when available.",
    example: "Alex",
  },
  {
    name: "requestedByUsername",
    label: "Requester username",
    description: "Username of the requester when available.",
    example: "alex",
  },
];

const sabVariables: TemplateVariable[] = [
  {
    name: "downloadName",
    label: "Download name",
    description: "SABnzbd download name.",
    example: "Example.Movie.2026.1080p",
  },
  { name: "category", label: "Category", description: "SABnzbd category.", example: "movies" },
  {
    name: "postProcessingStatus",
    label: "Post-processing",
    description: "Post-processing status.",
    example: "complete",
  },
  {
    name: "downloadStatus",
    label: "Download status",
    description: "Download status.",
    example: "complete",
  },
];

const jellyfinVariables: TemplateVariable[] = [
  {
    name: "username",
    label: "Username",
    description: "Jellyfin username when available.",
    example: "alex",
  },
  {
    name: "deviceName",
    label: "Device",
    description: "Playback device when available.",
    example: "Living Room TV",
  },
  {
    name: "itemType",
    label: "Item type",
    description: "Jellyfin item type when available.",
    example: "Movie",
  },
];

function event(
  source: string,
  sourceLabel: string,
  eventType: string,
  label: string,
  description: string,
  extraVariables: TemplateVariable[] = [],
): TemplateCatalogEvent {
  const variables = uniqueVariables([...commonVariables, ...extraVariables]);
  const sampleContext = Object.fromEntries(
    variables.map((variable) => [variable.name, variable.example]),
  );
  sampleContext.source = sourceLabel;
  sampleContext.eventType = eventType;
  sampleContext.eventTitle = label;
  sampleContext.eventMessage = description;

  return {
    source,
    sourceLabel,
    eventType,
    label,
    description,
    defaultSmsTemplate: "ObservaRR: {eventTitle}",
    defaultEmailSubjectTemplate: "[ObservaRR] {eventTitle}",
    defaultEmailBodyTemplate: "{eventMessage}\n\nSource: {source}\nTime: {occurredAt}",
    variables,
    sampleContext,
  };
}

export const templateCatalog: TemplateCatalogEvent[] = [
  event("jellyfin", "Jellyfin", "item_added", "Item added", "A Jellyfin library item was added.", [
    ...jellyfinVariables,
    ...movieVariables,
    ...episodeVariables,
  ]),
  event(
    "jellyfin",
    "Jellyfin",
    "playback_error",
    "Playback error",
    "Jellyfin reported a playback error.",
    jellyfinVariables,
  ),
  event(
    "jellyfin",
    "Jellyfin",
    "authentication_failed",
    "Authentication failed",
    "A Jellyfin authentication attempt failed.",
    jellyfinVariables,
  ),
  event(
    "jellyfin",
    "Jellyfin",
    "user_locked_out",
    "User locked out",
    "A Jellyfin user was locked out.",
    jellyfinVariables,
  ),

  event(
    "seerr",
    "Seerr",
    "request_pending",
    "Request pending",
    "A media request is pending approval.",
    [...seerrVariables, ...movieVariables, ...episodeVariables],
  ),
  event("seerr", "Seerr", "request_approved", "Request approved", "A media request was approved.", [
    ...seerrVariables,
    ...movieVariables,
    ...episodeVariables,
  ]),
  event("seerr", "Seerr", "request_declined", "Request declined", "A media request was declined.", [
    ...seerrVariables,
    ...movieVariables,
    ...episodeVariables,
  ]),
  event(
    "seerr",
    "Seerr",
    "request_available",
    "Request available",
    "A requested media item is available.",
    [...seerrVariables, ...movieVariables, ...episodeVariables],
  ),
  event(
    "seerr",
    "Seerr",
    "issue_created",
    "Issue created",
    "A Seerr issue was created.",
    seerrVariables,
  ),

  event("radarr", "Radarr", "grab", "Grab", "Radarr grabbed a release.", movieVariables),
  event("radarr", "Radarr", "import", "Import", "Radarr imported a movie file.", movieVariables),
  event("radarr", "Radarr", "upgrade", "Upgrade", "Radarr upgraded a movie file.", movieVariables),
  event("radarr", "Radarr", "health_issue", "Health issue", "Radarr reported a health issue."),

  event("sonarr", "Sonarr", "grab", "Grab", "Sonarr grabbed a release.", episodeVariables),
  event(
    "sonarr",
    "Sonarr",
    "import",
    "Import",
    "Sonarr imported an episode file.",
    episodeVariables,
  ),
  event(
    "sonarr",
    "Sonarr",
    "upgrade",
    "Upgrade",
    "Sonarr upgraded an episode file.",
    episodeVariables,
  ),
  event("sonarr", "Sonarr", "health_issue", "Health issue", "Sonarr reported a health issue."),

  event(
    "sabnzbd",
    "SABnzbd",
    "download",
    "Download",
    "SABnzbd download activity occurred.",
    sabVariables,
  ),
  event(
    "sabnzbd",
    "SABnzbd",
    "pp",
    "Post-processing",
    "SABnzbd post-processing activity occurred.",
    sabVariables,
  ),
  event(
    "sabnzbd",
    "SABnzbd",
    "complete",
    "Complete",
    "SABnzbd completed a download.",
    sabVariables,
  ),
  event(
    "sabnzbd",
    "SABnzbd",
    "failed",
    "Failed",
    "SABnzbd reported a failed download.",
    sabVariables,
  ),
  event("sabnzbd", "SABnzbd", "warning", "Warning", "SABnzbd reported a warning.", sabVariables),
  event("sabnzbd", "SABnzbd", "error", "Error", "SABnzbd reported an error.", sabVariables),
  event(
    "sabnzbd",
    "SABnzbd",
    "disk_full",
    "Disk full",
    "SABnzbd reported that disk space is full.",
    sabVariables,
  ),
  event(
    "sabnzbd",
    "SABnzbd",
    "queue_done",
    "Queue done",
    "SABnzbd completed its queue.",
    sabVariables,
  ),

  event("system", "System", "app_started", "App started", "ObservaRR started."),
  event(
    "system",
    "System",
    "health_warning",
    "Health warning",
    "ObservaRR reported a health warning.",
  ),
];

const catalogByKey = new Map(
  templateCatalog.map((item) => [`${item.source}:${item.eventType}`, item]),
);

export function getCatalogEvent(source: string, eventType: string): TemplateCatalogEvent | null {
  return catalogByKey.get(`${source}:${eventType}`) ?? null;
}

export function isCatalogEvent(source: string, eventType: string): boolean {
  return catalogByKey.has(`${source}:${eventType}`);
}

export function allowedVariableNames(source: string, eventType: string): Set<string> {
  const item = getCatalogEvent(source, eventType);
  return new Set(item?.variables.map((variable) => variable.name) ?? []);
}

export function mapToCatalogEventType(source: string, eventType: string): string | null {
  const normalized = normalizeEventType(eventType);
  const aliases: Record<string, Record<string, string>> = {
    jellyfin: {
      itemadded: "item_added",
      libraryitemadded: "item_added",
      playbackerror: "playback_error",
      authenticationfailed: "authentication_failed",
      userlockedout: "user_locked_out",
    },
    seerr: {
      requestpending: "request_pending",
      requestapproved: "request_approved",
      requestdeclined: "request_declined",
      requestavailable: "request_available",
      mediaavailable: "request_available",
      issuecreated: "issue_created",
    },
    radarr: {
      grab: "grab",
      moviegrabbed: "grab",
      download: "grab",
      import: "import",
      moviedownloaded: "import",
      downloadcomplete: "import",
      upgrade: "upgrade",
      healthissue: "health_issue",
    },
    sonarr: {
      grab: "grab",
      episodegrabbed: "grab",
      download: "grab",
      import: "import",
      episodedownloaded: "import",
      downloadcomplete: "import",
      upgrade: "upgrade",
      healthissue: "health_issue",
    },
    sabnzbd: {
      download: "download",
      pp: "pp",
      postprocessing: "pp",
      complete: "complete",
      failed: "failed",
      warning: "warning",
      error: "error",
      diskfull: "disk_full",
      queuedone: "queue_done",
    },
    system: {
      appstarted: "app_started",
      healthwarning: "health_warning",
    },
  };
  const mapped = aliases[source]?.[normalized] ?? eventType;
  return isCatalogEvent(source, mapped) ? mapped : null;
}

function normalizeEventType(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function uniqueVariables(variables: TemplateVariable[]): TemplateVariable[] {
  const seen = new Set<string>();
  return variables.filter((variable) => {
    if (seen.has(variable.name)) {
      return false;
    }
    seen.add(variable.name);
    return true;
  });
}
