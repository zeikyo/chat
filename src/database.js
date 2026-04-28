import initSqlJs from "sql.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

let db;

function nowIso() {
  return new Date().toISOString();
}

function persistDatabase() {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
  const data = db.export();
  fs.writeFileSync(config.databasePath, Buffer.from(data));
}

function selectOne(sql, params = []) {
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : undefined;
  } finally {
    statement.free();
  }
}

function selectAll(sql, params = []) {
  const statement = db.prepare(sql);
  const rows = [];

  try {
    statement.bind(params);
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

function run(sql, params = []) {
  db.run(sql, params);
  const changes = db.getRowsModified();
  persistDatabase();
  return { changes };
}

export async function initDatabase() {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

  const SQL = await initSqlJs();
  if (fs.existsSync(config.databasePath)) {
    db = new SQL.Database(fs.readFileSync(config.databasePath));
  } else {
    db = new SQL.Database();
  }

  db.run("PRAGMA foreign_keys = ON");
  db.run(`
    CREATE TABLE IF NOT EXISTS watched_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL,
      guild_id TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      last_checked_at TEXT,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS seen_listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id INTEGER NOT NULL,
      listing_key TEXT NOT NULL,
      unique_id TEXT,
      title TEXT,
      price TEXT,
      product_url TEXT,
      image_url TEXT,
      first_seen_at TEXT NOT NULL,
      FOREIGN KEY (watch_id) REFERENCES watched_urls(id) ON DELETE CASCADE,
      UNIQUE (watch_id, listing_key)
    );

    CREATE INDEX IF NOT EXISTS idx_seen_listings_watch_id ON seen_listings(watch_id);
  `);
  persistDatabase();

  console.log(`[database] SQLite ready at ${config.databasePath}`);
  return db;
}

function getDb() {
  if (!db) {
    throw new Error("Database is not initialized. Call initDatabase() before using it.");
  }

  return db;
}

export function addWatch({ url, channelId, guildId, createdBy }) {
  getDb();
  const existing = selectOne("SELECT * FROM watched_urls WHERE url = ?", [url]);
  const timestamp = nowIso();

  if (existing) {
    run(
      "UPDATE watched_urls SET channel_id = ?, guild_id = ?, created_by = ?, last_error = NULL WHERE url = ?",
      [channelId, guildId, createdBy, url],
    );
    return selectOne("SELECT * FROM watched_urls WHERE url = ?", [url]);
  }

  run(
    "INSERT INTO watched_urls (url, channel_id, guild_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    [url, channelId, guildId, createdBy, timestamp],
  );

  return selectOne("SELECT * FROM watched_urls WHERE url = ?", [url]);
}

export function removeWatch(url) {
  const result = run("DELETE FROM watched_urls WHERE url = ?", [url]);
  return result.changes > 0;
}

export function removeWatchById(watchId) {
  const result = run("DELETE FROM watched_urls WHERE id = ?", [watchId]);
  return result.changes > 0;
}

export function getWatchById(watchId) {
  getDb();
  return selectOne("SELECT * FROM watched_urls WHERE id = ?", [watchId]);
}

export function getWatchByUrl(url) {
  getDb();
  return selectOne("SELECT * FROM watched_urls WHERE url = ?", [url]);
}

export function getAllWatches() {
  getDb();
  return selectAll("SELECT * FROM watched_urls ORDER BY created_at ASC");
}

export function getSeenListingKeys(watchId, limit = config.seenKeyLookupLimit) {
  getDb();
  return selectAll(
    `
      SELECT listing_key
      FROM seen_listings
      WHERE watch_id = ?
      ORDER BY id DESC
      LIMIT ?
    `,
    [watchId, limit],
  ).map((row) => row.listing_key);
}

export function markListingSeen(watchId, listing) {
  const result = run(
    `
      INSERT OR IGNORE INTO seen_listings
        (watch_id, listing_key, unique_id, title, price, product_url, image_url, first_seen_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      watchId,
      listing.key,
      listing.uniqueId || null,
      listing.title || null,
      listing.price || null,
      listing.productUrl || null,
      listing.imageUrl || null,
      nowIso(),
    ],
  );

  return result.changes > 0;
}

export function markListingsSeen(watchId, listings) {
  getDb();
  let inserted = 0;

  db.run("BEGIN TRANSACTION");
  try {
    for (const listing of listings) {
      db.run(
        `
          INSERT OR IGNORE INTO seen_listings
            (watch_id, listing_key, unique_id, title, price, product_url, image_url, first_seen_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          watchId,
          listing.key,
          listing.uniqueId || null,
          listing.title || null,
          listing.price || null,
          listing.productUrl || null,
          listing.imageUrl || null,
          nowIso(),
        ],
      );
      inserted += db.getRowsModified();
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }

  persistDatabase();
  return inserted;
}

export function updateWatchChecked(watchId) {
  run("UPDATE watched_urls SET last_checked_at = ?, last_error = NULL WHERE id = ?", [
    nowIso(),
    watchId,
  ]);
}

export function updateWatchError(watchId, error) {
  run("UPDATE watched_urls SET last_checked_at = ?, last_error = ? WHERE id = ?", [
    nowIso(),
    String(error?.message || error).slice(0, 1000),
    watchId,
  ]);
}
