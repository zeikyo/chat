import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import {
  addWatch,
  getAllWatches,
  getSeenListingKeys,
  markListingSeen,
  markListingsSeen,
  removeWatch,
  updateWatchChecked,
  updateWatchError,
} from "../database.js";
import { config } from "../config.js";
import { assertBeebsUrl, scrapeListings } from "./scraper.js";

function log(message, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`[watcher] ${message}${suffix}`);
}

function formatDetectedTime(date = new Date()) {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris",
  }).format(date);
}

function shortProductLink(productUrl) {
  try {
    const parsed = new URL(productUrl);
    return parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname;
  } catch {
    return "";
  }
}

function watchedSearchLabel(watchUrl) {
  try {
    const parsed = new URL(watchUrl);
    const params = ["searchText", "q", "query", "search", "keywords"];
    const searchValue = params.map((name) => parsed.searchParams.get(name)).find(Boolean);

    if (searchValue) {
      return searchValue.trim();
    }

    return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname)
      .replace(/[-_]+/g, " ")
      .trim();
  } catch {
    return watchUrl;
  }
}

function listingIdentityLabel(listing) {
  if (listing.uniqueId) {
    return listing.uniqueId;
  }

  return shortProductLink(listing.productUrl) || "Non disponible";
}

function listingEmbed(listing, watchUrl, detectedAt = new Date()) {
  const identity = listingIdentityLabel(listing);
  const embed = new EmbedBuilder()
    .setTitle(listing.title || "Nouvelle annonce Beebs")
    .setColor(0x16a34a)
    .setTimestamp(detectedAt)
    .setFooter({ text: "Beebs Alert" })
    .addFields(
      { name: "Prix", value: listing.price || "Prix non disponible", inline: true },
      { name: "Recherche surveillée", value: watchedSearchLabel(watchUrl) || "Non disponible", inline: true },
      { name: "Mot-clé détecté", value: listing.detectedKeyword || watchedSearchLabel(watchUrl) || "Non disponible", inline: true },
      { name: "ID annonce", value: identity, inline: true },
      { name: "Détecté à", value: formatDetectedTime(detectedAt), inline: true },
    );

  if (listing.productUrl) {
    embed.setURL(listing.productUrl);
  }

  if (listing.imageUrl) {
    embed.setImage(listing.imageUrl);
  }

  return embed;
}

function listingButtons(listing, watchUrl) {
  const row = new ActionRowBuilder();

  if (listing.productUrl) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel("Ouvrir l'annonce")
        .setStyle(ButtonStyle.Link)
        .setURL(listing.productUrl),
    );
  }

  row.addComponents(
    new ButtonBuilder()
      .setLabel("Page surveillée")
      .setStyle(ButtonStyle.Link)
      .setURL(watchUrl),
  );

  return row;
}

export class BeebsWatcher {
  constructor(client) {
    this.client = client;
    this.interval = null;
    this.running = false;
  }

  start() {
    if (this.interval) {
      return;
    }

    log(`Starting watcher every ${config.checkIntervalMs / 1000}s`);
    this.interval = setInterval(() => {
      this.checkAll().catch((error) => {
        console.error("[watcher] Background check failed", error);
      });
    }, config.checkIntervalMs);

    setTimeout(() => {
      this.checkAll().catch((error) => {
        console.error("[watcher] Initial check failed", error);
      });
    }, 5_000);
  }

  stop() {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
    log("Stopped watcher");
  }

  async addWatch({ url, channelId, guildId, createdBy }) {
    const exactUrl = assertBeebsUrl(url);
    const watch = addWatch({ url: exactUrl, channelId, guildId, createdBy });

    log("Added watch", `id=${watch.id} channel=${channelId} url=${exactUrl}`);

    const listings = await scrapeListings(exactUrl);
    const seededCount = markListingsSeen(watch.id, listings);
    updateWatchChecked(watch.id);

    log("Seeded existing listings", `watch=${watch.id} count=${seededCount}`);
    return { watch, seededCount };
  }

  removeWatch(url) {
    const exactUrl = assertBeebsUrl(url);
    const removed = removeWatch(exactUrl);
    log(removed ? "Removed watch" : "No watch to remove", exactUrl);
    return removed;
  }

  async testUrl(url) {
    const exactUrl = assertBeebsUrl(url);
    return scrapeListings(exactUrl);
  }

  async checkAll() {
    if (this.running) {
      log("Skipping check, previous run still active");
      return;
    }

    this.running = true;

    try {
      const watches = getAllWatches();
      if (watches.length === 0) {
        log("No watched URLs");
        return;
      }

      log(`Checking ${watches.length} watched URL(s)`);
      for (const watch of watches) {
        await this.checkWatch(watch);
      }
    } finally {
      this.running = false;
    }
  }

  async checkWatch(watch) {
    try {
      const knownKeys = getSeenListingKeys(watch.id);
      const listings = await scrapeListings(watch.url, { knownKeys });
      const newListings = [];

      for (const listing of listings) {
        const inserted = markListingSeen(watch.id, listing);
        if (!inserted) {
          log("Reached already-seen listing, stopping this watch", `watch=${watch.id} listing=${listing.key}`);
          break;
        }

        newListings.push(listing);
      }

      updateWatchChecked(watch.id);

      if (newListings.length === 0) {
        log("No new listings", `watch=${watch.id}`);
        return;
      }

      log("New listings found", `watch=${watch.id} count=${newListings.length}`);
      for (const listing of newListings.reverse()) {
        await this.sendAlert(watch, listing);
      }
    } catch (error) {
      updateWatchError(watch.id, error);
      console.error(`[watcher] Check failed watch=${watch.id} url=${watch.url}`, error);
    }
  }

  async sendAlert(watch, listing) {
    const channel = await this.client.channels.fetch(watch.channel_id).catch((error) => {
      throw new Error(`Cannot fetch Discord channel ${watch.channel_id}: ${error.message}`);
    });

    if (!channel?.isTextBased()) {
      throw new Error(`Discord channel ${watch.channel_id} is not text-based`);
    }

    const detectedAt = new Date();
    await channel.send({
      embeds: [listingEmbed(listing, watch.url, detectedAt)],
      components: [listingButtons(listing, watch.url)],
    });

    log("Sent alert", `watch=${watch.id} listing=${listing.key}`);
  }
}
