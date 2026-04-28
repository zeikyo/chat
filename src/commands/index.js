import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  time,
} from "discord.js";
import { getAllWatches, getWatchById, removeWatchById } from "../database.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("watch")
    .setDescription("Surveille une page Beebs et envoie les nouvelles annonces dans un salon.")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("URL de recherche ou categorie Beebs a surveiller")
        .setRequired(true),
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Salon Discord ou envoyer les alertes")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("unwatch")
    .setDescription("Arrete de surveiller une URL Beebs.")
    .addStringOption((option) =>
      option.setName("url").setDescription("URL Beebs a retirer").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("list")
    .setDescription("Liste les pages Beebs surveillees."),

  new SlashCommandBuilder()
    .setName("test")
    .setDescription("Teste une URL Beebs avec le mode sitemap sans l'ajouter a la surveillance.")
    .addStringOption((option) =>
      option.setName("url").setDescription("URL Beebs a tester").setRequired(true),
    ),
];

function getUrl(interaction) {
  return interaction.options.getString("url", true).trim();
}

function makeTestEmbed(url, listings) {
  const embed = new EmbedBuilder()
    .setTitle("Test Beebs")
    .setURL(url)
    .setColor(0x2f80ed)
    .setDescription(`${listings.length} annonce(s) extraite(s).`);

  for (const listing of listings.slice(0, 5)) {
    embed.addFields({
      name: listing.title || "Annonce sans titre",
      value: [
        listing.price ? `Prix: ${listing.price}` : null,
        listing.productUrl ? `[Ouvrir l'annonce](${listing.productUrl})` : null,
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 1024),
    });
  }

  if (listings[0]?.imageUrl) {
    embed.setThumbnail(listings[0].imageUrl);
  }

  return embed;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function makeWatchEmbed(watch) {
  const checked = watch.last_checked_at
    ? time(new Date(watch.last_checked_at), "R")
    : "Jamais";

  const embed = new EmbedBuilder()
    .setTitle(`Watch #${watch.id}`)
    .setDescription(watch.url)
    .setColor(0x2f80ed)
    .addFields(
      { name: "Channel", value: `<#${watch.channel_id}>`, inline: true },
      { name: "Dernier check", value: checked, inline: true },
    );

  if (watch.last_error) {
    embed.addFields({
      name: "Derniere erreur",
      value: String(watch.last_error).slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

function makeWatchActionRow(watch) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`remove_${watch.id}`)
      .setEmoji("❌")
      .setLabel("Supprimer")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`test_${watch.id}`)
      .setEmoji("🔄")
      .setLabel("Test")
      .setStyle(ButtonStyle.Secondary),
  );
}

function attachListCollector(message, requesterId, watcher) {
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 15 * 60 * 1000,
  });

  collector.on("collect", async (buttonInteraction) => {
    if (buttonInteraction.user.id !== requesterId) {
      await buttonInteraction.reply({
        content: "Seul l'utilisateur qui a lance `/list` peut utiliser ces boutons.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const [action, rawWatchId] = buttonInteraction.customId.split("_");
    const watchId = Number.parseInt(rawWatchId, 10);

    if (!Number.isInteger(watchId)) {
      await buttonInteraction.reply({
        content: "Identifiant de watch invalide.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const watch = getWatchById(watchId);
    if (!watch) {
      await buttonInteraction.reply({
        content: `Watch #${watchId} introuvable ou deja supprimee.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "remove") {
      const removed = removeWatchById(watchId);
      await buttonInteraction.reply({
        content: removed
          ? `Watch #${watchId} supprimee.\n${watch.url}`
          : `Watch #${watchId} introuvable ou deja supprimee.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "test") {
      await buttonInteraction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const listings = await watcher.testUrl(watch.url);
        await buttonInteraction.editReply({
          embeds: [makeTestEmbed(watch.url, listings)],
        });
      } catch (error) {
        console.error(`[commands] Button test failed watch=${watchId}`, error);
        await buttonInteraction.editReply("Le test de cette watch a echoue.");
      }
    }
  });
}

async function handleWatch(interaction, watcher) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const url = getUrl(interaction);
  const channel = interaction.options.getChannel("channel", true);

  if (!channel.isTextBased()) {
    await interaction.editReply("Ce salon ne peut pas recevoir de messages texte.");
    return;
  }

  const result = await watcher.addWatch({
    url,
    channelId: channel.id,
    guildId: interaction.guildId,
    createdBy: interaction.user.id,
  });

  await interaction.editReply(
    `Surveillance active pour ${url}\nSalon: <#${channel.id}>\n${result.seededCount} annonce(s) existante(s) memorisee(s), sans alerte initiale.`,
  );
}

async function handleUnwatch(interaction, watcher) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const url = getUrl(interaction);
  const removed = watcher.removeWatch(url);

  await interaction.editReply(
    removed ? `Surveillance supprimee pour ${url}` : `Aucune surveillance trouvee pour ${url}`,
  );
}

async function handleList(interaction, watcher) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const watches = getAllWatches();
  if (watches.length === 0) {
    await interaction.editReply("Aucune URL Beebs n'est surveillee.");
    return;
  }

  const chunks = chunkArray(watches, 5);
  for (const [index, chunk] of chunks.entries()) {
    const payload = {
      embeds: chunk.map(makeWatchEmbed),
      components: chunk.map(makeWatchActionRow),
    };

    const message =
      index === 0
        ? await interaction.editReply(payload)
        : await interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral });

    attachListCollector(message, interaction.user.id, watcher);
  }
}

async function handleTest(interaction, watcher) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const url = getUrl(interaction);
  const listings = await watcher.testUrl(url);
  const embed = makeTestEmbed(url, listings);

  await interaction.editReply({ embeds: [embed] });
}

export async function handleCommand(interaction, watcher) {
  if (interaction.commandName === "watch") {
    await handleWatch(interaction, watcher);
    return;
  }

  if (interaction.commandName === "unwatch") {
    await handleUnwatch(interaction, watcher);
    return;
  }

  if (interaction.commandName === "list") {
    await handleList(interaction, watcher);
    return;
  }

  if (interaction.commandName === "test") {
    await handleTest(interaction, watcher);
  }
}
