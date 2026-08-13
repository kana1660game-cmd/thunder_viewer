'use strict';
/*
 * browser-api.js
 * ───────────────────────────────────────────────────────────────
 * Electron 版では main.js（Node プロセス）が Blitzortung への
 * WebSocket 接続と Nominatim 逆ジオコーディングを担当し、preload.js が
 * window.electronAPI を公開していた。
 *
 * GitHub Pages は静的ホスティングで Node バックエンドを持てないため、
 * このファイルがブラウザのネイティブ WebSocket / fetch を使って
 * window.electronAPI と同じインターフェースを再現する。
 * これにより renderer.js は一切変更せずにそのまま動作する。
 */

(function () {
  // ── コールバック登録先 ──────────────────────────────────────
  const handlers = {
    strike:   [],
    status:   [],
    stats:    [],
  };

  // ── Blitzortung WebSocket ──────────────────────────────────
  // ポートなし（443）が現在の正しい URL
  const WS_SERVERS = [
    'wss://ws1.blitzortung.org',
    'wss://ws7.blitzortung.org',
    'wss://ws8.blitzortung.org',
    'wss://ws3.blitzortung.org',
  ];

  let ws = null;
  let reconnectTimer = null;
  let wsServerIdx = 0;
  const wsStats = { msg: 0, parsed: 0 };

  function emit(type, data) {
    handlers[type].forEach((cb) => {
      try { cb(data); } catch (e) { /* renderer 側の例外は握りつぶす */ }
    });
  }

  /**
   * Blitzortung LZW デコード（main.js から移植）
   */
  function decodeBlitzortung(raw) {
    // まずそのまま JSON を試みる
    if (typeof raw === 'string' && raw[0] === '{') {
      try { return JSON.parse(raw); } catch (e) {}
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
    } catch (err) { return null; }
  }

  function connect() {
    const url = WS_SERVERS[wsServerIdx % WS_SERVERS.length];
    emit('status', 'connecting');

    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      emit('status', 'connected');
      ws.send(JSON.stringify({ a: 111 }));
      clearTimeout(reconnectTimer);
    };

    ws.onmessage = (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw) return;
        wsStats.msg++;
        const parsed = decodeBlitzortung(raw);
        if (parsed) {
          wsStats.parsed++;
          emit('strike', parsed);
        }
      } catch (e) {}
    };

    ws.onerror = () => { /* close で扱う */ };

    ws.onclose = () => {
      emit('status', 'error');
      wsServerIdx++;
      scheduleReconnect();
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 5000);
  }

  // ── WS 統計を定期送信（5 秒ごと） ──────────────────────────
  setInterval(() => { emit('stats', { ...wsStats }); }, 5000);

  // ── Nominatim 逆ジオコーディング ───────────────────────────
  // 利用規約：1 リクエスト/秒。キューで直列化して順守する。
  const geocodeQueue = [];
  let geocodeRunning = false;

  // キューの上限。1.1 秒に 1 件しか処理できないため、雷雨時に要求が届く速度が
  // 処理速度を上回るとキューが際限なく伸び、未解決の Promise とそれが掴む
  // 落雷オブジェクトがメモリに積み上がっていく（長時間の稼働で重くなる原因）。
  // 溢れた古い要求は待たせ続けず打ち切る。dropped 印を付けて返すので、
  // 呼び出し側はその結果をキャッシュせず、次の落雷で取得し直せる。
  const GEOCODE_QUEUE_MAX = 40;

  function processGeocodeQueue() {
    if (geocodeRunning || geocodeQueue.length === 0) return;
    geocodeRunning = true;
    const { lat, lon, resolve } = geocodeQueue.shift();

    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=ja&zoom=10`;
    fetch(url, { headers: { 'Accept': 'application/json' } })
      .then((res) => res.json())
      .then((json) => {
        const a = json.address || {};
        const place = a.city || a.town || a.village || a.municipality || a.county || a.state || '不明';
        resolve({ place, pref: a.state || '', country: a.country || '' });
      })
      .catch(() => {
        resolve({ place: '不明', pref: '', country: '' });
      })
      .finally(() => {
        // 1.1 秒あけて次のリクエスト
        setTimeout(() => { geocodeRunning = false; processGeocodeQueue(); }, 1100);
      });
  }

  // ── window.electronAPI 互換インターフェース ────────────────
  window.electronAPI = {
    onStrike:   (cb) => { handlers.strike.push(cb); },
    onWsStatus: (cb) => { handlers.status.push(cb); },
    onWsStats:  (cb) => { handlers.stats.push(cb); },
    reverseGeocode: (lat, lon) => new Promise((resolve) => {
      while (geocodeQueue.length >= GEOCODE_QUEUE_MAX) {
        const dropped = geocodeQueue.shift();
        dropped.resolve({ place: '不明', pref: '', country: '', dropped: true });
      }
      geocodeQueue.push({ lat, lon, resolve });
      processGeocodeQueue();
    }),
  };

  // ── 接続開始 ───────────────────────────────────────────────
  // renderer.js は DOMContentLoaded で onStrike 等を登録する。
  // ここでは登録完了後に接続したいので少し遅延させる。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(connect, 0));
  } else {
    setTimeout(connect, 0);
  }
})();
