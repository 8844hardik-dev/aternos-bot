const express = require('express');
const cors = require('cors');
const mineflayer = require('mineflayer');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

// Global crash guards — prevents Render from exiting with status 1
process.on('uncaughtException', (err) => {
  console.error('[CRASH GUARD] Uncaught Exception:', err.message);
  pushLog(`Crash prevented: ${err.message}`, 'error');
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRASH GUARD] Unhandled Rejection:', reason);
  pushLog(`Promise rejection caught: ${reason}`, 'error');
});

let botInstance = null;
let botStatus = 'INACTIVE';
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
    humanMovement: true
  }
};

let logs = [];
let reconnectTimer = null;
let reconnectAttempts = 0;
let patrolInterval = null;
let combatInterval = null;
let currentTarget = null;

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'drowned', 'husk', 'stray', 'witch', 'slime', 'zombie_villager'
]);

function pushLog(message, type = 'info') {
  const time = new Date().toLocaleTimeString('en-GB');
  const entry = {
    id: Date.now() + Math.random().toString(36).substring(2, 6),
    time,
    message: String(message),
    type
  };
  logs.push(entry);
  if (logs.length > 100) logs.shift();
  console.log(`[${time}] [${type.toUpperCase()}] ${message}`);
}

function stopBehaviors() {
  if (patrolInterval) {
    clearInterval(patrolInterval);
    patrolInterval = null;
  }
  if (combatInterval) {
    clearInterval(combatInterval);
    combatInterval = null;
  }
  currentTarget = null;
  if (botInstance) {
    try {
      botInstance.clearControlStates();
    } catch (_) {}
  }
}

function startCombatAndPatrol(bot) {
  stopBehaviors();

  // 1. Hostile Mob Targeting Loop (Runs every 1 second)
  combatInterval = setInterval(() => {
    try {
      if (!bot || !bot.entity || !bot.entity.position) return;

      // Find nearest hostile mob within 14 blocks
      let nearestMob = null;
      let minDistance = 14;

      for (const id in bot.entities) {
        const entity = bot.entities[id];
        if (!entity || !entity.position || !entity.isValid) continue;

        const name = (entity.name || '').toLowerCase();
        if (HOSTILE_MOBS.has(name)) {
          const dist = bot.entity.position.distanceTo(entity.position);
          if (dist < minDistance) {
            minDistance = dist;
            nearestMob = entity;
          }
        }
      }

      currentTarget = nearestMob;

      if (currentTarget && currentTarget.position && currentTarget.isValid) {
        const dist = bot.entity.position.distanceTo(currentTarget.position);

        // Face the target safely
        bot.lookAt(currentTarget.position.offset(0, currentTarget.height * 0.8, 0), true);

        if (dist <= 3.5) {
          bot.clearControlStates();
          bot.attack(currentTarget);
          pushLog(`Attacking hostile ${currentTarget.name}!`, 'warn');
        } else {
          bot.setControlState('forward', true);
          bot.setControlState('sprint', true);
          if (bot.entity.isCollidedHorizontally) {
            bot.setControlState('jump', true);
          } else {
            bot.setControlState('jump', false);
          }
        }
      }
    } catch (err) {
      // Catch any unexpected entity errors without crashing
      console.error('Combat loop error:', err.message);
    }
  }, 1000);

  // 2. Patrol & Anti-AFK Loop (Runs every 4 seconds when not in combat)
  patrolInterval = setInterval(() => {
    try {
      if (!bot || !bot.entity || !bot.entity.position) return;
      if (currentTarget && currentTarget.isValid) return; // Prioritize combat

      if (!currentConfig.toggles.humanMovement) return;

      const actions = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'swing'];
      const action = actions[Math.floor(Math.random() * actions.length)];

      bot.clearControlStates();

      if (action === 'swing') {
        bot.swingArm('right');
      } else if (action === 'jump') {
        bot.setControlState('jump', true);
        setTimeout(() => {
          if (bot) bot.setControlState('jump', false);
        }, 350);
      } else if (action === 'sneak') {
        bot.setControlState('sneak', true);
        setTimeout(() => {
          if (bot) bot.setControlState('sneak', false);
        }, 600);
      } else {
        // Walk in a direction for 800ms
        bot.setControlState(action, true);
        const yaw = (Math.random() - 0.5) * Math.PI;
        const pitch = (Math.random() - 0.5) * 0.5;
        bot.look(yaw, pitch, true);

        setTimeout(() => {
          if (bot) bot.setControlState(action, false);
        }, 800);
      }
    } catch (err) {
      console.error('Patrol loop error:', err.message);
    }
  }, 4000);
}

function launchBot() {
  if (botInstance) {
    stopBehaviors();
    try {
      botInstance.removeAllListeners();
      botInstance.quit();
    } catch (_) {}
    botInstance = null;
  }

  botStatus = 'CONNECTING';
  const { host, port, username, version } = currentConfig;

  let cleanHost = host.trim();
  let cleanPort = parseInt(port, 10) || 25565;

  if (cleanHost.includes(':')) {
    const parts = cleanHost.split(':');
    cleanHost = parts[0].trim();
    cleanPort = parseInt(parts[1], 10) || cleanPort;
  }

  const cleanVersion = version && version !== 'Auto-Detect' ? String(version).trim() : false;

  pushLog(`Connecting to ${cleanHost}:${cleanPort} as "${username}" (Version: ${cleanVersion || 'Auto-Detect'})...`, 'info');

  try {
    const botOptions = {
      host: cleanHost,
      port: cleanPort,
      username: username || 'SentinelBot',
      auth: 'offline',
      hideErrors: false,
      connectTimeout: 15000
    };

    if (cleanVersion) {
      botOptions.version = cleanVersion;
    }

    botInstance = mineflayer.createBot(botOptions);

    botInstance.on('login', () => {
      botStatus = 'ACTIVE';
      reconnectAttempts = 0;
      pushLog(`Logged in successfully as ${botInstance.username}!`, 'success');
    });

    botInstance.on('spawn', () => {
      botStatus = 'ACTIVE';
      pushLog('Bot spawned into the world. Starting combat & patrol behaviors...', 'success');
      startCombatAndPatrol(botInstance);
    });

    botInstance.on('death', () => {
      pushLog('Bot died in-game.', 'warn');
      stopBehaviors();
      if (currentConfig.toggles.autoRespawn) {
        setTimeout(() => {
          try {
            if (botInstance) {
              botInstance.respawn();
              pushLog('Auto-respawn triggered.', 'info');
            }
          } catch (e) {
            console.error('Respawn error:', e.message);
          }
        }, 1500);
      }
    });

    botInstance.on('playerJoined', (player) => {
      if (player.username !== botInstance.username) {
        pushLog(`Player joined: ${player.username}`, 'info');
        if (currentConfig.toggles.leaveOnPlayers) {
          pushLog('Auto-leaving because another player joined.', 'warn');
          botStatus = 'STANDBY';
          stopBehaviors();
          try { botInstance.quit(); } catch (_) {}
        }
      }
    });

    botInstance.on('playerLeft', (player) => {
      if (player.username !== botInstance.username) {
        pushLog(`Player left: ${player.username}`, 'info');
        if (currentConfig.toggles.rejoinWhenEmpty && botStatus === 'STANDBY') {
          const others = Object.keys(botInstance.players || {}).filter(n => n !== botInstance.username);
          if (others.length === 0) {
            pushLog('Server is empty again. Rejoining...', 'info');
            launchBot();
          }
        }
      }
    });

    botInstance.on('chat', (sender, text) => {
      if (sender !== botInstance.username) {
        pushLog(`[CHAT] <${sender}> ${text}`, 'chat');
      }
    });

    botInstance.on('kicked', (reason) => {
      let msg = '';
      try {
        msg = typeof reason === 'string' ? reason : JSON.stringify(reason);
      } catch (_) {
        msg = String(reason);
      }
      pushLog(`Kicked from server: ${msg}`, 'error');
    });

    botInstance.on('error', (err) => {
      pushLog(`Connection error: ${err.message}`, 'error');
      if (err.message && (err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED'))) {
        pushLog('Tip: Check if Aternos is Online and use the exact Dynamic Port!', 'warn');
      }
    });

    botInstance.on('end', (reason) => {
      stopBehaviors();
      pushLog(`Disconnected: ${reason || 'socket closed'}`, 'warn');

      if (botStatus !== 'INACTIVE' && botStatus !== 'STANDBY' && currentConfig.toggles.autoReconnect) {
        reconnectAttempts++;
        const delay = Math.min(reconnectAttempts * 3000 + 4000, 30000);
        pushLog(`Auto-reconnect attempt #${reconnectAttempts} in ${Math.round(delay / 1000)}s...`, 'warn');
        botStatus = 'CONNECTING';

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          launchBot();
        }, delay);
      } else if (botStatus !== 'STANDBY') {
        botStatus = 'INACTIVE';
      }
    });

  } catch (err) {
    pushLog(`Launch error: ${err.message}`, 'error');
    botStatus = 'INACTIVE';
  }
}

// ---------------- REST API ROUTES ----------------

app.get('/api/ping', (req, res) => {
  res.status(200).send('pong');
});

app.get('/api/status', (req, res) => {
  const onlinePlayers = botInstance && botInstance.players ? Object.keys(botInstance.players) : [];
  res.json({
    state: botStatus,
    logs,
    config: currentConfig,
    players: onlinePlayers,
    uptime: Math.floor(process.uptime())
  });
});

app.post('/api/start', (req, res) => {
  const { host, port, username, version, toggles } = req.body;
  if (!host) {
    return res.status(400).json({ success: false, error: 'Host is required' });
  }

  currentConfig.host = host;
  currentConfig.port = port || 25565;
  currentConfig.username = (username || 'SentinelBot').trim();
  currentConfig.version = version || false;
  if (toggles) {
    currentConfig.toggles = { ...currentConfig.toggles, ...toggles };
  }

  clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
  pushLog(`Received activation request for ${host}:${currentConfig.port}`, 'info');

  launchBot();
  res.json({ success: true, message: 'Bot activation initiated' });
});

app.post('/api/stop', (req, res) => {
  clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
  botStatus = 'INACTIVE';
  stopBehaviors();

  if (botInstance) {
    try {
      botInstance.removeAllListeners();
      botInstance.quit();
    } catch (_) {}
    botInstance = null;
  }

  pushLog('Bot deactivated manually.', 'warn');
  res.json({ success: true, message: 'Bot deactivated' });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (!botInstance || botStatus !== 'ACTIVE') {
    return res.status(400).json({ error: 'Bot is not active in-game' });
  }

  try {
    botInstance.chat(message);
    pushLog(`Dispatched command/chat: ${message}`, 'chat');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  pushLog(`Sentinel backend initialized on port ${PORT}`, 'info');
});
