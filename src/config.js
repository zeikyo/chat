import "dotenv/config";
import path from "node:path";

const projectRoot = process.cwd();

function readBoolean(value, defaultValue) {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function readInteger(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  guildId: process.env.DISCORD_GUILD_ID || "",
  databasePath: process.env.DATABASE_PATH || path.join(projectRoot, "data", "beebs.sqlite"),
  playwrightUserDataDir:
    process.env.PLAYWRIGHT_USER_DATA_DIR || path.join(projectRoot, "data", "playwright-profile"),
  beebsSitemapUrl:
    process.env.BEEBS_SITEMAP_URL ||
    "https://www.beebs.app/api/sitemaps/products/last-created/0",
  checkIntervalMs: readInteger(process.env.CHECK_INTERVAL_MS, 120_000),
  enablePlaywright: readBoolean(process.env.ENABLE_PLAYWRIGHT, false),
  enableCategoryFilter: readBoolean(process.env.ENABLE_CATEGORY_FILTER, false),
  playwrightHeadless: readBoolean(process.env.PLAYWRIGHT_HEADLESS, true),
  navigationTimeoutMs: readInteger(process.env.NAVIGATION_TIMEOUT_MS, 45_000),
  maxListingsPerCheck: readInteger(process.env.MAX_LISTINGS_PER_CHECK, 20),
  maxListingAgeMinutes: readInteger(process.env.MAX_LISTING_AGE_MINUTES, 10),
  sitemapScanLimit: readInteger(process.env.SITEMAP_SCAN_LIMIT, 10_000),
  scraperRetryAttempts: readInteger(process.env.SCRAPER_RETRY_ATTEMPTS, 3),
  scraperDelayMinMs: readInteger(process.env.SCRAPER_DELAY_MIN_MS, 500),
  scraperDelayMaxMs: readInteger(process.env.SCRAPER_DELAY_MAX_MS, 2_000),
  seenKeyLookupLimit: readInteger(process.env.SEEN_KEY_LOOKUP_LIMIT, 500),
};

if (!config.discordToken) {
  throw new Error("Missing DISCORD_TOKEN in environment. Copy .env.example to .env and fill it.");
}
