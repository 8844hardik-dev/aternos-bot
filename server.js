/**
 * Aternos AFK Sentinel — Render backend (anti-ban / anti-idle edition)
 *
 * Endpoints:
 *   POST /api/start    { host, port, username, version, toggles, spawnCommand, enableSpawnCommand }
 *   POST /api/stop
 *   GET  /api/status   -> { status, players, uptime, retries, username, logs }
 *   GET  /api/logs     -> { logs: [...] }
 *   POST /api/chat     { message }
 *   GET  /api/ping     -> { ok, status, time }
 *
 * Install: npm i express cors mineflayer
 * Start:   node server.js
 */
const express = require("express");
const cors = require("cors");
const mineflayer = require("mineflayer");

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- tuning ---------- */
const SESSION_MAX_MS = 2 * 60 * 60 * 1000; // cycle session every 2 hours
const SESSION_BREAK_MS = 160 * 1000; // 160s break (< Aternos 5 min idle shutdown)
const HEARTBEAT_MS = 4 * 60 * 1000; // /time query daytime
const SELF_PING_MS = 4 * 60 * 1000; // keep Render awake
const SELF_PING_URL = "https://aternos-bot-nl5e.onrender.com/api/ping";
const MOVEMENT_MS = 15 * 1000;
const IDENTITY_SUFFIXES = ["", "_1", "_2"];

const state = {
  status: "INACTIVE", // INACTIVE | CONNECTING | ACTIVE | STANDBY
  players: 0,
  retries: 0,
  startedAt: null,
  config: null,
  baseUsername: null,
  identityIndex: 0,
  cycles: 0,
  logs: [],
};

let bot = null;
let logId = 0;
let reconnectTimer = null;
let movementTimer = null;
let heartbeatTimer = null;
let sessionTimer = null;
let cycling = false;

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

function currentUsername() {
  const base = state.baseUsername || "Sentinel";
  const suffix = IDENTITY_SUFFIXES[state.identityIndex % IDENTITY_SUFFIXES.length];
  const name = `${base}${suffix}`;
  return name.slice(0, 16);
}

function rotateIdentity() {
  state.identityIndex = (state.identityIndex + 1) % IDENTITY_SUFFIXES.length;
  log("info", "sentinel", `Identity rotated -> ${currentUsername()}`);
}

function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (movementTimer) clearInterval(movementTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (sessionTimer) clearTimeout(sessionTimer);
  reconnectTimer = null;
  movementTimer = null;
  heartbeatTimer = null;
  sessionTimer = null;
}

const rand = (min, max) => min + Math.random() * (max - min);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/* ---------- anti-AFK human simulation ---------- */
function humanMovement() {
  movementTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    try {
      // head turn
      const yaw = rand(-Math.PI, Math.PI);
      const pitch = rand(-0.4, 0.4);
      bot.look(yaw, pitch, true).catch(() => {});

      // micro-patrol: short walk in a random direction, then stop
      const dir = pick(["forward", "back", "left", "right"]);
      bot.setControlState(dir, true);
      setTimeout(() => bot && bot.setControlState(dir, false), Math.floor(rand(400, 1200)));

      // arm swing
      bot.swingArm("right");

      // hotbar cycling
      bot.setQuickBarSlot(Math.floor(rand(0, 9)));

      // occasional jump
      if (Math.random() < 0.4) {
        bot.setControlState("jump", true);
        setTimeout(() => bot && bot.setControlState("jump", false), 250);
      }

      // occasional sneak
      if (Math.random() < 0.3) {
        bot.setControlState("sneak", true);
        setTimeout(() => bot && bot.setControlState("sneak", false), Math.floor(rand(500, 1500)));
      }

      log("info", "human", `patrol ${dir} | yaw ${yaw.toFixed(2)} pitch ${pitch.toFixed(2)}`);
    } catch (err) {
      log("warn", "human", `movement skipped: ${err.message}`);
    }
  }, MOVEMENT_MS);
}

function heartbeat() {
  heartbeatTimer = setInterval(() => {
    if (!bot || !bot.entity) return;
    try {
      bot.chat("/time query daytime");
      log("info", "sentinel", "Anti-idle heartbeat sent (/time query daytime)");
    } catch (err) {
      log("warn", "sentinel", `heartbeat failed: ${err.message}`);
    }
  }, HEARTBEAT_MS);
}

/* ---------- proactive session cycling ---------- */
function scheduleSessionCycle() {
  sessionTimer = setTimeout(() => {
    if (!bot || state.status !== "ACTIVE") return;
    cycling = true;
    state.cycles += 1;
    log(
      "warn",
      "sentinel",
      `Session limit reached (2h) — taking a ${SESSION_BREAK_MS / 1000}s break to avoid Aternos flags.`,
    );
    clearTimers();
    state.status = "STANDBY";
    try {
      bot.quit("session cycle");
    } catch {
      /* already gone */
    }
  }, SESSION_MAX_MS);
}

/* ---------- connection ---------- */
function connect() {
  const cfg = state.config;
  if (!cfg) return;
  const username = currentUsername();
  state.status = "CONNECTING";
  log("info", "net", `Connecting to ${cfg.host}:${cfg.port} as ${username}`);

  try {
    bot = mineflayer.createBot({
      host: cfg.host,
      port: Number(cfg.port) || 25565,
      username,
      version: cfg.version && cfg.version !== "Auto-Detect" ? cfg.version : false,
      auth: "offline",
    });
  } catch (err) {
    log("error", "net", `createBot failed: ${err.message}`);
    bot = null;
    scheduleReconnect();
    return;
  }

  bot.once("spawn", () => {
    state.status = "ACTIVE";
    state.startedAt = Date.now();
    state.retries = 0;
    cycling = false;
    log("success", "game", `${username} joined the game`);

    if (cfg.enableSpawnCommand && cfg.spawnCommand) {
      setTimeout(() => {
        if (!bot) return;
        try {
          bot.chat(cfg.spawnCommand);
          log("info", "sentinel", `Spawn command sent: ${cfg.spawnCommand}`);
        } catch (err) {
          log("warn", "sentinel", `Spawn command failed: ${err.message}`);
        }
      }, 2500);
    }

    if (cfg.toggles?.humanMovement) humanMovement();
    heartbeat();
    scheduleSessionCycle();
  });

  bot.on("playerJoined", (player) => {
    if (!bot || player.username === bot.username) return;
    state.players = Math.max(0, Object.keys(bot.players).length - 1);
    log("info", "game", `${player.username} joined the game — staying in-game.`);
  });

  bot.on("playerLeft", () => {
    if (!bot) return;
    state.players = Math.max(0, Object.keys(bot.players).length - 1);
  });

  bot.on("death", () => {
    log("error", "game", `${username} died`);
    if (cfg.toggles?.autoRespawn) {
      try {
        bot.respawn?.();
      } catch {
        /* mineflayer auto-respawns by default */
      }
      log("success", "sentinel", "Auto-respawn sent.");
    }
  });

  bot.on("messagestr", (msg) => log("chat", "chat", msg));
  bot.on("kicked", (reason) => log("error", "net", `Kicked: ${reason}`));
  bot.on("error", (err) => log("error", "net", err.message));

  bot.on("end", () => {
    clearTimers();
    bot = null;
    state.startedAt = null;
    state.players = 0;

    if (state.status === "INACTIVE") return;

    if (cycling || state.status === "STANDBY") {
      rotateIdentity();
      state.status = "STANDBY";
      log("info", "sentinel", `Standing by — rejoining in ${SESSION_BREAK_MS / 1000}s with a fresh identity.`);
      reconnectTimer = setTimeout(() => {
        cycling = false;
        state.status = "CONNECTING";
        log("info", "sentinel", "Cooldown complete — reconnecting now.");
        connect();
      }, SESSION_BREAK_MS);
      return;
    }

    scheduleReconnect();
  });
}

function scheduleReconnect() {
  const cfg = state.config;
  if (!cfg || !cfg.toggles?.autoReconnect) {
    state.status = "INACTIVE";
    return;
  }
  state.retries += 1;
  const delay = Math.min(2 ** state.retries, 64) * 1000;
  state.status = "CONNECTING";
  log("warn", "sentinel", `Reconnect #${state.retries} in ${delay / 1000}s`);
  reconnectTimer = setTimeout(connect, delay);
}

/* ---------- keep Render awake ---------- */
setInterval(async () => {
  try {
    const res = await fetch(SELF_PING_URL);
    log("info", "host", `Self-ping ${res.status} — Render stays awake.`);
  } catch (err) {
    log("warn", "host", `Self-ping failed: ${err.message}`);
  }
}, SELF_PING_MS);

/* ---------- crash guards ---------- */
process.on("uncaughtException", (err) => {
  log("error", "process", `uncaughtException: ${err.message}`);
  console.error("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  log("error", "process", `unhandledRejection: ${reason}`);
  console.error("unhandledRejection", reason);
});

/* ---------- REST API ---------- */
app.get("/", (_req, res) => res.send("Aternos AFK Bot Service is Running 24/7!"));

app.get("/api/ping", (_req, res) =>
  res.json({ ok: true, status: state.status, time: new Date().toISOString() }),
);

app.post("/api/start", (req, res) => {
  const { host, port, username, version, toggles, spawnCommand, enableSpawnCommand } =
    req.body || {};
  if (!host || !username)
    return res.status(400).json({ error: "host and username required", message: "host and username required" });
  if (bot) return res.json({ ok: true, already: true, message: "Bot already running." });

  state.config = {
    host,
    port,
    username,
    version,
    toggles: toggles || {},
    spawnCommand: spawnCommand || "",
    enableSpawnCommand: Boolean(enableSpawnCommand),
  };
  state.baseUsername = String(username).replace(/_\d+$/, "");
  state.identityIndex = 0;
  state.retries = 0;
  state.players = 0;
  state.cycles = 0;
  state.startedAt = null;
  cycling = false;
  log("info", "sentinel", "Start requested by operator.");
  connect();
  res.json({ ok: true, message: `Connecting to ${host}:${port || 25565} as ${currentUsername()}` });
});

app.post("/api/stop", (_req, res) => {
  state.status = "INACTIVE";
  clearTimers();
  cycling = false;
  if (bot) {
    try {
      bot.quit("operator stop");
    } catch {
      /* noop */
    }
  }
  bot = null;
  state.players = 0;
  state.startedAt = null;
  log("warn", "sentinel", "Bot deactivated by operator.");
  res.json({ ok: true, message: "Bot deactivated." });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: state.status,
    running: state.status !== "INACTIVE",
    players: state.players,
    retries: state.retries,
    cycles: state.cycles,
    uptime:
      state.status === "ACTIVE" && state.startedAt
        ? Math.floor((Date.now() - state.startedAt) / 1000)
        : 0,
    username: state.config ? currentUsername() : undefined,
    logs: state.logs.slice(-200),
  });
});

app.get("/api/logs", (req, res) => {
  const since = Number(req.query.since);
  const logs = Number.isFinite(since) ? state.logs.filter((l) => l.id > since) : state.logs;
  res.json({ logs });
});

app.post("/api/chat", (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "message required", message: "message required" });
  if (!bot) return res.status(409).json({ error: "bot not connected", message: "Bot is not connected." });
  bot.chat(message);
  log("chat", message.startsWith("/") ? "command" : "chat", message);
  res.json({ ok: true, message: "Sent." });
});

app.listen(process.env.PORT || 3000, () => console.log("AFK Sentinel backend up"));
