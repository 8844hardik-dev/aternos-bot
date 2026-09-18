const express = require('express');
const cors = require('cors');
const mineflayer = require('mineflayer');

const app = express();
app.use(cors());
app.use(express.json());

// Global process error guards so Render never exits with status 1
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught exception prevented from crashing server:', err);
  addLog(`System error handled: ${err.message || 'Unknown error'}`, 'error');
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRITICAL] Unhandled promise rejection handled:', reason);
  addLog(`Async rejection caught: ${reason?.message || String(reason)}`, 'warning');
});

let bot = null;
let reconnectTimer = null;
let combatInterval = null;
let patrolInterval = null;
let reconnectAttempts = 0;

let botState = {
  status: 'INACTIVE', // INACTIVE | CONNECTING | ACTIVE | STANDBY
  config: null,
  activePlayers: [],
  logs: []
};

function addLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB');
  const entry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    time,
    message,
    type
  };
  botState.logs.unshift(entry);
  if (botState.logs.length > 100) {
    botState.logs.pop();
  }
  console.log(`[${time}] [${type.toUpperCase()}] ${message}`);
}

// ----------------------------------------------------
// ANTI-AFK: Mob Defense & Patrol Movement
// ----------------------------------------------------
const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'drowned', 'husk', 'stray', 'witch', 'slime', 'zombie_villager'
]);

function startCombatAndPatrol() {
  stopCombatAndPatrol();

  // 1. Hostile Mob Hunting Loop (runs every 1.5s)
  combatInterval = setInterval(() => {
    try {
      if (!bot || !bot.entity || botState.status !== 'ACTIVE') return;

      let nearestHostile = null;
      let minDistance = 14;

      for (const id in bot.entities) {
        const entity = bot.entities[id];
        if (!entity || !entity.name || !entity.position) continue;

        const mobName = entity.name.toLowerCase();
        if (HOSTILE_MOBS.has(mobName) && entity.isValid) {
          const dist = bot.entity.position.distanceTo(entity.position);
          if (dist < minDistance) {
            minDistance = dist;
            nearestHostile = entity;
          }
        }
      }

      if (nearestHostile && nearestHostile.position) {
        bot.lookAt(nearestHostile.position.offset(0, nearestHostile.height || 1.6, 0)).catch(() => {});

        if (minDistance <= 3.5) {
          bot.attack(nearestHostile);
          bot.swingArm('right');
          addLog(`Defending: attacked nearby ${nearestHostile.name}`, 'warning');
        } else if (minDistance <= 8) {
          bot.setControlState('forward', true);
          bot.setControlState('sprint', true);
          setTimeout(() => {
            if (bot) {
              bot.setControlState('forward', false);
              bot.setControlState('sprint', false);
            }
          }, 600);
        }
      }
    } catch (err) {
      // Ignore combat targeting hiccups
    }
  }, 1500);

  // 2. Anti-AFK Random Movement Loop (runs every 6s)
  patrolInterval = setInterval(() => {
    try {
      if (!bot || !bot.entity || botState.status !== 'ACTIVE') return;

      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * 0.6;
      bot.look(yaw, pitch, true).catch(() => {});

      if (Math.random() < 0.6) {
        bot.swingArm('right');
      }

      const actions = ['jump', 'forward', 'back', 'left', 'right', 'sneak'];
      const action = actions[Math.floor(Math.random() * actions.length)];

      if (action === 'jump') {
        bot.setControlState('jump', true);
        setTimeout(() => bot && bot.setControlState('jump', false), 350);
      } else if (action === 'sneak') {
        bot.setControlState('sneak', true);
        setTimeout(() => bot && bot.setControlState('sneak', false), 800);
      } else {
        bot.setControlState(action, true);
        setTimeout(() => bot && bot.setControlState(action, false), 400 + Math.random() * 400);
      }
    } catch (err) {
      // Ignore movement hiccups
    }
  }, 6000);
}

function stopCombatAndPatrol() {
  if (combatInterval) {
    clearInterval(combatInterval);
    combatInterval = null;
  }
  if (patrolInterval) {
    clearInterval(patrolInterval);
    patrolInterval = null;
  }
  if (bot) {
    try {
      ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].forEach((c) => {
        bot.setControlState(c, false);
      });
    } catch (_) {}
  }
}

// ----------------------------------------------------
// Bot Lifecycle Management
// ----------------------------------------------------
function startBotInstance(config) {
  if (bot) {
    try {
      stopCombatAndPatrol();
      bot.removeAllListeners();
      bot.quit();
    } catch (_) {}
    bot = null;
  }

  botState.config = config;
  botState.status = 'CONNECTING';

  let rawHost = (config.host || '').trim();
  let port = Number(config.port) || 25565;

  if (rawHost.includes(':')) {
    const parts = rawHost.split(':');
    rawHost = parts[0].trim();
    const parsedPort = Number(parts[1]);
    if (parsedPort) port = parsedPort;
  }

  const username = (config.username || 'AFK_Sentinel').trim().replace(/[^a-zA-Z0-9_]/g, '_');
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

  if (requestedVersion) {
    botOptions.version = requestedVersion;
  }

  try {
    bot = mineflayer.createBot(botOptions);
  } catch (err) {
    addLog(`Initialization error: ${err.message}`, 'error');
    botState.status = 'INACTIVE';
    scheduleReconnect(config);
    return;
  }

  bot.once('login', () => {
    addLog(`Logged in as ${bot.username}. Waiting for world spawn...`, 'info');
  });

  bot.once('spawn', () => {
    botState.status = 'ACTIVE';
    reconnectAttempts = 0;
    addLog(`Spawned in world at (${Math.round(bot.entity.position.x)}, ${Math.round(bot.entity.position.y)}, ${Math.round(bot.entity.position.z)}). Combat & anti-AFK active.`, 'success');

    if (config.humanMovement) {
      startCombatAndPatrol();
    }
  });

  bot.on('death', () => {
    addLog('Bot died in server.', 'warning');
    stopCombatAndPatrol();

    if (config.autoRespawn) {
      setTimeout(() => {
        try {
          if (bot) {
            bot.respawn();
            addLog('Auto-respawn triggered.', 'info');
          }
        } catch (err) {
          addLog(`Respawn error: ${err.message}`, 'error');
        }
      }, 1500);
    }
  });

  bot.on('playerJoined', (player) => {
    if (!player || player.username === bot.username) return;
    addLog(`Player joined: ${player.username}`, 'info');

    if (config.autoLeaveOnJoin) {
      addLog('Player presence detected. Auto-leaving server...', 'warning');
      stopCombatAndPatrol();
      botState.status = 'STANDBY';
      try {
        bot.quit();
      } catch (_) {}
    }
  });

  bot.on('playerLeft', (player) => {
    if (!player || player.username === bot.username) return;
    addLog(`Player left: ${player.username}`, 'info');

    if (config.rejoinWhenEmpty && botState.status === 'STANDBY') {
      const remaining = Object.keys(bot.players || {}).filter(name => name !== bot.username);
      if (remaining.length === 0) {
        addLog('Server is empty. Triggering standby reconnect...', 'info');
        startBotInstance(config);
      }
    }
  });

  bot.on('chat', (sender, message) => {
    if (sender === bot.username) return;
    addLog(`<${sender}> ${message}`, 'chat');
  });

  bot.on('kicked', (reason) => {
    stopCombatAndPatrol();
    let text = reason;
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      text = parsed?.text || parsed?.extra?.map(e => e.text).join('') || JSON.stringify(parsed);
    } catch (_) {}
    addLog(`Kicked from server: ${text || 'Disconnected by server'}`, 'warning');
  });

  bot.on('error', (err) => {
    addLog(`Connection error: ${err.message}`, 'error');
  });

  bot.on('end', (reason) => {
    stopCombatAndPatrol();
    addLog(`Disconnected from server (${reason || 'connection closed'})`, 'warning');

    if (botState.status !== 'STANDBY' && botState.status !== 'INACTIVE') {
      botState.status = 'INACTIVE';
      if (config.autoReconnect) {
        scheduleReconnect(config);
      }
    }
  });
}

function scheduleReconnect(config) {
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectAttempts++;
  const delay = Math.min(10000 * Math.pow(1.3, reconnectAttempts - 1), 60000);
  addLog(`Auto-reconnect scheduled in ${Math.round(delay / 1000)}s (Attempt #${reconnectAttempts})`, 'info');

  reconnectTimer = setTimeout(() => {
    startBotInstance(config);
  }, delay);
}

// ----------------------------------------------------
// Express API Endpoints
// ----------------------------------------------------
app.get('/api/ping', (req, res) => {
  res.status(200).send('pong');
});

app.get('/api/status', (req, res) => {
  res.json({
    state: botState.status,
    logs: botState.logs,
    activePlayers: bot ? Object.keys(bot.players || {}).filter(n => n !== bot.username) : []
  });
});

app.post('/api/start', (req, res) => {
  const config = req.body;
  if (!config || !config.host) {
    return res.status(400).json({ error: 'Host is required' });
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;

  addLog(`Activation requested for ${config.host}:${config.port || 25565}`, 'info');
  startBotInstance(config);
  res.json({ success: true, message: 'Bot activation initiated' });
});

app.post('/api/stop', (req, res) => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  stopCombatAndPatrol();

  if (bot) {
    try {
      bot.removeAllListeners();
      bot.quit();
    } catch (_) {}
    bot = null;
  }

  botState.status = 'INACTIVE';
  addLog('Bot deactivated manually by user', 'info');
  res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  if (!bot || botState.status !== 'ACTIVE') {
    return res.status(400).json({ error: 'Bot is not active in-game' });
  }

  try {
    bot.chat(message);
    addLog(`Sent command/chat: ${message}`, 'chat');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// INTERNAL SELF-PING CRON (Every 4 Minutes)
// Keeps Render awake without third-party tools
// ----------------------------------------------------
const SELF_URL = 'https://aternos-bot-nl5e.onrender.com/api/ping';

function startSelfPingCron() {
  setInterval(async () => {
    try {
      const res = await fetch(SELF_URL, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      console.log(`[SELF-PING] ${new Date().toISOString()} -> Status: ${res.status} (${text})`);
    } catch (err) {
      console.warn(`[SELF-PING] Warning: Ping attempt failed: ${err.message}`);
    }
  }, 4 * 60 * 1000); // 4 minutes
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  addLog(`Sentinel backend initialized on port ${PORT}`, 'info');
  startSelfPingCron();
});
