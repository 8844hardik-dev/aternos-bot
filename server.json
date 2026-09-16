// ==========================================
// ATERNOS AFK SENTINEL - BACKEND SERVER
// Express + Mineflayer + Self-Ping Keepalive
// ==========================================

const express = require('express');
const cors = require('cors');
const mineflayer = require('mineflayer');

const app = express();
const PORT = process.env.PORT || 3000;
const PING_URL = 'https://aternos-bot-nl5e.onrender.com/api/ping';

app.use(cors());
app.use(express.json());

// Global Bot State
let bot = null;
let botState = 'INACTIVE'; // INACTIVE | CONNECTING | ACTIVE | STANDBY
let logs = [];
let reconnectTimer = null;
let reconnectAttempts = 0;
let emulationInterval = null;

let currentConfig = {
  host: '',
  port: 25565,
  username: 'SentinelBot',
  version: false,
  toggles: {
    autoRespawn: true,
    autoReconnect: true,
    leaveOnPlayers: false,
    rejoinWhenEmpty: false,
    humanMovement: true,
  },
};

function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('en-GB');
  const logEntry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    time: timestamp,
    message,
    type, // 'info' | 'success' | 'warn' | 'error' | 'chat'
  };
  logs.push(logEntry);
  if (logs.length > 250) logs.shift();
  console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
}

// ------------------------------------------
// 1. Keep-Alive / Cron Ping Route
// ------------------------------------------
app.get('/api/ping', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    botState,
    timestamp: new Date().toISOString(),
  });
});

// Self-ping every 4 minutes to prevent Render free-tier sleep
setInterval(async () => {
  try {
    const res = await fetch(PING_URL);
    console.log(`[Cron Self-Ping] Status: ${res.status} at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.warn(`[Cron Self-Ping Error] ${err.message}`);
  }
}, 4 * 60 * 1000);

// ------------------------------------------
// 2. Anti-AFK Simulation
// ------------------------------------------
function startEmulation() {
  if (emulationInterval) clearInterval(emulationInterval);

  emulationInterval = setInterval(() => {
    if (!bot || botState !== 'ACTIVE' || !bot.entity) return;

    try {
      // Random head movement
      const yaw = (Math.random() * Math.PI * 2) - Math.PI;
      const pitch = (Math.random() * 0.6) - 0.3;
      bot.look(yaw, pitch, false);

      // Random arm swing
      if (Math.random() > 0.4) {
        bot.swingArm('right');
      }

      // Micro-jump or sneak to bypass strict AFK plugins
      const rand = Math.random();
      if (rand > 0.7) {
        bot.setControlState('jump', true);
        setTimeout(() => bot && bot.setControlState('jump', false), 350);
      } else if (rand > 0.4) {
        bot.setControlState('sneak', true);
        setTimeout(() => bot && bot.setControlState('sneak', false), 500);
      }
    } catch {
      // Ignore physics tick errors
    }
  }, 4000);
}

function stopEmulation() {
  if (emulationInterval) {
    clearInterval(emulationInterval);
    emulationInterval = null;
  }
}

// ------------------------------------------
// 3. Bot Core Engine
// ------------------------------------------
function stopBot(manual = true) {
  stopEmulation();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (manual) {
    reconnectAttempts = 0;
    botState = 'INACTIVE';
    addLog('Bot deactivated manually.', 'warn');
  }

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.quit();
    } catch {}
    bot = null;
  }
}

function scheduleReconnect() {
  if (!currentConfig.toggles.autoReconnect) {
    botState = 'INACTIVE';
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(30000, 4000 + reconnectAttempts * 3000);
  botState = 'CONNECTING';
  addLog(`Auto-reconnect attempt #${reconnectAttempts} in ${delay / 1000}s...`, 'warn');

  reconnectTimer = setTimeout(() => {
    createBotInstance();
  }, delay);
}

function createBotInstance() {
  stopBot(false);
  botState = 'CONNECTING';

  // Handle host:port if user pasted both in host
  let host = currentConfig.host.trim();
  let port = parseInt(currentConfig.port, 10) || 25565;

  if (host.includes(':')) {
    const parts = host.split(':');
    host = parts[0].trim();
    port = parseInt(parts[1], 10) || port;
  }

  let version = currentConfig.version;
  if (!version || version === 'Auto-Detect' || version === 'auto') {
    version = false; // Let mineflayer attempt protocol ping
  }

  addLog(`Connecting to ${host}:${port} as "${currentConfig.username}" (Version: ${version || 'Auto-Detect'})...`, 'info');

  try {
    bot = mineflayer.createBot({
      host,
      port,
      username: currentConfig.username,
      version: version || undefined,
      auth: 'offline', // Required for cracked Aternos servers
      checkTimeoutInterval: 45000,
    });
  } catch (err) {
    addLog(`Initialization error: ${err.message}`, 'error');
    scheduleReconnect();
    return;
  }

  // Event handlers
  bot.once('spawn', () => {
    botState = 'ACTIVE';
    reconnectAttempts = 0;
    addLog(`Spawned in server! Bot is active in-game.`, 'success');

    if (currentConfig.toggles.humanMovement) {
      startEmulation();
    }
  });

  bot.on('death', () => {
    addLog('Bot died in-game.', 'warn');
    if (currentConfig.toggles.autoRespawn) {
      setTimeout(() => {
        try {
          bot.respawn();
          addLog('Auto-respawn triggered.', 'info');
        } catch (e) {
          addLog(`Respawn error: ${e.message}`, 'error');
        }
      }, 1000);
    }
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    addLog(`[CHAT] <${username}> ${message}`, 'chat');
  });

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString().trim();
    if (text && !text.startsWith('<')) {
      addLog(text, 'info');
    }
  });

  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return;
    addLog(`Player joined: ${player.username}`, 'info');

    if (currentConfig.toggles.leaveOnPlayers) {
      addLog('Player presence detected. Disconnecting to STANDBY...', 'warn');
      botState = 'STANDBY';
      stopBot(false);

      if (currentConfig.toggles.rejoinWhenEmpty) {
        scheduleReconnect();
      }
    }
  });

  bot.on('kicked', (reason) => {
    let cleanReason = typeof reason === 'string' ? reason : JSON.stringify(reason);
    try {
      const parsed = JSON.parse(cleanReason);
      cleanReason = parsed.text || parsed.extra?.map((e) => e.text).join('') || cleanReason;
    } catch {}

    addLog(`Kicked from server: ${cleanReason}`, 'error');

    if (cleanReason.toLowerCase().includes('whitelist')) {
      addLog('Tip: Turn off Whitelist or add bot username on Aternos.', 'warn');
    }
    if (cleanReason.toLowerCase().includes('not authenticated') || cleanReason.toLowerCase().includes('cracked')) {
      addLog('Tip: Enable "Cracked" mode in your Aternos server options!', 'error');
    }

    scheduleReconnect();
  });

  bot.on('error', (err) => {
    addLog(`Connection error: ${err.message}`, 'error');

    if (err.message.includes('ETIMEDOUT') || err.message.includes('ENOTFOUND')) {
      addLog('Tip: Check if Aternos is Online and use the exact Dynamic Port!', 'warn');
    } else if (err.message.includes('Unsupported protocol version') || err.message.includes('minecraftVersion')) {
      addLog('Tip: Do not use "Auto-Detect". Select the exact Minecraft version in the dashboard!', 'warn');
    }

    scheduleReconnect();
  });

  bot.on('end', (reason) => {
    addLog(`Disconnected: ${reason || 'Socket closed'}`, 'warn');
    if (botState !== 'INACTIVE') {
      scheduleReconnect();
    }
  });
}

// ------------------------------------------
// 4. REST API Routes
// ------------------------------------------
app.get('/api/status', (req, res) => {
  const players = [];
  if (bot && bot.players) {
    Object.keys(bot.players).forEach((name) => {
      if (name !== bot.username) players.push(name);
    });
  }

  res.json({
    state: botState,
    logs,
    config: currentConfig,
    players,
    uptime: Math.floor(process.uptime()),
  });
});

app.post('/api/start', (req, res) => {
  const { host, port, username, version, toggles } = req.body;

  if (!host || !username) {
    return res.status(400).json({ error: 'Server host and username are required.' });
  }

  currentConfig = {
    host,
    port: parseInt(port, 10) || 25565,
    username,
    version: version || false,
    toggles: {
      autoRespawn: toggles?.autoRespawn ?? true,
      autoReconnect: toggles?.autoReconnect ?? true,
      leaveOnPlayers: toggles?.leaveOnPlayers ?? false,
      rejoinWhenEmpty: toggles?.rejoinWhenEmpty ?? false,
      humanMovement: toggles?.humanMovement ?? true,
    },
  };

  reconnectAttempts = 0;
  addLog(`Received activation request for ${currentConfig.host}:${currentConfig.port}`, 'info');
  createBotInstance();

  res.json({ success: true, message: 'Bot activation initiated' });
});

app.post('/api/stop', (req, res) => {
  stopBot(true);
  res.json({ success: true, message: 'Bot deactivated' });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;

  if (!bot || botState !== 'ACTIVE') {
    return res.status(400).json({ error: 'Bot is not active in-game.' });
  }
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  try {
    bot.chat(message);
    addLog(`[COMMAND SENT] ${message}`, 'chat');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root check
app.get('/', (req, res) => {
  res.send('Aternos AFK Sentinel Backend is running.');
});

// Start listening
app.listen(PORT, () => {
  console.log(`Sentinel backend listening on port ${PORT}`);
  addLog(`Sentinel backend initialized on port ${PORT}`, 'info');
});
