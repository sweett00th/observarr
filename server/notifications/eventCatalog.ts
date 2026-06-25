export type NotificationEventSource =
  | "jellyfin"
  | "seerr"
  | "radarr"
  | "sonarr"
  | "sabnzbd"
  | "system";

export type NotificationEventDefinition = {
  source: NotificationEventSource;
  sourceLabel: string;
  eventType: string;
  label: string;
};

export type NotificationEventGroup = {
  source: NotificationEventSource;
  label: string;
  events: Array<{
    eventType: string;
    label: string;
  }>;
};

export const notificationEventCatalog: NotificationEventGroup[] = [
  {
    source: "jellyfin",
    label: "Jellyfin",
    events: [
      { eventType: "item_added", label: "Item added" },
      { eventType: "playback_error", label: "Playback error" },
      { eventType: "authentication_failed", label: "Authentication failed" },
      { eventType: "user_locked_out", label: "User locked out" },
    ],
  },
  {
    source: "seerr",
    label: "Seerr",
    events: [
      { eventType: "request_pending", label: "Request pending" },
      { eventType: "request_approved", label: "Request approved" },
      { eventType: "request_declined", label: "Request declined" },
      { eventType: "request_available", label: "Request available" },
      { eventType: "issue_created", label: "Issue created" },
    ],
  },
  {
    source: "radarr",
    label: "Radarr",
    events: [
      { eventType: "grab", label: "Grab" },
      { eventType: "import", label: "Import" },
      { eventType: "upgrade", label: "Upgrade" },
      { eventType: "health_issue", label: "Health issue" },
    ],
  },
  {
    source: "sonarr",
    label: "Sonarr",
    events: [
      { eventType: "grab", label: "Grab" },
      { eventType: "import", label: "Import" },
      { eventType: "upgrade", label: "Upgrade" },
      { eventType: "health_issue", label: "Health issue" },
    ],
  },
  {
    source: "sabnzbd",
    label: "SABnzbd",
    events: [
      { eventType: "download", label: "Download" },
      { eventType: "pp", label: "Post-processing" },
      { eventType: "complete", label: "Complete" },
      { eventType: "failed", label: "Failed" },
      { eventType: "warning", label: "Warning" },
      { eventType: "error", label: "Error" },
      { eventType: "disk_full", label: "Disk full" },
      { eventType: "queue_done", label: "Queue done" },
    ],
  },
  {
    source: "system",
    label: "System",
    events: [
      { eventType: "app_started", label: "App started" },
      { eventType: "health_warning", label: "Health warning" },
    ],
  },
];

const validPairs = new Set(
  notificationEventCatalog.flatMap((group) =>
    group.events.map((event) => `${group.source}:${event.eventType}`)
  ),
);

export function isKnownNotificationEvent(source: string, eventType: string): boolean {
  return validPairs.has(`${source}:${eventType}`);
}
