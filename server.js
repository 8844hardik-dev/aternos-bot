/**
 * Aternos AFK Sentinel — Render Backend
 * 
 * Features:
 *  - 2-Hour Proactive Session Cycling with 160s Break (safely under Aternos's 5-min shutdown)
 *  - Dynamic Identity Rotation (rotates username suffix across sessions to evade playtime tracking)
 *  - Physical Coordinate Movement & Micro-Patrols (forward, backward, jump, strafe)
 *  - Hotbar Slot Cycling (0–8) & Head Rotation
 *  - 4-Minute Periodic Server Heartbeat (/time query daytime)
 *  - Auto-Run Command on Spawn (e.g., /gamemode creative)
 *  - Auto-Respawn & Auto-Reconnect with Exponential Backoff
 *  - Auto-Leave on Player Join & Instant Rejoin when Server is Empty
 *  - 4-Minute Internal Self-Ping to prevent Render free-tier sleep
 *  - Crash Guards (uncaughtException & unhandledRejection handlers)
 */

const express = require("express");
const cors = require("cors");
const mineflayer = require("mineflayer");

// Crash Guards — Prevent Render container exits
process.on("uncaughtException", (err) => {
  console.error("[CRASH GUARD] Uncaught Exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH GUARD] Unhandled Rejection:", reason);
});

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const SELF_PING_URL = "https://aternos-bot-nl5e.onrender.com/api/ping";

// Session Cycling Constants
const SESSION_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours in-game
const SESSION_BREAK_MS = 160 * 1000;             // 2 min 40s offline (safely under Aternos 5-min shutdown)

const state = {
  status: "INACTIVE", // INACTIVE | CONNECTING | ACTIVE | STANDBY
  players: 0,
  retries: 0,
  startedAt: null,
  config: null,
  logs: [],
  sessionIndex: 1,
  currentUsername: "",
};

let bot = null;
let logId = 0;
let reconnectTimer = null;
let movementTimer = null;
let hotbarTimer = null;
let heartbeatTimer = null;
let sessionCycleTimer = null;
let breakTimer = null;

function log(level, source, message) {
  state.logs.push({
    id: logId++,
    time: new Date().toISOString(),
    level,
    source,
    message: String(message),
  });
  if (state.logs.length > 500) state.logs = state.logs.slice(-500);
}

function clearAllTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (movementTimer) clearInterval(movementTimer);
  if (hotbarTimer) clearInterval(hotbarTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (sessionCycleTimer) clearTimeout(sessionCycleTimer);
  if (breakTimer) clearTimeout(breakTimer);

  reconnectTimer = null;
  movementTimer = null;
  hotbarTimer = null;
  heartbeatTimer = null;
  sessionCycleTimer = null;
  breakTimer = null;
}

// Generate rotated username (e.g. Sentinel -> Sentinel_1 -> Sentinel_2)
function getRotatedUsername(baseName) {
  const clean = (baseName || "Sentinel").replace(/_\d+$/, "");
  const index = state.sessionIndex;
  // Suffix rotates through: base, base_1, base_2, base_3
  if (index === 1) return clean;
  return `${clean}_${index - 1}`;
}

// Emulate active human presence
function startHumanSimulation() {
  // 1. Coordinate Walking & Micro-Patrols (every 7 seconds)
  movementTimer = setInterval(() => {
    if (!bot || !bot.entity || state.status !== "ACTIVE") return;
    try {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() - 0.5) * 0.7;
      bot.look(yaw, pitch, true).catch(() => {});
      bot.swingArm("right");

      const dirRoll = Math.random();
      const moveKey = dirRoll < 0.4 ? "forward" : dirRoll < 0.65 ? "back" : dirRoll < 0.85 ? "left" : "right";

      bot.setControlState(moveKey, true);
      if (Math.random() < 0.3) bot.setControlState("jump", true);
      if (Math.random() < 0.25) bot.setControlState("sneak", true);

      setTimeout(() => {
        if (!bot) return;
        bot.setControlState("forward", false);
        bot.setControlState("back", false);
        bot.setControlState("left", false);
        bot.setControlState("right", false);
        bot.setControlState("jump", false);
        bot.setControlState("sneak", false);
      }, 1800 + Math.random() * 800);
    } catch (_) {}
  }, 7000);

  // 2. Hotbar Slot Cycling (every 12 seconds)
  hotbarTimer = setInterval(() => {
    if (!bot || state.status !== "ACTIVE") return;
    try {
      const slot = Math.floor(Math.random() * 9);
      bot.setQuickBarSlot(slot);
    } catch (_) {}
  }, 12000);

  // 3. Command Heartbeat to register active operator traffic (every 4 minutes)
  heartbeatTimer = setInterval(() => {
    if (!bot || state.status !== "ACTIVE") return;
    try {
      bot.chat("/time query daytime");
    } catch (_) {}
  }, 4 * 60 * 1000);
}

// Helper to decode kick payloads
function parseKickReason(reason) {
  if (!reason) return "empty reason";
  if (typeof reason === "string") return reason;
  try {
    if (typeof reason === "object") {
      if (reason.value && typeof reason.value === "object" && reason.value.text) {
        return reason.value.text.value || JSON.stringify(reason.value);
      }
      if (reason.text) return reason.text;
      return JSON.stringify(reason);
    }
  } catch (_) {}
  return String(reason);
}

function connect() {
  const cfg = state.config;
  if (!cfg) return;

  state.status = "CONNECTING";
  state.currentUsername = getRotatedUsername(cfg.username);
  log("info", "net", `Connecting to ${cfg.host}:${cfg.port} as "${state.currentUsername}"...`);

  try {
    bot = mineflayer.createBot({
      host: cfg.host,
      fakeHost: cfg.host,
      port: Number(cfg.port) || 25565,
      username: state.currentUsername,
      version: cfg.version && cfg.version.toLowerCase() !== "auto-detect" && cfg.version.toLowerCase() !== "custom" ? cfg.version : "1.21.4",
      auth: "offline",
      connectTimeout: 15000,
      checkTimeoutInterval: 30000,
    });
  } catch (err) {
    log("error", "net", `Client instantiation failed: ${err.message}`);
    scheduleReconnect();
    return;
  }

  bot.once("login", () => {
    log("info", "net", `Logged in as ${state.currentUsername}. Awaiting spawn...`);
  });

  bot.once("spawn", () => {
    state.status = "ACTIVE";
    state.startedAt = Date.now();
    state.retries = 0;

    const pos = bot.entity?.position;
    const coordStr = pos ? `(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)}, ${pos.z.toFixed(0)})` : "world";
    log("success", "game", `Spawned at ${coordStr}. Anti-AFK running.`);

    // Auto-Run Spawn Command (e.g. /gamemode creative)
    const cmd = cfg.spawnCommand || (cfg.enableSpawnCommand ? "/gamemode creative" : null);
    if (cmd) {
      setTimeout(() => {
        if (!bot || state.status !== "ACTIVE") return;
        try {
          bot.chat(cmd);
          log("info", "cmd", `Executed spawn command: ${cmd}`);
        } catch (_) {}
      }, 1500);
    }

    // Start anti-AFK behaviors
    const toggles = cfg.toggles || cfg;
    if (toggles.humanMovement !== false) {
      startHumanSimulation();
    }

    // Schedule 2-Hour Proactive Session Cycling
    sessionCycleTimer = setTimeout(() => {
      if (state.status !== "ACTIVE" || !bot) return;
      log("info", "sentinel", "2-hour session limit reached. Taking a 160s break to reset Aternos idle counter...");
      
      // Advance identity rotation (1 -> 2 -> 3 -> 4 -> 1)
      state.sessionIndex = (state.sessionIndex % 4) + 1;
      
      state.status = "STANDBY";
      state.startedAt = null;
      clearAllTimers();

      try {
        bot.quit("session_break");
      } catch (_) {}
      bot = null;

      // Safe break: 160s (server stays alive for 300s when empty)
      breakTimer = setTimeout(() => {
        log("info", "sentinel", `Break completed. Reconnecting as "${getRotatedUsername(cfg.username)}"...`);
        connect();
      }, SESSION_BREAK_MS);
    }, SESSION_DURATION_MS);
  });

  // Auto-Leave when real players join
  bot.on("playerJoined", (player) => {
    if (!bot || player.username === bot.username) return;
    state.players = Math.max(0, Object.keys(bot.players || {}).length - 1);
    log("info", "game", `Player joined: ${player.username}`);

    const toggles = cfg.toggles || cfg;
    if (toggles.autoLeave) {
      log("warn", "sentinel", "Player detected. Leaving server to remain invisible.");
      state.status = "STANDBY";
      state.startedAt = null;
      clearAllTimers();
      try {
        bot.quit("player_present");
      } catch (_) {}
      bot = null;
    }
  });

  bot.on("playerLeft", (player) => {
    if (!bot || player.username === bot.username) return;
    state.players = Math.max(0, Object.keys(bot.players || {}).length - 1);
    log("info", "game", `Player left: ${player.username}`);

    const toggles = cfg.toggles || cfg;
    if (state.status === "STANDBY" && state.players === 0 && toggles.instantRejoin) {
      log("info", "sentinel", "Server is now empty. Rejoining in 15 seconds...");
      setTimeout(connect, 15000);
    }
  });

  // Auto-Respawn
  bot.on("death", () => {
    log("error", "game", "Bot died.");
    const toggles = cfg.toggles || cfg;
    if (toggles.autoRespawn !== false) {
      setTimeout(() => {
        if (!bot) return;
        try {
          bot.respawn();
          log("info", "sentinel", "Respawn triggered.");
        } catch (_) {}
      }, 1000);
    }
  });

  bot.on("messagestr", (msg) => {
    if (!msg || msg.trim().length === 0) return;
    log("chat", "chat", msg);
  });

  bot.on("kicked", (reason) => {
    const text = parseKickReason(reason);
    log("error", "net", `Kicked from server: ${text}`);
  });

  bot.on("error", (err) => {
    log("error", "net", `Connection error: ${err.message}`);
  });

  bot.on("end", (reason) => {
    log("warn", "net", `Disconnected (${reason || "socketClosed"})`);
    clearAllTimers();
    bot = null;

    if (state.status === "INACTIVE" || state.status === "STANDBY") {
      state.startedAt = null;
      return;
    }

    state.startedAt = null;
    const toggles = cfg.toggles || cfg;
    if (toggles.autoReconnect !== false) {
      scheduleReconnect();
    } else {
      state.status = "INACTIVE";
    }
  });
}

function scheduleReconnect() {
  state.retries += 1;
  const delay = Math.min(10 * Math.pow(1.3, Math.min(state.retries, 10)), 60) * 1000;
  state.status = "CONNECTING";
  log("info", "sentinel", `Auto-reconnect scheduled in ${Math.round(delay / 1000)}s (Attempt #${state.retries})`);
  reconnectTimer = setTimeout(connect, delay);
}

// Keep Render Awake: 4-minute self ping
setInterval(async () => {
  try {
    await fetch(SELF_PING_URL, { signal: AbortSignal.timeout(10000) });
  } catch (_) {}
}, 4 * 60 * 1000);

/* ================= HTTP ENDPOINTS ================= */

app.get("/", (_req, res) => res.send("Aternos AFK Sentinel 24/7 Backend Active"));
app.get("/api/ping", (_req, res) => res.send("pong"));

app.get("/api/status", (_req, res) => {
  res.json({
    status: state.status,
    players: state.players,
    uptime: state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0,
    retries: state.retries,
    username: state.currentUsername || (state.config && state.config.username) || "Sentinel",
    sessionIndex: state.sessionIndex,
    logs: state.logs,
  });
});

app.post("/api/start", (req, res) => {
  const { host, port, username, version, toggles, spawnCommand, enableSpawnCommand } = req.body;
  if (!host || !username) {
    return res.status(400).json({ error: "Host and username are required." });
  }

  clearAllTimers();
  if (bot) {
    try {
      bot.quit("manual_restart");
    } catch (_) {}
    bot = null;
  }

  state.config = {
    host,
    port: Number(port) || 25565,
    username,
    version,
    toggles: toggles || {},
    spawnCommand,
    enableSpawnCommand,
  };

  state.sessionIndex = 1;
  state.retries = 0;
  state.startedAt = null;

  connect();
  res.json({ message: "Sentinel bot activation initiated." });
});

app.post("/api/stop", (_req, res) => {
  clearAllTimers();
  state.status = "INACTIVE";
  state.startedAt = null;
  if (bot) {
    try {
      bot.quit("manual_stop");
    } catch (_) {}
    bot = null;
  }
  log("info", "dashboard", "Bot deactivated manually by user.");
  res.json({ message: "Sentinel bot deactivated." });
});

app.post("/api/chat", (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required." });
  if (!bot || state.status !== "ACTIVE") {
    return res.status(400).json({ error: "Bot is not active in-game." });
  }
  try {
    bot.chat(message);
    log("chat", "sentinel", `> ${message}`);
    res.json({ message: "Sent to server." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Sentinel backend running on port ${PORT}`);
  log("info", "sys", `Sentinel backend initialized on port ${PORT}`);
});
