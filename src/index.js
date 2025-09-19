// ========================================
// File: src/index.js
// ========================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { init: initDB } = require('./database/db');

// Ensure DB tables exist
initDB();

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

// Load slash commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'discord', 'commands');
if (fs.existsSync(commandsPath)) {
  for (const file of fs.readdirSync(commandsPath)) {
    if (!file.endsWith('.js')) continue;
    const cmd = require(path.join(commandsPath, file));
    if (cmd?.data?.name && typeof cmd.execute === 'function') {
      client.commands.set(cmd.data.name, cmd);
    } else {
      console.warn(`⚠️ Skipping command "${file}" (missing data/execute).`);
    }
  }
} else {
  console.warn('ℹ️ Commands folder not found:', commandsPath);
}

// Load events (routers live here)
const eventsPath = path.join(__dirname, 'discord', 'events');
if (fs.existsSync(eventsPath)) {
  for (const file of fs.readdirSync(eventsPath)) {
    if (!file.endsWith('.js')) continue;
    const evt = require(path.join(eventsPath, file));
    if (!evt?.name || !evt?.execute) {
      console.warn(`⚠️ Skipping event "${file}" (missing name/execute).`);
      continue;
    }
    if (evt.once) {
      client.once(evt.name, (...args) => evt.execute(client, ...args));
    } else {
      client.on(evt.name, (...args) => evt.execute(...args));
    }
  }
} else {
  console.warn('ℹ️ Events folder not found:', eventsPath);
}

// Login (ready logic & scheduler now live in events/ready.js)
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Failed to login:', err);
});
