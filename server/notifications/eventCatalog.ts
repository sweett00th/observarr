import { isCatalogEvent, templateCatalog } from "./templateCatalog.ts";

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

const groups = new Map<NotificationEventSource, NotificationEventGroup>();

for (const item of templateCatalog) {
  const source = item.source as NotificationEventSource;
  const group = groups.get(source) ?? { source, label: item.sourceLabel, events: [] };
  group.events.push({ eventType: item.eventType, label: item.label });
  groups.set(source, group);
}

export const notificationEventCatalog: NotificationEventGroup[] = [...groups.values()];

export function isKnownNotificationEvent(source: string, eventType: string): boolean {
  return isCatalogEvent(source, eventType);
}
