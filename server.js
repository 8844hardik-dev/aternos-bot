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

function addLog(msg) {
  const timestamp = new Date().toLocaleTimeString();
  logs.push(`[${timestamp}] ${msg}`);
  if (logs.length > 50) logs.shift();
}

app.get('/', (req, res) => {
  res.send('Aternos Bot API Service is Online');
});

// 1. Status Polling Endpoint (Lovable isko har 5 sec me call kar raha hai)
app.get('/api/status', (req, res) => {
  res.json({
    status: currentStatus,
    uptime: process.uptime(),
    players: activeBot && activeBot.players ? Object.keys(activeBot.players).length : 0,
    logs: logs
  });
});

// 2. Start Bot Endpoint
app.post('/api/start', (req, res) => {
  const { host, port, username } = req.body;
  if (activeBot) {
    return res.json({ success: false, message: 'Bot already running!' });
  }

  currentStatus = 'CONNECTING';
  addLog(`Connecting to ${host}:${port || 25565} as ${username}...`);

  try {
    activeBot = mineflayer.createBot({
      host: host,
      port: parseInt(port) || 25565,
      username: username || 'AFK_Sentinel',
      version: false
    });

    activeBot.on('spawn', () => {
      currentStatus = 'ACTIVE IN-GAME';
      addLog('Bot successfully spawned in-game!');
    });

    activeBot.on('chat', (username, message) => {
      addLog(`[CHAT] <${username}> ${message}`);
    });

    activeBot.on('end', (reason) => {
      addLog(`Disconnected: ${reason}`);
      activeBot = null;
      currentStatus = 'DISCONNECTED';
    });

    activeBot.on('error', (err) => {
      addLog(`Error: ${err.message}`);
      activeBot = null;
      currentStatus = 'ERROR';
    });

    res.json({ success: true, message: 'Bot connection initiated.' });
  } catch (err) {
    addLog(`Exception: ${err.message}`);
    res.json({ success: false, message: err.message });
  }
});

// 3. Stop Bot Endpoint
app.post('/api/stop', (req, res) => {
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

// 4. In-Game Chat Endpoint
app.post('/api/chat', (req, res) => {
  const { message } = req.body;
  if (activeBot && currentStatus === 'ACTIVE IN-GAME') {
    activeBot.chat(message);
    addLog(`[SENT] ${message}`);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Bot is not in-game.' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
