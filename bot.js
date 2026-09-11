const express = require('express');
const mineflayer = require('mineflayer');
const { createClient } = require('@supabase/supabase-js');

// Express Web Server (Render & Cron-job.org ke liye)
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Aternos AFK Bot Service is Running 24/7!');
});

app.listen(PORT, () => {
  console.log(`Web server running on port ${PORT}`);
});

// Supabase Connection
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.log('WARNING: Supabase credentials missing in Environment Variables!');
}

let activeBot = null;
let currentConfig = null;

async function logToDashboard(message, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${message}`);
  if (supabase) {
    await supabase.from('bot_logs').insert([{ message, level, timestamp: new Date() }]);
  }
}

async function updateStatus(status) {
  if (supabase) {
    await supabase.from('bot_config').update({ status }).eq('id', 1);
  }
}

function startBot(config) {
  if (activeBot) return;

  logToDashboard(`Connecting to ${config.server_ip}:${config.port}...`);
  updateStatus('CONNECTING');

  activeBot = mineflayer.createBot({
    host: config.server_ip,
    port: parseInt(config.port) || 25565,
    username: config.bot_username || 'AFK_Sentinel',
    version: config.mc_version === 'auto' ? false : config.mc_version
  });

  // 1. Auto Respawn
  activeBot.on('death', () => {
    logToDashboard('Bot died! Respawning in a moment...', 'warn');
    setTimeout(() => {
      if (activeBot && config.auto_respawn) {
        activeBot.respawn();
      }
    }, 2000);
  });

  // 2. Player Auto-Leave
  activeBot.on('playerJoined', (player) => {
    if (player.username === activeBot.username) return;
    logToDashboard(`Player joined: ${player.username}`);

    if (config.auto_leave) {
      logToDashboard('Player detected! Leaving server to look real...');
      setTimeout(() => {
        if (activeBot) {
          activeBot.quit();
          activeBot = null;
          updateStatus('STANDING_BY');
        }
      }, 3000);
    }
  });

  activeBot.on('spawn', () => {
    logToDashboard('Bot successfully joined the server!');
    updateStatus('ACTIVE IN-GAME');
  });

  // 3. Auto Reconnect
  activeBot.on('end', (reason) => {
    logToDashboard(`Bot disconnected: ${reason}`, 'error');
    activeBot = null;
    updateStatus('DISCONNECTED');

    if (currentConfig?.is_active) {
      logToDashboard('Reconnecting in 15 seconds...');
      setTimeout(() => {
        if (currentConfig?.is_active) startBot(currentConfig);
      }, 15000);
    }
  });

  activeBot.on('error', (err) => logToDashboard(`Error: ${err.message}`, 'error'));
}

function stopBot() {
  if (activeBot) {
    logToDashboard('Stopping bot...');
    activeBot.quit();
    activeBot = null;
  }
  updateStatus('INACTIVE');
}

// Supabase se Realtime Commands Sunna
if (supabase) {
  supabase
    .channel('schema-db-changes')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'bot_config' }, (payload) => {
      currentConfig = payload.new;
      if (currentConfig.is_active && !activeBot) {
        startBot(currentConfig);
      } else if (!currentConfig.is_active && activeBot) {
        stopBot();
      }
    })
    .subscribe();
}
