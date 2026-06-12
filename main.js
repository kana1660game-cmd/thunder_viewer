'use strict';
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');

let mainWindow;
let ws = null;
let reconnectTimer = null;
let wsServerIdx = 0;
let wsStats = { msg: 0, parsed: 0 };

// ポートなし（443）が現在の正しいURL
const WS_SERVERS = [
  'wss://ws1.blitzortung.org',
  'wss://ws7.blitzortung.org',
  'wss://ws8.blitzortung.org',
  'wss://ws3.blitzortung.org',
];

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#080c18',
    title: '⚡ Lightning Monitor',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    connectBlitzortung(); // ウィンドウ表示後に接続開始
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (ws) ws.close();
  });
}

// ── Blitzortung WebSocket（メインプロセスで接続） ────────────────────────
// Electronのレンダラーでは外部WSが制限されることがあるためメインで接続し
// IPC経由でレンダラーにデータを送る

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/**
 * Blitzortung LZW デコード
 */
function decodeBlitzortung(raw) {
  // まずそのままJSONを試みる
  if (typeof raw === 'string' && raw[0] === '{') {
    try { return JSON.parse(raw); } catch {}
  }
  // LZW デコード
  try {
    const d = raw.split ? raw.split('') : Array.from(raw);
    const e = {};
    let c = d[0], f = c;
    const g = [c];
    let h = 256, o = h;
    for (let i = 1; i < d.length; i++) {
      const code = d[i].charCodeAt(0);
      const a = code < 256 ? d[i] : (e[code] !== undefined ? e[code] : f + c);
      g.push(a);
      c = a[0];
      e[o++] = f + c;
      f = a;
    }
    return JSON.parse(g.join(''));
  } catch { return null; }
}

function connectBlitzortung() {
  const url = WS_SERVERS[wsServerIdx % WS_SERVERS.length];
  sendToRenderer('ws-status', 'connecting');

  try {
    ws = new WebSocket(url, {
      headers: { 'User-Agent': 'LightningMonitor/1.0' },
      handshakeTimeout: 10000,
    });
  } catch (e) {
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    sendToRenderer('ws-status', 'connected');
    ws.send(JSON.stringify({ a: 111 }));
    clearTimeout(reconnectTimer);
  });

  ws.on('message', (data) => {
    try {
      const raw = data.toString('utf8');
      wsStats.msg++;
      const parsed = decodeBlitzortung(raw);
      if (parsed) {
        wsStats.parsed++;
        sendToRenderer('strike', parsed);
      }
    } catch {}
  });

  ws.on('error', () => {});
  ws.on('close', () => {
    sendToRenderer('ws-status', 'error');
    wsServerIdx++;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBlitzortung, 5000);
}

// ── WS 統計を定期送信（5秒ごと） ─────────────────────────────────────────
setInterval(() => {
  sendToRenderer('ws-stats', { ...wsStats });
}, 5000);

// ── アプリ起動 ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });

// ── Nominatim 逆ジオコーディング ─────────────────────────────────────────
const geocodeQueue = [];
let geocodeRunning = false;

function processGeocodeQueue() {
  if (geocodeRunning || geocodeQueue.length === 0) return;
  geocodeRunning = true;
  const { lat, lon, resolve } = geocodeQueue.shift();

  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=ja&zoom=10`;
  https.get(url, {
    headers: { 'User-Agent': 'LightningMonitor/1.0 personal-noncommercial-use' }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const a = json.address || {};
        const place = a.city || a.town || a.village || a.municipality || a.county || a.state || '不明';
        resolve({ place, pref: a.state || '', country: a.country || '' });
      } catch { resolve({ place: '不明', pref: '', country: '' }); }
      setTimeout(() => { geocodeRunning = false; processGeocodeQueue(); }, 1100);
    });
  }).on('error', () => {
    resolve({ place: '不明', pref: '', country: '' });
    setTimeout(() => { geocodeRunning = false; processGeocodeQueue(); }, 1100);
  });
}

ipcMain.handle('reverse-geocode', (event, { lat, lon }) => {
  return new Promise((resolve) => {
    geocodeQueue.push({ lat, lon, resolve });
    processGeocodeQueue();
  });
});
