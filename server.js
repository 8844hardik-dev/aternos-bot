const express = require('express');
const cors = require('cors');
const mineflayer = require('mineflayer');

const app = express();
app.use(cors());
app.use(express.json());

// Global crash protection
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught exception:', err);
  addLog(`System error handled: ${err.message || 'Unknown error'}`, 'error');
});
process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled rejection:', reason);
});

let bot = null;
let reconnectTimer = null;
let patrolInterval = null;
let hotbarInterval = null;
let heartbeatInterval = null;
let reconnectAttempts = 0;

let botState = {
  status: 'INACTIVE',
  config: null,
  logs: []
};

function addLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB');
  const entry = { id: Date.now() + Math.random().toString(36).substring(2, 6), time, message, type };
  botState.logs.unshift(entry);
  if (botState.logs.length > 100) botState.logs.pop();
  console.log(`[${time}] [${type.toUpperCase()}] ${message}`);
}

function getToggles(config) {
  const t = config?.toggles || config || {};
  return {
    autoRespawn: t.autoRespawn !== false,
    autoReconnect: t.autoReconnect !== false,
    autoLeave: t.autoLeave === true,
    instantRejoin: t.instantRejoin === true,
    humanMovement: t.humanMovement !== false
  };
}

// ----------------------------------------------------
// ANTI-AFK: Real Block Movement, Hotbar Cycling & Heartbeat
// ----------------------------------------------------
function startAntiAfk() {
  stopAntiAfk();

  let direction = true;

  // 1. Real Block Walking Loop (runs every 6s)
  patrolInterval = setInterval(() => {
    try {
      if (!bot || !bot.entity || botState.status !== 'ACTIVE') return;

      const yaw = direction ? 0 : Math.PI; // Face North, then South
      const pitch = (Math.random() - 0.5) * 0.4;
      bot.look(yaw, pitch, true).catch(() => {});

      direction = !direction;

      // Walk for 2.2 seconds to guarantee crossing block boundaries
      bot.setControlState('forward', true);
      if (Math.random() < 0.4) bot.setControlState('jump', true);

      setTimeout(() => {
        if (bot) {
          bot.setControlState('forward', false);
          bot.setControlState('jump', false);
          bot.swingArm('right');
        }
      }, 2200);
    } catch (_) {}
  }, 6000);

  // 2. Hotbar Slot Cycling (runs every 12s)
  hotbarInterval = setInterval(() => {
    try {
      if (!bot || botState.status !== 'ACTIVE') return;
      const nextSlot = ((bot.quickBarSlot || 0) + 1) % 9;
      bot.setQuickBarSlot(nextSlot);
    } catch (_) {}
  }, 12000);

  // 3. Command Heartbeat (runs every 4m to reset server idle timer)
  heartbeatInterval = setInterval(() => {
    try {
      if (!bot || botState.status !== 'ACTIVE') return;
      bot.chat('/time query daytime');
    } catch (_) {}
  }, 4 * 60 * 1000);
}

function stopAntiAfk() {
  if (patrolInterval) { clearInterval(patrolInterval); patrolInterval = null; }
  if (hotbarInterval) { clearInterval(hotbarInterval); hotbarInterval = null; }
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (bot) {
    try {
      ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].forEach((c) => bot.setControlState(c, false));
    } catch (_) {}
  }
}

// ----------------------------------------------------
// Bot Lifecycle Management
// ----------------------------------------------------
function startBotInstance(config) {
  if (bot) {
    try { stopAntiAfk(); bot.removeAllListeners(); bot.quit(); } catch (_) {}
    bot = null;
  }

  botState.config = config;
  botState.status = 'CONNECTING';
  const toggles = getToggles(config);

  let rawHost = (config.host || '').trim();
  let port = Number(config.port) || 25565;
  if (rawHost.includes(':')) {
    const parts = rawHost.split(':');
    rawHost = parts[0].trim();
    const p = Number(parts[1]);
    if (p) port = p;
  }

  const username = (config.username || 'Sentinel').trim().replace(/[^a-zA-Z0-9_]/g, '_');
  const requestedVersion = config.version && config.version !== 'Auto-Detect' ? config.version : false;

  addLog(`Connecting to ${rawHost}:${port} as "${username}" (Version: ${requestedVersion || 'Auto-Detect'})...`, 'info');

  const botOptions = {
    host: rawHost,
    port: port,
    fakeHost: rawHost,
    username: username,
    auth: 'offline',
    checkTimeoutInterval: 30000,
    connectTimeout: 20000
  };
  if (requestedVersion) botOptions.version = requestedVersion;

  try {
    bot = mineflayer.createBot(botOptions);
  } catch (err) {
    addLog(`Initialization error: ${err.message}`, 'error');
    botState.status = 'INACTIVE';
    if (toggles.autoReconnect) scheduleReconnect(config);
    return;
  }

  bot.once('login', () => addLog(`Logged in as ${bot.username}. Awaiting spawn...`, 'info'));

  bot.once('spawn', () => {
    botState.status = 'ACTIVE';
    reconnectAttempts = 0;
    addLog(`Spawned at (${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)}). Anti-AFK running.`, 'success');

    // Run Creative / OP spawn command
    const cmd = config.spawnCommand || '/gamemode creative';
    if (config.enableSpawnCommand !== false) {
      setTimeout(() => {
        try {
          if (bot && botState.status === 'ACTIVE') {
            bot.chat(cmd);
            addLog(`Executed spawn command: ${cmd}`, 'chat');
          }
        } catch (_) {}
      }, 2000);
    }

    if (toggles.humanMovement) startAntiAfk();
  });

  bot.on('death', () => {
    addLog('Bot died in server.', 'warning');
    stopAntiAfk();
    if (toggles.autoRespawn) {
      setTimeout(() => {
        try {
          if (bot) {
            bot.respawn();
            addLog('Auto-respawn triggered.', 'info');
            if (toggles.humanMovement) startAntiAfk();
          }
        } catch (err) { addLog(`Respawn error: ${err.message}`, 'error'); }
      }, 1500);
    }
  });

  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return;
    addLog(`Player joined: ${player.username}`, 'info');
    if (toggles.autoLeave) {
      addLog('Player detected. Auto-leaving...', 'warning');
      botState.status = 'STANDBY';
      stopAntiAfk();
      try { bot.quit(); } catch (_) {}
    }
  });

  bot.on('playerLeft', (player) => {
    if (!player || player.username === bot.username) return;
    addLog(`Player left: ${player.username}`, 'info');
    if (toggles.instantRejoin && botState.status === 'STANDBY') {
      const remaining = Object.keys(bot.players || {}).filter((n) => n !== bot.username);
      if (remaining.length === 0) startBotInstance(config);
    }
  });

  bot.on('chat', (sender, message) => {
    if (sender === bot.username) return;
    addLog(`<${sender}> ${message}`, 'chat');
  });

  bot.on('kicked', (reason) => {
    stopAntiAfk();
    let text = reason;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      text = parsed?.text || parsed?.extra?.map((e) => e.text).join('') || JSON.stringify(parsed);
    } catch (_) {}
    addLog(`Kicked from server: ${text || 'Disconnected'}`, 'warning');
  });

  bot.on('error', (err) => addLog(`Connection error: ${err.message}`, 'error'));

  bot.on('end', (reason) => {
    stopAntiAfk();
    addLog(`Disconnected (${reason || 'connection closed'})`, 'warning');
    if (botState.status !== 'STANDBY') {
      botState.status = 'INACTIVE';
      if (toggles.autoReconnect) scheduleReconnect(config);
    }
  });
}

function scheduleReconnect(config) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const delay = Math.min(10000 * Math.pow(1.3, reconnectAttempts - 1), 60000);
  addLog(`Auto-reconnect scheduled in ${Math.round(delay / 1000)}s (Attempt #${reconnectAttempts})`, 'info');
  reconnectTimer = setTimeout(() => startBotInstance(config), delay);
}

// ---------------- REST Endpoints ----------------
app.get('/api/ping', (req, res) => res.status(200).send('pong'));

app.get('/api/status', (req, res) => {
  res.json({
    state: botState.status,
    logs: botState.logs,
    activePlayers: bot ? Object.keys(bot.players || {}).filter((n) => n !== bot.username) : []
  });
});

app.post('/api/start', (req, res) => {
  const config = req.body;
  if (!config || !config.host) return res.status(400).json({ error: 'Host is required' });
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  addLog(`Activation requested for ${config.host}:${config.port || 25565}`, 'info');
  startBotInstance(config);
  res.json({ success: true, message: 'Bot activation initiated' });
});

app.post('/api/stop', (req, res) => {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  reconnectAttempts = 0;
  stopAntiAfk();
  if (bot) { try { bot.removeAllListeners(); bot.quit(); } catch (_) {} bot = null; }
  botState.status = 'INACTIVE';
  addLog('Bot deactivated manually by user', 'info');
  res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!bot || botState.status !== 'ACTIVE') return res.status(400).json({ error: 'Bot is not active in-game' });
  try {
    bot.chat(message);
    addLog(`Sent command/chat: ${message}`, 'chat');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Self-ping cron to keep Render awake
const SELF_URL = 'https://aternos-bot-nl5e.onrender.com/api/ping';
function startSelfPingCron() {
  setInterval(async () => {
    try {
      const res = await fetch(SELF_URL, { signal: AbortSignal.timeout(10000) });
      console.log(`[SELF-PING] ${new Date().toISOString()} -> ${res.status}`);
    } catch (err) {
      console.warn(`[SELF-PING] failed: ${err.message}`);
    }
  }, 4 * 60 * 1000);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  addLog(`Sentinel backend initialized on port ${PORT}`, 'info');
  startSelfPingCron();
});
