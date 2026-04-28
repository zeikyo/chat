import crypto from "node:crypto";
import { config } from "../config.js";

let playwrightContextPromise;
const SITEMAP_RECENT_POSITION_LIMIT = 50;

function log(message, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`[scraper] ${message}${suffix}`);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function xmlDecode(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function hashListing(listing) {
  return crypto
    .createHash("sha256")
    .update([listing.title, listing.price, listing.productUrl, listing.imageUrl].filter(Boolean).join("|"))
    .digest("hex")
    .slice(0, 24);
}

function buildListingKey(listing) {
  if (listing.uniqueId) {
    return `id:${listing.uniqueId}`;
  }

  if (listing.productUrl) {
    return `url:${listing.productUrl.replace(/#.*$/, "")}`;
  }

  return `hash:${hashListing(listing)}`;
}

function buildListingDuplicateKey(listing) {
  const normalizedTitle = normalizeText(listing.title);
  const identity = listing.uniqueId
    ? `id:${listing.uniqueId}`
    : `url:${String(listing.productUrl || "").replace(/#.*$/, "")}`;

  return `${normalizedTitle}|${identity}`;
}

function normalizeListing(raw) {
  const listing = {
    title: raw.title?.trim() || "Annonce Beebs",
    price: raw.price?.trim() || "",
    imageUrl: raw.imageUrl?.trim() || "",
    productUrl: raw.productUrl?.trim() || "",
    uniqueId: raw.uniqueId ? String(raw.uniqueId).trim() : "",
    lastmod: raw.lastmod?.trim() || "",
    sitemapPosition: Number.isFinite(raw.sitemapPosition) ? raw.sitemapPosition : null,
  };

  listing.key = buildListingKey(listing);
  listing.duplicateKey = buildListingDuplicateKey(listing);
  return listing;
}

function titleFromProductUrl(productUrl) {
  try {
    const parsed = new URL(productUrl);
    const slug = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "");
    const withoutId = slug.replace(/^\d+[-_]?/, "");
    return withoutId
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  } catch {
    return "Annonce Beebs";
  }
}

function idFromProductUrl(productUrl) {
  const match = String(productUrl || "").match(/\/p\/(\d+)/);
  return match?.[1] || "";
}

function parseSitemapXml(xml) {
  const entries = [];
  const urlBlocks = String(xml || "").match(/<url\b[\s\S]*?<\/url>/gi) || [];

  for (const block of urlBlocks) {
    const loc = xmlDecode(block.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1]?.trim());
    if (!loc) {
      continue;
    }

    const lastmod = xmlDecode(block.match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1]?.trim());
    entries.push(
      normalizeListing({
        title: titleFromProductUrl(loc),
        productUrl: loc,
        uniqueId: idFromProductUrl(loc),
        lastmod,
        sitemapPosition: entries.length + 1,
      }),
    );
  }

  return entries;
}

function getSearchTextTokens(watchUrl) {
  try {
    const parsed = new URL(watchUrl);
    const params = ["searchText", "q", "query", "search", "keywords"];
    const text = params.map((name) => parsed.searchParams.get(name)).filter(Boolean).join(" ");
    return tokenizeQuery(text);
  } catch {
    return [];
  }
}

function getCategoryTokens(watchUrl) {
  try {
    const parsed = new URL(watchUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const categoryIndex = segments.findIndex((segment) => ["ca", "category", "categorie"].includes(segment));

    if (categoryIndex === -1 || !segments[categoryIndex + 1]) {
      return [];
    }

    const categorySlug = decodeURIComponent(segments[categoryIndex + 1])
      .replace(/[A-Za-z0-9]{12,}$/g, "")
      .replace(/[-_]+/g, " ");

    return tokenizeQuery(categorySlug);
  } catch {
    return [];
  }
}

function tokenizeQuery(value) {
  return uniq(
    normalizeText(value)
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2),
  );
}

function parseWatchFilters(watchUrl) {
  const searchTokens = getSearchTextTokens(watchUrl);
  const categoryTokens = getCategoryTokens(watchUrl);
  const categoryFilterEnabled = config.enableCategoryFilter;

  return {
    searchTokens,
    categoryTokens,
    categoryFilterEnabled,
    activeTokens: uniq([
      ...searchTokens,
      ...(categoryFilterEnabled ? categoryTokens : []),
    ]),
  };
}

function getListingFilterMatch(listing, filters) {
  const haystack = normalizeText([listing.title, listing.productUrl].filter(Boolean).join(" "));
  const matchedSearchTokens = filters.searchTokens.filter((token) => haystack.includes(token));
  const matchedCategoryTokens = filters.categoryTokens.filter((token) => haystack.includes(token));
  const matchesSearch =
    filters.searchTokens.length === 0 || matchedSearchTokens.length === filters.searchTokens.length;
  const matchesCategory =
    filters.categoryTokens.length === 0 || matchedCategoryTokens.length > 0;
  const matchesActiveFilter =
    matchesSearch && (!filters.categoryFilterEnabled || matchesCategory);

  return {
    matchesSearch,
    matchesCategory,
    matchesActiveFilter,
    detectedKeyword: matchedSearchTokens[0] || matchedCategoryTokens[0] || filters.activeTokens[0] || "",
  };
}

function formatAgeMinutes(ageMinutes) {
  if (!Number.isFinite(ageMinutes)) {
    return "unknown";
  }

  if (ageMinutes < 1) {
    return `${Math.max(0, Math.round(ageMinutes * 60))}s`;
  }

  if (ageMinutes < 120) {
    return `${Math.round(ageMinutes)}m`;
  }

  return `${Math.round(ageMinutes / 60)}h`;
}

function getListingAgeInfo(listing, now = Date.now()) {
  const publishedAtMs = Date.parse(listing.lastmod);

  if (Number.isFinite(publishedAtMs)) {
    return {
      ageMinutes: Math.max(0, (now - publishedAtMs) / 60_000),
      publishedAt: new Date(publishedAtMs).toISOString(),
      source: "lastmod",
      isReliable: true,
    };
  }

  if (Number.isFinite(listing.sitemapPosition) && listing.sitemapPosition > 0) {
    const estimatedAgeMinutes =
      ((listing.sitemapPosition - 1) / SITEMAP_RECENT_POSITION_LIMIT) * config.maxListingAgeMinutes;

    return {
      ageMinutes: Math.max(0, estimatedAgeMinutes),
      publishedAt: "",
      source: "sitemap_position",
      isReliable: false,
    };
  }

  return {
    ageMinutes: Number.POSITIVE_INFINITY,
    publishedAt: "",
    source: "unknown",
    isReliable: false,
  };
}

function isListingRecentEnough(listing, ageInfo) {
  const isRecentByAge = ageInfo.ageMinutes <= config.maxListingAgeMinutes;
  const isTopSitemapListing =
    !ageInfo.isReliable &&
    Number.isFinite(listing.sitemapPosition) &&
    listing.sitemapPosition > 0 &&
    listing.sitemapPosition <= SITEMAP_RECENT_POSITION_LIMIT;

  return isRecentByAge || isTopSitemapListing;
}

function attachAgeInfo(listing, ageInfo) {
  listing.ageMinutes = ageInfo.ageMinutes;
  listing.ageLabel = formatAgeMinutes(ageInfo.ageMinutes);
  listing.ageSource = ageInfo.source;
  listing.publishedAt = ageInfo.publishedAt;
  return listing;
}

export function assertBeebsUrl(url) {
  const trimmed = String(url || "").trim();

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("URL invalide.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("L'URL doit commencer par http:// ou https://.");
  }

  if (!parsed.hostname.toLowerCase().includes("beebs")) {
    throw new Error("L'URL doit etre une URL Beebs.");
  }

  return trimmed;
}

async function fetchSitemapListings() {
  log("Using sitemap mode", config.beebsSitemapUrl);

  const response = await fetch(config.beebsSitemapUrl, {
    headers: {
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "BeebsDiscordAlerts/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Beebs sitemap returned HTTP ${response.status}`);
  }

  const xml = await response.text();
  const listings = parseSitemapXml(xml);
  log(`Sitemap returned ${listings.length} recent product(s)`);
  return listings;
}

async function scrapeWithPlaywright(inputUrl, options = {}) {
  if (!config.enablePlaywright) {
    return [];
  }

  log("Using optional Playwright mode", inputUrl);
  const { chromium } = await import("playwright");

  if (!playwrightContextPromise) {
    playwrightContextPromise = chromium.launchPersistentContext(config.playwrightUserDataDir, {
      headless: config.playwrightHeadless,
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
      viewport: { width: 1365, height: 900 },
    });
  }

  const context = await playwrightContextPromise;
  const page = await context.newPage();

  try {
    const response = await page.goto(inputUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });

    if (response?.status() >= 400) {
      throw new Error(`Beebs page returned HTTP ${response.status()}`);
    }

    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    const urls = await page.$$eval("a[href*='/p/']", (anchors) =>
      anchors.map((anchor) => new URL(anchor.getAttribute("href"), window.location.href).href),
    );

    return uniq(urls)
      .slice(0, Math.min(options.maxListings || config.maxListingsPerCheck, 20))
      .map((productUrl) =>
        normalizeListing({
          title: titleFromProductUrl(productUrl),
          productUrl,
          uniqueId: idFromProductUrl(productUrl),
        }),
      );
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (!playwrightContextPromise) {
    return;
  }

  const context = await playwrightContextPromise.catch(() => undefined);
  await context?.close().catch(() => {});
  playwrightContextPromise = undefined;
}

export async function scrapeListings(inputUrl, options = {}) {
  const watchUrl = assertBeebsUrl(inputUrl);
  const maxListings = Math.min(options.maxListings || config.maxListingsPerCheck, 20);
  const scanLimit = Math.max(1, options.scanLimit || config.sitemapScanLimit);
  const knownKeys = new Set(options.knownKeys || []);
  const filters = parseWatchFilters(watchUrl);
  const now = Date.now();

  log(
    "Filtering sitemap products",
    [
      `search=[${filters.searchTokens.join(",") || "-"}]`,
      `category=[${filters.categoryTokens.join(",") || "-"}]`,
      `category_filter=${filters.categoryFilterEnabled ? "applied" : "ignored"}`,
      `max_age=${config.maxListingAgeMinutes}m`,
      `top_position_limit=${SITEMAP_RECENT_POSITION_LIMIT}`,
    ].join(" "),
  );

  const sourceListings = await fetchSitemapListings();
  const matches = [];
  const matchedDuplicateKeys = new Set();
  let scannedCount = 0;
  let keywordMatchCount = 0;
  let categoryMatchCount = 0;
  let activeFilterMatchCount = 0;
  let staleIgnoredCount = 0;
  let duplicateIgnoredCount = 0;
  let seenMatchCount = 0;
  const ageSamples = [];

  for (const listing of sourceListings) {
    if (scannedCount >= scanLimit) {
      break;
    }

    scannedCount += 1;
    const match = getListingFilterMatch(listing, filters);

    if (match.matchesSearch) {
      keywordMatchCount += 1;
    }

    if (match.matchesCategory) {
      categoryMatchCount += 1;
    }

    if (!match.matchesActiveFilter) {
      continue;
    }

    activeFilterMatchCount += 1;
    listing.detectedKeyword = match.detectedKeyword;
    const ageInfo = getListingAgeInfo(listing, now);
    attachAgeInfo(listing, ageInfo);

    if (ageSamples.length < 8) {
      ageSamples.push(
        `#${listing.sitemapPosition || "?"}:${listing.ageLabel}:${ageInfo.source}`,
      );
    }

    if (!isListingRecentEnough(listing, ageInfo)) {
      staleIgnoredCount += 1;

      if (staleIgnoredCount <= 5) {
        log(
          "Ignoring old listing",
          [
            `position=${listing.sitemapPosition || "?"}`,
            `age=${listing.ageLabel}`,
            `source=${ageInfo.source}`,
            `max_age=${config.maxListingAgeMinutes}m`,
            `lastmod=${listing.lastmod || "-"}`,
            `listing=${listing.key}`,
          ].join(" "),
        );
      }

      continue;
    }

    if (matchedDuplicateKeys.has(listing.duplicateKey)) {
      duplicateIgnoredCount += 1;
      continue;
    }

    matchedDuplicateKeys.add(listing.duplicateKey);

    if (knownKeys.has(listing.key)) {
      seenMatchCount += 1;
      continue;
    }

    matches.push(listing);
    if (matches.length >= maxListings) {
      break;
    }
  }

  if (matches.length === 0 && config.enablePlaywright) {
    log("No sitemap match; optional Playwright fallback enabled", watchUrl);
    return scrapeWithPlaywright(watchUrl, options);
  }

  log(
    "Sitemap scan summary",
    [
      `scanned=${scannedCount}`,
      `scan_limit=${scanLimit}`,
      `keyword_matches=${keywordMatchCount}`,
      `category_filter=${filters.categoryFilterEnabled ? "applied" : "ignored"}`,
      filters.categoryFilterEnabled ? `category_matches=${categoryMatchCount}` : "",
      `active_filter_matches=${activeFilterMatchCount}`,
      `stale_ignored=${staleIgnoredCount}`,
      `duplicate_ignored=${duplicateIgnoredCount}`,
      `seen_matches=${seenMatchCount}`,
      `new_matches=${matches.length}`,
      ageSamples.length ? `age_samples=[${ageSamples.join(";")}]` : "",
      `url=${watchUrl}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return matches;
}
