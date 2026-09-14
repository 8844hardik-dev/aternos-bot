const express = require('express');
const cors = require('cors');
const mineflayer = require('mineflayer');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
let activeBot = null;
let currentStatus = 'INACTIVE';
let logs = [];
let combatInterval = null;

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString();
  logs.push(`[${timestamp}] ${msg}`);
  if (logs.length > 50) logs.shift();
}

// Hostile Mobs List to target
const HOSTILE_MOBS = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'zombie_villager', 'drowned', 'husk'];

function runCombatEngine() {
  if (!activeBot || !activeBot.entity) return;

  // 1. Check Nearby Threat (Players & Low Health Emergency Run)
  const nearbyPlayer = activeBot.nearestEntity(e => e.type === 'player' && e.username !== activeBot.username && activeBot.entity.position.distanceTo(e.position) < 8);
  const isLowHealth = activeBot.health < 10;

  if (nearbyPlayer || isLowHealth) {
    if (nearbyPlayer) addLog(`[SURVIVAL] Player detected (${nearbyPlayer.username}). Fleeing!`);
    if (isLowHealth) addLog(`[SURVIVAL] Low Health (${activeBot.health} HP). Fleeing combat!`);

    // Sprint & Jump Away
    activeBot.setControlState('sprint', true);
    activeBot.setControlState('forward', true);
    activeBot.setControlState('jump', true);

    // Turn away from threat if player exists
    if (nearbyPlayer) {
      const yaw = Math.atan2(activeBot.entity.position.x - nearbyPlayer.position.x, activeBot.entity.position.z - nearbyPlayer.position.z);
      activeBot.look(yaw, 0);
    }
    return;
  }

  // Stop Fleeing if safe
  activeBot.setControlState('sprint', false);

  // 2. Target Nearby Hostile Mobs
  const targetMob = activeBot.nearestEntity(e => 
    e.type === 'mob' && 
    HOSTILE_MOBS.includes(e.name) && 
    activeBot.entity.position.distanceTo(e.position) < 6
  );

  if (targetMob) {
    // Look at mob & attack
    activeBot.lookAt(targetMob.position.offset(0, targetMob.height, 0));
    activeBot.attack(targetMob);
    activeBot.setControlState('forward', true);
    addLog(`[COMBAT] Attacking ${targetMob.name}!`);
  } else {
    // 3. Idle Anti-AFK Routine when no combat
    activeBot.setControlState('forward', false);
    if (Math.random() < 0.2) {
      activeBot.setControlState('jump', true);
      setTimeout(() => activeBot && activeBot.setControlState('jump', false), 400);
      activeBot.look(Math.random() * Math.PI * 2, 0);
    }
  }
}

app.get('/', (req, res) => res.send('Combat AFK Bot API Online'));

app.get('/api/status', (req, res) => {
  res.json({
    status: currentStatus,
    uptime: Math.floor(process.uptime()),
    players: activeBot && activeBot.players ? Object.keys(activeBot.players).length : 0,
    logs: logs
  });
});

app.post('/api/start', (req, res) => {
  const { host, port, username } = req.body;
  if (activeBot) return res.json({ success: false, message: 'Bot pehle se active hai!' });

  currentStatus = 'CONNECTING';
  addLog(`Connecting to ${host}:${port || 25565}...`);

  try {
    activeBot = mineflayer.createBot({
      host: host,
      port: parseInt(port) || 25565,
      username: username || 'Combat_AFK_Bot',
      version: false
    });

    activeBot.on('spawn', () => {
      currentStatus = 'ACTIVE IN-GAME';
      addLog('Bot joined! Combat & Survival AI Engine Started.');

      // Run combat/flee loop every 600ms
      if (combatInterval) clearInterval(combatInterval);
      combatInterval = setInterval(() => {
        runCombatEngine();
      }, 600);
    });

    activeBot.on('death', () => {
      addLog('Bot died in combat! Respawning...');
      activeBot.respawn();
    });

    activeBot.on('chat', (user, msg) => {
      if (user !== activeBot.username) addLog(`[CHAT] <${user}> ${msg}`);
    });

    activeBot.on('end', (reason) => {
      addLog(`Disconnected: ${reason}`);
      if (combatInterval) clearInterval(combatInterval);
      activeBot = null;
      currentStatus = 'DISCONNECTED';
    });

    activeBot.on('error', (err) => {
      addLog(`Error: ${err.message}`);
      if (combatInterval) clearInterval(combatInterval);
      activeBot = null;
      currentStatus = 'ERROR';
    });

    res.json({ success: true, message: 'Combat bot setup initiated.' });
  } catch (err) {
    addLog(`Exception: ${err.message}`);
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/stop', (req, res) => {
  if (combatInterval) clearInterval(combatInterval);
  if (activeBot) {
    activeBot.quit();
    activeBot = null;
    currentStatus = 'INACTIVE';
    addLog('Bot stopped via dashboard.');
    res.json({ success: true, message: 'Bot stopped.' });
  } else {
    res.json({ success: false, message: 'No active bot.' });
  }
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (activeBot && currentStatus === 'ACTIVE IN-GAME') {
    activeBot.chat(message);
    addLog(`[SENT] ${message}`);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Bot in-game nahi hai.' });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
