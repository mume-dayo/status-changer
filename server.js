const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const activeConnections = new Map();

app.use(express.json());
app.use(express.static('public'));

function extractSpotifyImageId(url) {
  if (!url) return null;

  if (url.startsWith('https://i.scdn.co/image/')) {
    return url.split('/').pop();
  }

  if (url.startsWith('spotify:')) {
    return url.split(':').pop();
  }

  return null;
}

class DiscordConnection {
  constructor(token, sessionId) {
    this.token = token;
    this.sessionId = sessionId;
    this.ws = null;
    this.heartbeatTask = null;
    this.lastSequence = null;
    this.heartbeatAcked = true;
    this.shouldReconnect = true;
    this.currentActivity = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');

      this.ws.on('open', () => {
        console.log(`[${this.sessionId}] Connected to Discord Gateway`);
      });

      this.ws.on('message', (data) => {
        const payload = JSON.parse(data);
        this.handleMessage(payload, resolve, reject);
      });

      this.ws.on('close', (code) => {
        console.log(`[${this.sessionId}] Connection closed (Code: ${code})`);
        this.cleanup();

        if (this.shouldReconnect) {
          setTimeout(() => this.connect(), 5000);
        }
      });

      this.ws.on('error', (error) => {
        console.error(`[${this.sessionId}] WebSocket Error:`, error);
        reject(error);
      });
    });
  }

  handleMessage(payload, resolve, reject) {
    const { op, d, s, t } = payload;

    if (s) this.lastSequence = s;

    switch (op) {
      case 10:
        this.heartbeatAcked = true;
        const heartbeatInterval = d.heartbeat_interval;

        this.heartbeatTask = setInterval(() => {
          if (!this.heartbeatAcked) {
            console.log(`[${this.sessionId}] No heartbeat ACK, reconnecting...`);
            this.ws.close();
            return;
          }

          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.heartbeatAcked = false;
            this.ws.send(JSON.stringify({ op: 1, d: this.lastSequence }));
          }
        }, heartbeatInterval);

        this.ws.send(JSON.stringify({
          op: 2,
          d: {
            token: this.token,
            properties: {
              os: 'Windows',
              browser: 'Chrome',
              device: ''
            }
          }
        }));

        console.log(`[${this.sessionId}] Identify sent`);
        break;

      case 11:
        this.heartbeatAcked = true;
        break;

      case 0:
        if (t === 'READY') {
          console.log(`[${this.sessionId}] Login successful`);
          if (resolve) {
            resolve(this);
            if (this.currentActivity) {
              this.updatePresence(this.currentActivity);
            }
          }
        }
        break;

      case 7:
        console.log(`[${this.sessionId}] Server requested reconnect`);
        this.ws.close();
        break;
    }
  }

  updatePresence(activityData) {
    this.currentActivity = activityData;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log(`[${this.sessionId}] Connection not ready, will apply when reconnected`);
      return;
    }

    let activity = null;

    if (activityData.name) {
      activity = {
        name: activityData.name,
        type: parseInt(activityData.type),
        details: activityData.details,
        state: activityData.state,
        assets: {}
      };

      if (activityData.imageUrl) {
        const imageId = extractSpotifyImageId(activityData.imageUrl);

        if (imageId) {
          activity.assets.large_image = `spotify:${imageId}`;
        }
        if (activityData.imageText) {
          activity.assets.large_text = activityData.imageText;
        }
      }
    }

    const presenceUpdate = {
      op: 3,
      d: {
        since: 0,
        activities: activity ? [activity] : [],
        status: 'online',
        afk: false
      }
    };

    this.ws.send(JSON.stringify(presenceUpdate));
    console.log(`[${this.sessionId}] Presence updated`);
  }

  cleanup() {
    if (this.heartbeatTask) {
      clearInterval(this.heartbeatTask);
      this.heartbeatTask = null;
    }
  }

  disconnect() {
    this.shouldReconnect = false;
    this.currentActivity = null;
    if (this.ws) {
      this.ws.close();
    }
    this.cleanup();
  }
}

app.get('/api/spotify-info', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Spotify URL is required' });
  }

  try {
    let trackId = null;
    let urlType = null;

    if (url.includes('/track/')) {
      trackId = url.split('/track/')[1].split('?')[0].split('/')[0];
      urlType = 'track';
    } else if (url.includes('/album/')) {
      trackId = url.split('/album/')[1].split('?')[0].split('/')[0];
      urlType = 'album';
    } else if (url.includes('spotify:track:')) {
      trackId = url.split('spotify:track:')[1];
      urlType = 'track';
    } else if (url.includes('spotify:album:')) {
      trackId = url.split('spotify:album:')[1];
      urlType = 'album';
    } else {
      return res.status(400).json({ error: 'Invalid Spotify URL' });
    }

    const oembedUrl = `https://open.spotify.com/oembed?url=https://open.spotify.com/${urlType}/${trackId}`;
    const response = await fetch(oembedUrl);

    if (!response.ok) {
      return res.status(404).json({ error: 'Spotify track not found' });
    }

    const data = await response.json();
    const title = data.title || '';
    const thumbnailUrl = data.thumbnail_url || '';

    let songName = title;
    let artistName = 'Unknown Artist';

    if (title.includes(' - ')) {
      const parts = title.split(' - ', 2);
      songName = parts[0].trim();
      artistName = parts[1].trim();
    }

    let spotifyImageId = null;
    if (thumbnailUrl && thumbnailUrl.includes('/image/')) {
      spotifyImageId = thumbnailUrl.split('/image/')[1];
    }

    res.json({
      songName,
      artistName,
      thumbnailUrl,
      spotifyImageId,
      trackId
    });

  } catch (error) {
    console.error('Spotify API Error:', error);
    res.status(500).json({ error: 'Failed to fetch Spotify info', message: error.message });
  }
});

app.post('/api/connect', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  const sessionId = Math.random().toString(36).substring(7);

  try {
    const connection = new DiscordConnection(token, sessionId);
    await connection.connect();

    activeConnections.set(sessionId, connection);

    res.json({
      success: true,
      sessionId,
      message: 'Connected to Discord Gateway'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to connect to Discord',
      message: error.message
    });
  }
});

app.post('/api/update-status', (req, res) => {
  const { sessionId, activity } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }

  const connection = activeConnections.get(sessionId);

  if (!connection) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    connection.updatePresence(activity);
    res.json({
      success: true,
      message: 'Status updated successfully'
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update status',
      message: error.message
    });
  }
});

app.post('/api/disconnect', (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID is required' });
  }

  const connection = activeConnections.get(sessionId);

  if (!connection) {
    return res.status(404).json({ error: 'Session not found' });
  }

  connection.disconnect();
  activeConnections.delete(sessionId);

  res.json({
    success: true,
    message: 'Disconnected successfully'
  });
});

app.get('/api/status/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  const connection = activeConnections.get(sessionId);

  if (!connection) {
    return res.json({ connected: false });
  }

  res.json({
    connected: connection.ws && connection.ws.readyState === WebSocket.OPEN,
    currentActivity: connection.currentActivity
  });
});

app.get('/api/sessions', (req, res) => {
  const sessions = Array.from(activeConnections.keys()).map(sessionId => {
    const connection = activeConnections.get(sessionId);
    return {
      sessionId,
      connected: connection.ws && connection.ws.readyState === WebSocket.OPEN,
      currentActivity: connection.currentActivity
    };
  });

  res.json({ sessions });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Discord Status Server started successfully');
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing all connections...');
  for (const [sessionId, connection] of activeConnections) {
    connection.disconnect();
  }
  process.exit(0);
});
