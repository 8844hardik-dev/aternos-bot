const express = require("express");
const cors = require("cors");
const mineflayer = require("mineflayer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// Global State
let bot = null;
let botStatus = "INACTIVE"; // 'INACTIVE' | 'CONNECTING' | 'ACTIVE' | 'STANDBY'
let startTime = null;
let retryCount = 0;
let reconnectTimer = null;
let movementInterval = null;
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
  return Math.max(0, Object.keys(bot.players).length - 1);
}

function stopEmulation() {
  if (movementInterval) {
    clearInterval(movementInterval);
    movementInterval = null;
  }
}

function startEmulation(toggles) {
  stopEmulation();
  if (!toggles || !toggles.humanMovement) return;

  movementInterval = setInterval(() => {
    if (!bot || botStatus !== "ACTIVE" || !bot.entity) return;

    // Small random head movement
    const yawOffset = (Math.random() - 0.5) * 0.4;
    const pitchOffset = (Math.random() - 0.5) * 0.2;
    bot.look(bot.entity.yaw + yawOffset, bot.entity.pitch + pitchOffset, true).catch(() => {});

    // Occasional arm swing or sneak
    const roll = Math.random();
    if (roll > 0.6) {
      bot.swingArm("right");
    }
    if (roll > 0.85) {
      bot.setControlState("sneak", true);
      setTimeout(() => {
        if (bot && botStatus === "ACTIVE") {
          bot.setControlState("sneak", false);
        }
      }, 500);
    }
  }, 4000);
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

  let { host, port, username, version, toggles } = config;

  // Clean host and port in case user typed "host:port" in the host field
  if (host && host.includes(":")) {
    const parts = host.split(":");
    host = parts[0].trim();
    if (!port || port === 25565) {
      port = parseInt(parts[1].trim(), 10);
    }
  }

  const finalHost = host.trim();
  const finalPort = Number(port) || 25565;
  const finalUsername = (username || "AFK_Sentinel").trim();

  botStatus = "CONNECTING";
  addLog("info", `Attempting connection to ${finalHost}:${finalPort} as "${finalUsername}"...`);

  const botOptions = {
    host: finalHost,
    port: finalPort,
    username: finalUsername,
    auth: "offline", // Always offline for Cracked Aternos servers
    checkTimeoutInterval: 90 * 1000,
  };

  if (version && version !== "Auto-Detect") {
    botOptions.version = String(version).trim();
    addLog("info", `Explicit Minecraft version provided: ${botOptions.version}`);
  } else {
    addLog("warn", "Using Auto-Detect. If connection times out, select your exact server version from the dropdown.");
  }

  try {
    bot = mineflayer.createBot(botOptions);
  } catch (err) {
    botStatus = "INACTIVE";
    addLog("error", `Failed to create bot instance: ${err.message}`);
    return;
  }

  bot.once("login", () => {
    addLog("info", `Login handshake successful. Waiting for world spawn...`);
  });

  bot.once("spawn", () => {
    botStatus = "ACTIVE";
    startTime = Date.now();
    retryCount = 0;
    addLog("success", `Bot successfully spawned into ${finalHost}!`);
    startEmulation(toggles);

    if (toggles && toggles.autoLeave && getPlayerCount() > 0) {
      addLog("warn", "Players are currently online. Auto-Leave triggered: switching to STANDBY.");
      enterStandby(config);
    }
  });

  bot.on("death", () => {
    addLog("warn", "Bot died in-game.");
    if (toggles && toggles.autoRespawn) {
      setTimeout(() => {
        if (bot && botStatus === "ACTIVE") {
          bot.respawn();
          addLog("info", "Auto-Respawn triggered.");
        }
      }, 1500);
    }
  });

  bot.on("playerJoined", (player) => {
    if (player.username === bot.username) return;
    addLog("info", `Player joined: ${player.username} (Players online: ${getPlayerCount()})`);

    if (toggles && toggles.autoLeave && botStatus === "ACTIVE") {
      addLog("warn", "Player joined. Auto-Leave triggered: disconnecting to STANDBY.");
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
    let reasonText = "";
    try {
      const parsed = typeof reason === "string" ? JSON.parse(reason) : reason;
      reasonText = parsed.text || parsed.translate || JSON.stringify(reason);
    } catch {
      reasonText = String(reason);
    }
    addLog("error", `Kicked from server: ${reasonText}`);
    if (reasonText.toLowerCase().includes("online") || reasonText.toLowerCase().includes("verify")) {
      addLog("warn", "Check Aternos: 'Cracked' must be turned ON in your server options.");
    }
  });

  bot.on("error", (err) => {
    const msg = err.message || err.code || "Unknown error";
    addLog("error", `Connection error: ${msg}`);

    if (msg.includes("ETIMEDOUT") || msg.includes("ECONNREFUSED")) {
      addLog(
        "warn",
        "Server unreachable. Verify: 1) Aternos server shows 'Online' (not offline or in queue), 2) Port matches your active Aternos dynamic port."
      );
    }
  });

  bot.on("end", (reason) => {
    stopEmulation();
    startTime = null;

    if (botStatus === "STANDBY") {
      addLog("info", "Bot in STANDBY mode.");
      return;
    }

    if (botStatus === "INACTIVE") {
      addLog("info", "Bot disconnected.");
      return;
    }

    addLog("warn", `Connection ended: ${reason || "socket closed"}.`);

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
}

// ---------------- REST API Endpoints ----------------

app.get("/api/status", (req, res) => {
  res.json({
    status: botStatus,
    uptime: getUptimeSeconds(),
    players: getPlayerCount(),
    retries: retryCount,
    username: currentConfig ? currentConfig.username : undefined,
    logs: logs.slice(-200),
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
  addLog("info", "Bot deactivated by user.");
  res.json({ message: "Bot deactivated." });
});

app.post("/api/chat", (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ message: "Command cannot be empty." });

  if (!bot || botStatus !== "ACTIVE") {
    return res.status(400).json({ message: "Bot is not active in-game." });
  }

  try {
    bot.chat(message);
    addLog("chat", `[CMD SENT] ${message}`);
    res.json({ message: "Command dispatched successfully." });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Sentinel backend listening on port ${PORT}`);
});
