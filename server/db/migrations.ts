import type { DB } from "sqlite";

type Migration = {
  version: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_persistence_and_auth",
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX sessions_user_id_idx ON sessions(user_id);
      CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

      CREATE TABLE message_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        destination TEXT,
        profile_name TEXT,
        provider TEXT,
        provider_message_id TEXT,
        status TEXT,
        raw_payload TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE notification_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE event_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL UNIQUE,
        template_body TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE provider_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, key)
      );

      CREATE TABLE webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT,
        event_type TEXT,
        summary TEXT,
        raw_payload TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "tracked_media_timelines",
    sql: `
      CREATE TABLE tracked_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_key TEXT NOT NULL UNIQUE,
        media_type TEXT,
        title TEXT NOT NULL,
        source TEXT,
        status TEXT NOT NULL DEFAULT 'tracking',
        created_from_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE tracked_media_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracked_media_id INTEGER NOT NULL,
        live_event_id TEXT,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        raw_payload TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (tracked_media_id) REFERENCES tracked_media(id) ON DELETE CASCADE
      );

      CREATE INDEX tracked_media_events_media_id_idx ON tracked_media_events(tracked_media_id);
      CREATE INDEX tracked_media_events_timestamp_idx ON tracked_media_events(timestamp);
    `,
  },
];

export function runMigrations(db: DB): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedVersions = new Set<number>(
    [...db.query("SELECT version FROM schema_migrations")].map(([version]) => Number(version)),
  );

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    const appliedAt = new Date().toISOString();

    try {
      db.execute("BEGIN");
      db.execute(migration.sql);
      db.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, appliedAt],
      );
      db.execute("COMMIT");
      console.log(`Applied database migration ${migration.version}: ${migration.name}`);
    } catch (error) {
      db.execute("ROLLBACK");
      throw error;
    }
  }
}
