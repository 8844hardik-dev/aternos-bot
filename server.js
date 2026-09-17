// ==========================================
// ATERNOS AFK SENTINEL - BACKEND SERVER
// Express + Mineflayer + Self-Ping + Mob Hunter Anti-AFK
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
let patrolInterval = null;
let combatInterval = null;

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
// 2. Mob Combat & Real Coordinate Anti-AFK
// ------------------------------------------
const HOSTILE_MOBS = [
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider',
  'drowned', 'husk', 'stray', 'witch', 'slime', 'zombie_villager'
];

function getNearestHostileMob(radius = 12) {
  if (!bot || !bot.entity) return null;

  return bot.nearestEntity((entity) => {
    if (!entity || entity === bot.entity) return false;
    const isHostile = HOSTILE_MOBS.includes(entity.name?.toLowerCase());
    if (!isHostile) return false;
    return bot.entity.position.distanceTo(entity.position) <= radius;
  });
}

function startAntiAFKAndCombat() {
  stopAntiAFKAndCombat();

  // A. Combat AI Loop: Attacks nearby hostile mobs every 1.5 seconds
  combatInterval = setInterval(() => {
    if (!bot || botState !== 'ACTIVE' || !bot.entity) return;

    try {
      const mob = getNearestHostileMob(12);
      if (mob) {
        const dist = bot.entity.position.distanceTo(mob.position);
        
        // Turn towards the mob
        bot.lookAt(mob.position.offset(0, mob.height * 0.75, 0), true);

        if (dist <= 3.5) {
          // In melee range: swing and attack
          bot.setControlState('forward', false);
          bot.swingArm('right');
          bot.attack(mob);
          addLog(`⚔️ Combat: Attacking ${mob.name} (${dist.toFixed(1)}m away)`, 'info');
        } else {
          // Move towards the target
          bot.setControlState('forward', true);
          bot.setControlState('sprint', true);
        }
        return;
      }
    } catch {
      // Ignore physics tick errors
    }
  }, 1500);

  // B. Real Coordinate Patrol Loop: Walks around every 5 seconds to prevent idle kick
  patrolInterval = setInterval(() => {
    if (!bot || botState !== 'ACTIVE' || !bot.entity) return;

    // Do not disrupt active mob fights
    if (getNearestHostileMob(6)) return;

    try {
      // Random head turn
      const randomYaw = (Math.random() * Math.PI * 2) - Math.PI;
      const randomPitch = (Math.random() * 0.4) - 0.2;
      bot.look(randomYaw, randomPitch, false);

      // Random arm swing
      bot.swingArm('right');

      const actionRand = Math.random();
      if (actionRand > 0.4) {
        // Real walk forward for 1.2s to change coordinates
        bot.setControlState('forward', true);
        if (Math.random() > 0.6) bot.setControlState('jump', true);

        setTimeout(() => {
          if (bot) {
            bot.setControlState('forward', false);
            bot.setControlState('jump', false);
          }
        }, 1200);
      } else if (actionRand > 0.15) {
        // Step back & sneak
        bot.setControlState('back', true);
        bot.setControlState('sneak', true);

        setTimeout(() => {
          if (bot) {
            bot.setControlState('back', false);
            bot.setControlState('sneak', false);
          }
        }, 800);
      }
    } catch {
      // Ignore physics tick errors
    }
  }, 5000);
}

function stopAntiAFKAndCombat() {
  if (combatInterval) {
    clearInterval(combatInterval);
    combatInterval = null;
  }
  if (patrolInterval) {
    clearInterval(patrolInterval);
    patrolInterval = null;
  }
  if (bot) {
    bot.clearControlStates();
  }
}

// ------------------------------------------
// 3. Bot Core Engine
// ------------------------------------------
function stopBot(manual = true) {
  stopAntiAFKAndCombat();
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
      fakeHost: host,  // Crucial for Aternos SRV/proxy routing
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
      startAntiAFKAndCombat();
    }
  });

  bot.on('death', () => {
    addLog('Bot died in-game.', 'warn');
    stopAntiAFKAndCombat();
    if (currentConfig.toggles.autoRespawn) {
      setTimeout(() => {
        try {
          bot.respawn();
          addLog('Auto-respawn triggered.', 'info');
          if (currentConfig.toggles.humanMovement) {
            startAntiAFKAndCombat();
          }
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

    addLog(`Kicked from server: ${cleanReason || 'No reason provided'}`, 'error');

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
