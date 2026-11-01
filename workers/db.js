/**
 * Shared Cloudflare D1 Database Initializer for Trove
 * Auto-creates playlists, metrics, and history tables
 */

let schemaInitialized = false;

export async function ensureSchema(db) {
  if (schemaInitialized || !db) return;

  await db.batch([
    // Playlists & Queue Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        items TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      )
    `),

    // Playback Metrics Aggregate Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS track_metrics (
        path TEXT PRIMARY KEY,
        title TEXT,
        artist TEXT,
        duration REAL DEFAULT 0,
        play_count INTEGER NOT NULL DEFAULT 1,
        complete_count INTEGER NOT NULL DEFAULT 0,
        first_played_at INTEGER NOT NULL,
        last_played_at INTEGER NOT NULL,
        total_play_time REAL DEFAULT 0
      )
    `),

    // Time-series Listening Event Log Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS play_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        played_at INTEGER NOT NULL,
        hour_of_day INTEGER NOT NULL,
        day_of_week INTEGER NOT NULL
      )
    `),

    // Ingest Jobs Tracking Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ingest_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        targets_count INTEGER DEFAULT 0,
        format TEXT DEFAULT 'm4a',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `),

    // Ingest Events & Live Song Status Table
    db.prepare(`
      CREATE TABLE IF NOT EXISTS ingest_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        song_id TEXT,
        url TEXT,
        title TEXT,
        status TEXT NOT NULL,
        error TEXT,
        timestamp INTEGER NOT NULL
      )
    `),

    // Indexes for high-speed queries
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_playlists_updated ON playlists(updated_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_track_metrics_play_count ON track_metrics(play_count DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_track_metrics_last_played ON track_metrics(last_played_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_play_history_played_at ON play_history(played_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ingest_events_job ON ingest_events(job_id, timestamp ASC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_ingest_jobs_updated ON ingest_jobs(updated_at DESC)`)
  ]);

  schemaInitialized = true;
}

