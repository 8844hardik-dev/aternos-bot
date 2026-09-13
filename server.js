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
let afkInterval = null;

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString();
  logs.push(`[${timestamp}] ${msg}`);
  if (logs.length > 50) logs.shift();
}

app.get('/', (req, res) => {
  res.send('Aternos Bot API Service is Online');
});

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
  if (activeBot) {
    return res.json({ success: false, message: 'Bot pehle se chal raha hai!' });
  }

  currentStatus = 'CONNECTING';
  addLog(`Connecting to ${host}:${port || 25565}...`);

  try {
    activeBot = mineflayer.createBot({
      host: host,
      port: parseInt(port) || 25565,
      username: username || 'AFK_Sentinel',
      version: false
    });

    activeBot.on('spawn', () => {
      currentStatus = 'ACTIVE IN-GAME';
      addLog('Bot joined successfully! Anti-AFK activated.');

      // Anti-AFK Loop (Jumping & Looking Around)
      if (afkInterval) clearInterval(afkInterval);
      afkInterval = setInterval(() => {
        if (activeBot && activeBot.entity) {
          activeBot.setControlState('jump', true);
          setTimeout(() => activeBot && activeBot.setControlState('jump', false), 500);
          activeBot.look(Math.random() * Math.PI * 2, 0);
        }
      }, 15000); // Har 15 second mein movement
    });

    // Auto Respawn on Death
    activeBot.on('death', () => {
      addLog('Bot died! Respawning...');
      activeBot.respawn();
    });

    activeBot.on('chat', (user, msg) => {
      if (user !== activeBot.username) addLog(`[CHAT] <${user}> ${msg}`);
    });

    activeBot.on('end', (reason) => {
      addLog(`Disconnected: ${reason}`);
      if (afkInterval) clearInterval(afkInterval);
      activeBot = null;
      currentStatus = 'DISCONNECTED';
    });

    activeBot.on('error', (err) => {
      addLog(`Error: ${err.message}`);
      if (afkInterval) clearInterval(afkInterval);
      activeBot = null;
      currentStatus = 'ERROR';
    });

    res.json({ success: true, message: 'Connection request sent.' });
  } catch (err) {
    addLog(`Exception: ${err.message}`);
    res.json({ success: false, message: err.message });
  }
});

app.post('/api/stop', (req, res) => {
  if (afkInterval) clearInterval(afkInterval);
  if (activeBot) {
    activeBot.quit();
    activeBot = null;
    currentStatus = 'INACTIVE';
    addLog('Bot stopped via dashboard.');
    res.json({ success: true, message: 'Bot stopped.' });
  } else {
    res.json({ success: false, message: 'Koi active bot nahi hai.' });
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

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
