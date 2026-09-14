const express = require("express");
const cors = require("cors");
const mineflayer = require("mineflayer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// State
let bot = null;
let botStatus = "INACTIVE"; // 'INACTIVE' | 'CONNECTING' | 'ACTIVE' | 'STANDBY'
let startTime = null;
let retryCount = 0;
let reconnectTimer = null;
let currentConfig = null;
const logs = [];

function addLog(level, message) {
  const time = new Date().toISOString();
  const entry = { id: Date.now() + Math.random(), time, level, message };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  console.log(`[${level.toUpperCase()}] ${message}`);
}

function getUptimeSeconds() {
  if (!startTime || botStatus !== "ACTIVE") return 0;
  return Math.floor((Date.now() - startTime) / 1000);
}

function getPlayerCount() {
  if (!bot || !bot.players) return 0;
  // Exclude the bot itself from count
  return Math.max(0, Object.keys(bot.players).length - 1);
}

// Emulation intervals
let movementInterval = null;

function startEmulation(toggles) {
  stopEmulation();
  if (!toggles || !toggles.humanMovement) return;

  movementInterval = setInterval(() => {
    if (!bot || botStatus !== "ACTIVE" || !bot.entity) return;

    // Subtle look jitter
    const yaw = (Math.random() - 0.5) * 0.4;
    const pitch = (Math.random() - 0.5) * 0.2;
    bot.look(bot.entity.yaw + yaw, bot.entity.pitch + pitch, true).catch(() => {});

    // Random small actions: swing arm or sneak
    if (Math.random() > 0.6) {
      bot.swingArm("right");
    }
    if (Math.random() > 0.8) {
      bot.setControlState("sneak", true);
      setTimeout(() => bot && bot.setControlState("sneak", false), 600);
    }
  }, 3500);
}

function stopEmulation() {
  if (movementInterval) {
    clearInterval(movementInterval);
    movementInterval = null;
  }
}

function destroyBot() {
  stopEmulation();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (bot) {
    bot.removeAllListeners();
    try {
      bot.quit();
    } catch (_) {}
    bot = null;
  }
}

function connectBot(config) {
  destroyBot();
  currentConfig = config;

  const { host, port, username, version, toggles } = config;
  botStatus = "CONNECTING";
  addLog("info", `Initiating connection to ${host}:${port || 25565} as "${username}"...`);

  const botOptions = {
    host,
    port: Number(port) || 25565,
    username: username || "AFK_Sentinel",
    auth: "offline", // Required for Cracked Aternos servers
    checkTimeoutInterval: 60 * 1000,
  };

  // Skipping auto-detect is strongly recommended for Aternos because Aternos often blocks ping
  if (version && version !== "Auto-Detect") {
    botOptions.version = version;
    addLog("info", `Target Minecraft version specified: ${version}`);
  } else {
    addLog("warn", "Using Auto-Detect. If connection times out, explicitly select your server's Minecraft version.");
  }

  try {
    bot = mineflayer.createBot(botOptions);
  } catch (err) {
    botStatus = "INACTIVE";
    addLog("error", `Failed to initialize bot instance: ${err.message}`);
    return;
  }

  bot.once("login", () => {
    addLog("info", `Logged into ${host}. Awaiting world spawn...`);
  });

  bot.once("spawn", () => {
    botStatus = "ACTIVE";
    startTime = Date.now();
    retryCount = 0;
    addLog("success", `Bot successfully spawned in-game! Sentinel is active.`);
    startEmulation(toggles);

    // Check existing players if autoLeave is enabled
    if (toggles && toggles.autoLeave && getPlayerCount() > 0) {
      addLog("warn", "Players detected on spawn. Auto-Leave triggered: transitioning to STANDBY.");
      enterStandby(config);
    }
  });

  bot.on("death", () => {
    addLog("warn", "Bot died in-game.");
    if (toggles && toggles.autoRespawn) {
      setTimeout(() => {
        if (bot) {
          bot.respawn();
          addLog("info", "Auto-Respawn triggered.");
        }
      }, 1500);
    }
  });

  bot.on("playerJoined", (player) => {
    if (player.username === bot.username) return;
    addLog("info", `Player joined: ${player.username} (Total players: ${getPlayerCount()})`);

    if (toggles && toggles.autoLeave && botStatus === "ACTIVE") {
      addLog("warn", "Player presence detected! Disconnecting to STANDBY.");
      enterStandby(config);
    }
  });

  bot.on("playerLeft", (player) => {
    if (player.username === bot.username) return;
    addLog("info", `Player left: ${player.username} (Remaining: ${getPlayerCount()})`);

    if (toggles && toggles.instantRejoin && botStatus === "STANDBY") {
      if (getPlayerCount() === 0) {
        addLog("info", "Server is now empty. Instant Rejoin triggered!");
        connectBot(config);
      }
    }
  });

  bot.on("chat", (sender, message) => {
    if (sender === bot.username) return;
    addLog("chat", `<${sender}> ${message}`);
  });

  bot.on("kicked", (reason) => {
    const reasonStr = typeof reason === "object" ? JSON.stringify(reason) : String(reason);
    addLog("error", `Bot was kicked: ${reasonStr}`);
  });

  bot.on("error", (err) => {
    addLog("error", `Socket error: ${err.message || err.code || "Unknown error"}`);
  });

  bot.on("end", (reason) => {
    stopEmulation();
    startTime = null;

    if (botStatus === "STANDBY") {
      addLog("info", "Disconnected into STANDBY mode.");
      return;
    }

    if (botStatus === "INACTIVE") {
      addLog("info", "Bot disconnected.");
      return;
    }

    addLog("warn", `Connection terminated (${reason || "closed"}).`);

    if (toggles && toggles.autoReconnect) {
      retryCount++;
      const delay = Math.min(30000, 3000 * Math.pow(1.5, retryCount));
      botStatus = "CONNECTING";
      addLog("info", `Auto Reconnect attempt #${retryCount} scheduled in ${(delay / 1000).toFixed(1)}s...`);

      reconnectTimer = setTimeout(() => {
        connectBot(config);
      }, delay);
    } else {
      botStatus = "INACTIVE";
    }
  });
}

function enterStandby(config) {
  botStatus = "STANDBY";
  destroyBot();
  // Poll server status or wait for instant rejoin
}

// ---------------- REST API ----------------

app.get("/api/status", (req, res) => {
  res.json({
    status: botStatus,
    uptime: getUptimeSeconds(),
    players: getPlayerCount(),
    retries: retryCount,
    username: currentConfig ? currentConfig.username : undefined,
    logs: logs.slice(-150),
  });
});

app.post("/api/start", (req, res) => {
  const { host, port, username, version, toggles } = req.body;

  if (!host) {
    return res.status(400).json({ message: "Server host (IP) is required." });
  }

  retryCount = 0;
  connectBot({
    host,
    port: port || 25565,
    username: username || "AFK_Sentinel",
    version,
    toggles: toggles || {},
  });

  res.json({ message: "Connecting Sentinel bot..." });
});

app.post("/api/stop", (req, res) => {
  botStatus = "INACTIVE";
  destroyBot();
  startTime = null;
  retryCount = 0;
  addLog("info", "Bot stopped by user.");
  res.json({ message: "Bot deactivated." });
});

app.post("/api/chat", (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ message: "Empty command." });

  if (!bot || botStatus !== "ACTIVE") {
    return res.status(400).json({ message: "Bot is not active in-game." });
  }

  try {
    bot.chat(message);
    addLog("chat", `[OUT] ${message}`);
    res.json({ message: "Command dispatched." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Aternos Sentinel backend running on port ${PORT}`);
});
