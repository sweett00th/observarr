import type { DB } from "sqlite";
import { createJellyfinSessionSource } from "../integrations/jellyfin/sessions.ts";
import { createSabnzbdClient } from "../integrations/sabnzbd/client.ts";
import {
  getJellyfinApiKey,
  getJellyfinUrl,
  getSabnzbdApiKey,
  getSabnzbdUrl,
  getSharedSecret,
} from "../lib/config.ts";
import { BandwidthController } from "./controller.ts";
import { SqliteBandwidthStore } from "./settings.ts";

/** The controller wired to the environment's Jellyfin and SABnzbd and to the SQLite settings. */
export function createBandwidthController(db: DB): BandwidthController {
  const jellyfinUrl = getJellyfinUrl();
  const jellyfinApiKey = getJellyfinApiKey();
  const sabnzbdUrl = getSabnzbdUrl();
  const sabnzbdApiKey = getSabnzbdApiKey();

  return new BandwidthController({
    store: new SqliteBandwidthStore(db),
    jellyfin: jellyfinUrl && jellyfinApiKey
      ? createJellyfinSessionSource({ url: jellyfinUrl, apiKey: jellyfinApiKey })
      : null,
    sabnzbd: sabnzbdUrl && sabnzbdApiKey
      ? createSabnzbdClient({ url: sabnzbdUrl, apiKey: sabnzbdApiKey })
      : null,
    secrets: [jellyfinApiKey, sabnzbdApiKey, getSharedSecret()],
  });
}

export { BandwidthConfigurationError, BandwidthController } from "./controller.ts";
