const express = require('express');
const mineflayer = require('mineflayer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
let activeBot = null;
let currentStatus = 'INACTIVE';

app.get('/', (req, res) => {
  res.send(`Aternos Bot API Active. Status: ${currentStatus}`);
});

// Lovable Dashboard se commands lene ke liye APIs
app.post('/api/start', (req, res) => {
  const { host, port, username } = req.body;
  if (activeBot) {
    return res.json({ success: false, message: 'Bot pehle se active hai!' });
  }

  currentStatus = 'CONNECTING';
  
  activeBot = mineflayer.createBot({
    host: host,
    port: parseInt(port) || 25565,
    username: username || 'AFK_Bot',
  });

  activeBot.on('spawn', () => {
    currentStatus = 'ACTIVE IN-GAME';
    console.log('Bot successfully joined!');
  });

  activeBot.on('end', () => {
    activeBot = null;
    currentStatus = 'DISCONNECTED';
  });

  activeBot.on('error', (err) => {
    console.log('Error:', err.message);
    activeBot = null;
    currentStatus = 'ERROR';
  });

  res.json({ success: true, message: 'Bot start trigger ho gaya!' });
});

app.post('/api/stop', (req, res) => {
  if (activeBot) {
    activeBot.quit();
    activeBot = null;
    currentStatus = 'INACTIVE';
    res.json({ success: true, message: 'Bot stop kar diya gaya!' });
  } else {
    res.json({ success: false, message: 'Koi active bot nahi mila.' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ status: currentStatus });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
