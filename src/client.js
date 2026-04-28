import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { commands, handleCommand } from "./commands/index.js";
import { config } from "./config.js";
import { initDatabase } from "./database.js";
import { BeebsWatcher } from "./services/beebsWatcher.js";
import { closeBrowser } from "./services/scraper.js";

function log(message, details = "") {
  const suffix = details ? ` ${details}` : "";
  console.log(`[client] ${message}${suffix}`);
}

async function registerCommands(client) {
  const payload = commands.map((command) => command.toJSON());

  if (config.guildId) {
    const guild = await client.guilds.fetch(config.guildId);
    await guild.commands.set(payload);
    log(`Registered ${payload.length} guild commands`, `guild=${config.guildId}`);
    return;
  }

  await client.application.commands.set(payload);
  log(`Registered ${payload.length} global commands`);
}

export async function startBot() {
  await initDatabase();

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  const watcher = new BeebsWatcher(client);

  client.once(Events.ClientReady, async (readyClient) => {
    log(`Logged in as ${readyClient.user.tag}`);

    try {
      await registerCommands(readyClient);
    } catch (error) {
      console.error("[client] Failed to register slash commands", error);
    }

    watcher.start();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      await handleCommand(interaction, watcher);
    } catch (error) {
      console.error(`[client] Command failed: /${interaction.commandName}`, error);

      const message = "Une erreur est survenue pendant l'execution de la commande.";
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(() => {});
      } else {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  const shutdown = async (signal) => {
    log(`Received ${signal}, shutting down`);
    watcher.stop();
    await closeBrowser();
    await client.destroy();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  await client.login(config.discordToken);
  return client;
}
