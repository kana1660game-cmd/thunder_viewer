'use strict';

// ══════════════════════════════════════════════════════════════
//  設定・状態
// ══════════════════════════════════════════════════════════════
const DEFAULT_CONFIG = {
  name: '監視地点',
  lat: null,   // 監視地点は初回起動時にユーザーが設定する（デフォルト座標なし）
  lon: null,
  radius: 20,
  hours: 6,
  monitorRadius: 150,
  maxHistory: 500,
  fps: 10,
  showRing: true,
  showRipple: true,
  rippleFar: false,
  soundRingFar: false,
  showFarHistory: false,
  dotColor: 'blue',
  autoCamera: true,
  cameraLock: false,   // ON の間はカメラの自動移動を完全に停止（追従設定より優先）
  cameraFar: false,
  showRain: false,      // リアルタイム雨雲（気象庁ナウキャスト）を表示するか
  rainOpacity: 0.55,    // 雨雲レイヤーの不透明度（落雷が見えるよう半透明）
  historyDisplayCount: 50,
  mapDisplaySec: 0,
  mapDisplayCount: 500,
  sidePanelWidth: 320,   // 落雷履歴パネルの横幅(px)。リサイザーで調整・保存する
};

// 日本の緯度経度範囲（沖縄〜北海道、与那国〜択捉）
const JAPAN_BOUNDS = { latMin: 24, latMax: 46, lonMin: 122, lonMax: 154 };

// 選択可能な落雷点の色
const DOT_COLORS = { blue: '#4a9eff', yellow: '#f5c842' };

let cfg = Object.assign({}, DEFAULT_CONFIG, loadConfig());

// 監視地点が設定済みか（緯度経度が有効な数値か）
function hasLocation() {
  return typeof cfg.lat === 'number' && isFinite(cfg.lat)
      && typeof cfg.lon === 'number' && isFinite(cfg.lon);
}

// 自宅（監視地点）座標は専用キーにも保存してあるので、
// 設定が未保存・破損していてもここで復元する。
(function restoreHomeLocation() {
  if (hasLocation()) return;
  const home = loadHome();
  if (!home) return;
  cfg.lat = home.lat;
  cfg.lon = home.lon;
  if (home.name) cfg.name = home.name;
})();

let strikes = [];
let strikeIdSeq = 0;
let map, canvasRenderer, monitorMarker, soundRingLayer;
// ── 雨雲レイヤー（気象庁ナウキャスト） ──────────────────────────
let rainLayer = null;      // 現在表示中の雨雲タイルレイヤー
let rainTimer = null;      // 5分ごとの自動更新タイマー
let rainBasetime = null;   // 最後に読み込んだ basetime（無駄な張り替え防止）
let geocodeCache = loadGeocodeCache();
let mapFilterSec = 0;

// 受信済み落雷の time (ns) を60秒間保持して重複着信を除外する
// key(ns文字列) -> 失効時刻(ms)。定期スイープで掃除する（大量受信時に
// setTimeout が乱立してメモリ・GC負荷になるのを避けるためタイマーは持たない）。
const _seenStrikeTimes = new Map();

// ── キャンバスオーバーレイアニメーション ──────────────────────────
let animCanvas = null, animCtx = null, animRafId = null;
const activeAnimations = [];
const ANIM_BURST    = 180;   // ms: 爆発フラッシュ持続
const ANIM_RING     = 750;   // ms: 拡散リング持続
const ANIM_SCALE    = 260;   // ms: 本体ポップイン持続
const ANIM_LIFE     = 1400;  // ms: 総寿命
const TWO_PI = Math.PI * 2;

// 波紋canvasの描画を間引く上限FPS（高リフレッシュレート環境での負荷軽減）
const RIPPLE_MIN_INTERVAL = 1000 / 30;
let _lastRippleDrawTs = 0;

// カメラ制御
let lastAutoFlyMs = 0;
let urgentCameraActive = false;
let _urgentStrikeId = null;
const AUTO_FLY_COOLDOWN_MS = 3000;

// 手動でマップを操作した直後はこの時間だけ自動カメラ移動を抑止する
let lastUserInteractMs = 0;
const MANUAL_HOLD_MS = 5000;
function isManualHold() { return Date.now() - lastUserInteractMs < MANUAL_HOLD_MS; }

const SOUND_SPEED = 340;

// ── UI更新のフレーム集約 ─────────────────────────────────────
// 落雷を連続受信すると、統計チップ・音波パネルの再描画（DOM書き換え）が
// 1秒間に何百回も走ってラグの原因になる。requestAnimationFrame で1フレーム
// あたり最大1回にまとめる。1秒間隔の定期更新もあるので取りこぼしはない。
let _statChipsScheduled = false;
function scheduleStatChips() {
  if (_statChipsScheduled) return;
  _statChipsScheduled = true;
  requestAnimationFrame(() => { _statChipsScheduled = false; updateStatChips(); });
}
let _soundPanelScheduled = false;
function scheduleSoundPanel() {
  if (_soundPanelScheduled) return;
  _soundPanelScheduled = true;
  requestAnimationFrame(() => { _soundPanelScheduled = false; updateSoundPanel(); });
}

// 距離 distKm における雷の推定音量 (dB SPL) を返す。
// モデル: 雷の音源は1km地点で約120dB SPL を基準とし、
//   - 距離の逆二乗則による減衰: -20*log10(d/1)
//   - 大気吸収（1kHz帯域で約0.003dB/m = 3dB/km の追加減衰）
// を合算する。結果が0以下（ほぼ聞こえない）なら0を返す。
// 基準: 120dB = ジェットエンジン直近。会話は60dB、ヒソヒソ声30dB。
function calcThunderDb(distKm) {
  if (!distKm || distKm <= 0) return 0;
  const REF_DB     = 120;                          // 1km基準音量 (dB)
  const ATM_DB_KM  = 3;                            // 大気吸収 (dB/km)
  const invSqLoss  = 20 * Math.log10(distKm);     // 逆二乗減衰
  const atmLoss    = ATM_DB_KM * (distKm - 1);    // 大気吸収（1kmからの追加分）
  return Math.max(0, REF_DB - invSqLoss - atmLoss);
}

// dB値をわかりやすい言葉に変換する（大まかな目安）
function dbToLabel(db) {
  if (db >= 100) return '非常に大きい（ジェット機 直近レベル）';
  if (db >= 90)  return '非常に大きい（工事現場 間近）';
  if (db >= 80)  return '大きい（地下鉄車内 レベル）';
  if (db >= 70)  return '大きい（掃除機 間近）';
  if (db >= 60)  return 'やや大きい（会話レベル）';
  if (db >= 50)  return '普通（静かな事務所）';
  if (db >= 40)  return '小さい（図書館レベル）';
  if (db >= 30)  return '小さい（ヒソヒソ声レベル）';
  if (db >= 20)  return 'かすかに聞こえる';
  if (db > 0)    return 'ほぼ聞こえない';
  return '聞こえない';
}
const STRIKES_STORAGE_KEY = 'lm_strikes_v2';

// ══════════════════════════════════════════════════════════════
//  永続化
// ══════════════════════════════════════════════════════════════
const HOME_STORAGE_KEY = 'lm_home';

function saveConfig() {
  try { localStorage.setItem('lm_config', JSON.stringify(cfg)); } catch {}
  saveHome();
}
function loadConfig() {
  try { return JSON.parse(localStorage.getItem('lm_config') || '{}'); }
  catch { return {}; }
}

// 自宅（監視地点）の座標だけを独立したキーに保存する。
// 設定全体が消えたり読めなくなっても、座標だけは次回起動時に復元できる。
function saveHome() {
  if (!hasLocation()) return;
  try {
    localStorage.setItem(HOME_STORAGE_KEY,
      JSON.stringify({ name: cfg.name, lat: cfg.lat, lon: cfg.lon }));
  } catch {}
}
function loadHome() {
  try {
    const h = JSON.parse(localStorage.getItem(HOME_STORAGE_KEY) || 'null');
    if (h && isFinite(h.lat) && isFinite(h.lon)) {
      return { name: h.name, lat: Number(h.lat), lon: Number(h.lon) };
    }
  } catch {}
  return null;
}

function saveGeocodeCache() {
  try {
    const entries = Object.entries(geocodeCache);
    localStorage.setItem('lm_geocache', JSON.stringify(Object.fromEntries(entries.slice(-300))));
  } catch {}
}
function loadGeocodeCache() {
  try { return JSON.parse(localStorage.getItem('lm_geocache') || '{}'); }
  catch { return {}; }
}

let _savePending = null;
function scheduleSaveStrikes() {
  clearTimeout(_savePending);
  _savePending = setTimeout(() => {
    try {
      const limit = Math.max(cfg.maxHistory, 500);
      const data = strikes.slice(0, limit).map(s => ({
        id: s.id, lat: s.lat, lon: s.lon, timeMs: s.timeMs,
        dist: s.dist, isWarn: s.isWarn, isFar: s.isFar,
        place: s.place, pref: s.pref,
      }));
      localStorage.setItem(STRIKES_STORAGE_KEY, JSON.stringify(data));
    } catch {}
  }, 1500);
}

function loadStoredStrikes() {
  try {
    const raw = localStorage.getItem(STRIKES_STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

// ══════════════════════════════════════════════════════════════
//  ユーティリティ
// ══════════════════════════════════════════════════════════════
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 2地点間の方位角（真北=0°、時計回り、0〜360°）を返す。
// ARで「その落雷がどの方角にあるか」を求めるのに使う。
function bearingTo(lat1, lon1, lat2, lon2) {
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// 2つの方位の符号付き差（-180〜+180°）。正=時計回りに右側。
function angleDelta(target, ref) {
  return ((target - ref + 540) % 360) - 180;
}

function soundTravelSec(distKm) { return (distKm * 1000) / SOUND_SPEED; }

function fmtSec(sec) {
  if (sec <= 0) return '到達済み';
  if (sec < 60) return `${Math.round(sec)}秒`;
  return `${Math.floor(sec/60)}分${Math.round(sec%60)}秒`;
}
function fmtTime(date) {
  return date.toLocaleTimeString('ja-JP', { hour12: false });
}
function fmtDateTime(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${m}/${d} ${date.toLocaleTimeString('ja-JP', { hour12: false })}`;
}

function geoKey(lat, lon) { return `${lat.toFixed(2)},${lon.toFixed(2)}`; }

function isVisible(strike) {
  if (mapFilterSec === 0) return true;
  return (Date.now() - strike.timeMs) <= mapFilterSec * 1000;
}

// 付近の落雷（監視圏内）かつ音到達から15秒以内はマップ・履歴から除外しない
function isProtectedNearby(s) {
  if (s.isFar) return false;
  return Date.now() < s.timeMs + s.soundSec * 1000 + 15000;
}

// Blitzortung の time フィールド（ナノ秒）で重複受信を除外する
function isDuplicateStrike(timeNs) {
  if (!timeNs) return false;
  const key = String(timeNs);
  if (_seenStrikeTimes.has(key)) return true;
  _seenStrikeTimes.set(key, Date.now() + 60000);
  return false;
}

// 期限切れの重複除外キーを定期的にまとめて掃除する
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of _seenStrikeTimes) {
    if (exp <= now) _seenStrikeTimes.delete(k);
  }
}, 15000);

// 設定した dot カラーを返す（警告・通常で使い分け）
function getChosenColor() {
  return DOT_COLORS[cfg.dotColor] || '#4a9eff';
}

// ══════════════════════════════════════════════════════════════
//  WebSocket ステータス・統計
// ══════════════════════════════════════════════════════════════
function setBadge(state) {
  const el = document.getElementById('connBadge');
  el.className = 'conn-badge';
  if (state === 'connected') {
    el.className += ' connected';
    el.textContent = '● 受信中';
  } else if (state === 'error') {
    el.className += ' error';
    el.textContent = '● 再接続中...';
  } else {
    el.textContent = '● 接続中...';
  }
}

function onWsStats({ msg, parsed }) {
  const el = document.getElementById('statApi');
  if (el) el.innerHTML = `受信 <b>${msg}</b> / 解析 <b>${parsed}</b>`;
}

// ══════════════════════════════════════════════════════════════
//  落雷データ処理（ライブ）
// ══════════════════════════════════════════════════════════════
function onStrikeData(data) {
  const list = Array.isArray(data.strikes) ? data.strikes
             : (data.lat !== undefined ? [data] : []);

  for (const s of list) {
    let lat = typeof s.lat === 'number' ? s.lat : parseFloat(s.lat);
    let lon = typeof s.lon === 'number' ? s.lon : parseFloat(s.lon);
    if (Math.abs(lat) > 90) { lat /= 1e6; lon /= 1e6; }
    if (!isFinite(lat) || !isFinite(lon)) continue;

    // 日本国内のみ
    if (lat < JAPAN_BOUNDS.latMin || lat > JAPAN_BOUNDS.latMax ||
        lon < JAPAN_BOUNDS.lonMin || lon > JAPAN_BOUNDS.lonMax) continue;

    if (isDuplicateStrike(s.time)) continue;
    const timeMs = s.time ? Math.round(Number(s.time) / 1e6) : Date.now();
    // 監視地点が未設定なら距離を無限大として全て圏外（isFar）扱いにする
    const dist = hasLocation() ? haversine(cfg.lat, cfg.lon, lat, lon) : Infinity;
    addLiveStrike({ lat, lon, timeMs, dist });
  }
}

async function addLiveStrike({ lat, lon, timeMs, dist }) {
  strikeIdSeq++;
  const id = strikeIdSeq;
  const soundSec = soundTravelSec(dist);
  const isWarn = dist <= cfg.radius;
  const isFar = dist > cfg.monitorRadius;

  const strike = {
    id, lat, lon, timeMs, dist, soundSec,
    strikeTime: new Date(timeMs),
    arrivalTime: new Date(timeMs + soundSec * 1000),
    isWarn, isFar,
    place: isFar ? '' : '取得中...',
    pref: '',
    mapLayer: null, ringLayer: null,
    isHistorical: false,
  };

  pushStrike(strike);
  renderStrikeOnMap(strike, false);
  renderHistoryDebounced();
  scheduleSoundPanel();
  scheduleStatChips();
  scheduleSaveStrikes();

  // カメラ追従（圏外は cameraFar が ON の場合のみ）
  if (!isFar || cfg.cameraFar) {
    tryAutoCamera(strike);
  }

  // 地名取得は監視圏内のみ
  if (!isFar) {
    const key = geoKey(lat, lon);
    if (geocodeCache[key]) {
      strike.place = geocodeCache[key].place;
      strike.pref  = geocodeCache[key].pref;
    } else {
      const result = await window.electronAPI.reverseGeocode(lat, lon);
      geocodeCache[key] = result;
      saveGeocodeCache();
      strike.place = result.place;
      strike.pref  = result.pref;
      if (strike.mapLayer) strike.mapLayer.setPopupContent(buildPopupHTML(strike));
      scheduleSaveStrikes();
    }
    renderHistoryDebounced();
    scheduleSoundPanel();
  }
}

function pushStrike(strike) {
  strikes.unshift(strike);
  while (strikes.length > cfg.maxHistory) {
    const old = strikes.pop();
    removeStrikeFromMap(old);
  }
}

// ── 起動時の履歴復元 ──────────────────────────────────────────
function restoreStoredStrikes() {
  const stored = loadStoredStrikes();
  if (stored.length === 0) return;

  const maxId = Math.max(...stored.map(s => s.id || 0), 0);
  strikeIdSeq = maxId;

  const sorted = [...stored].sort((a, b) => a.timeMs - b.timeMs);
  for (const s of sorted) {
    if (!s.lat || !s.lon || !s.timeMs) continue;
    const soundSec = soundTravelSec(s.dist || 0);
    const strike = {
      id: s.id || (++strikeIdSeq),
      lat: s.lat, lon: s.lon, timeMs: s.timeMs,
      dist: s.dist || 0, soundSec,
      strikeTime: new Date(s.timeMs),
      arrivalTime: new Date(s.timeMs + soundSec * 1000),
      isWarn: !!s.isWarn,
      isFar: !!s.isFar,
      place: s.place || (s.isFar ? '' : '不明'),
      pref: s.pref || '',
      mapLayer: null, ringLayer: null,
      isHistorical: true,
    };
    strikes.unshift(strike);
    while (strikes.length > cfg.maxHistory) strikes.pop();
  }

  for (const strike of strikes) {
    renderStrikeOnMap(strike, true);
  }

  renderHistory();
  updateStatChips();
}

// ══════════════════════════════════════════════════════════════
//  カメラ制御
// ══════════════════════════════════════════════════════════════

// カメラを向ける（クールダウン付き）
function tryAutoCamera(strike) {
  if (cfg.cameraLock) return;   // カメラ固定レバーON：自動移動しない
  if (!cfg.autoCamera) return;
  if (isManualHold()) return;   // 手動操作直後はカメラを動かさない
  if (urgentCameraActive) return;
  const now = Date.now();
  if (now - lastAutoFlyMs < AUTO_FLY_COOLDOWN_MS) return;

  // 圏外落雷のカメラ移動：音到達前後15秒以内の圏内落雷があればそちらを優先
  if (strike.isFar) {
    const activeNear = strikes.find(s => !s.isHistorical && isProtectedNearby(s));
    if (activeNear) {
      lastAutoFlyMs = now;
      map.flyTo([activeNear.lat, activeNear.lon], 10, { duration: 0.9, easeLinearity: 0.5 });
      return;
    }
  }

  lastAutoFlyMs = now;
  map.flyTo([strike.lat, strike.lon], 10, { duration: 0.9, easeLinearity: 0.5 });
}

// 音到達10秒以内の落雷があれば、落雷と監視地点を両方映す
function checkUrgentCamera() {
  if (cfg.cameraLock || !cfg.autoCamera || !map) return;   // 固定レバーON：自動移動しない
  if (isManualHold()) return;   // 手動操作直後はカメラを動かさない
  const now = Date.now();
  const urgent = strikes.filter(s => {
    if (s.isHistorical || s.isFar) return false;
    const remSec = (s.timeMs + s.soundSec * 1000 - now) / 1000;
    return remSec > 0 && remSec <= 10;
  });

  if (urgent.length > 0) {
    // 最も到達が近いものを選択
    const s = urgent.reduce((a, b) =>
      (a.timeMs + a.soundSec * 1000) < (b.timeMs + b.soundSec * 1000) ? a : b
    );
    if (s.id !== _urgentStrikeId) {
      _urgentStrikeId = s.id;
      urgentCameraActive = true;
      const bounds = L.latLngBounds(
        [s.lat, s.lon],
        [cfg.lat, cfg.lon]
      ).pad(0.5);
      map.fitBounds(bounds, { animate: true, duration: 0.7, maxZoom: 13 });
    }
  } else {
    if (urgentCameraActive) {
      urgentCameraActive = false;
      _urgentStrikeId = null;
    }
  }
}

// カメラ追従ボタンの表示更新
function updateCameraBtn() {
  const btn = document.getElementById('btnCamera');
  if (!btn) return;
  btn.classList.toggle('active', !!cfg.autoCamera);
  btn.title = cfg.autoCamera ? 'カメラ追従 ON' : 'カメラ追従 OFF';
}

// カメラ固定レバーの表示更新
function updateCameraLockLever() {
  const lever = document.getElementById('leverCameraLock');
  if (!lever) return;
  lever.classList.toggle('locked', !!cfg.cameraLock);
  lever.setAttribute('aria-checked', cfg.cameraLock ? 'true' : 'false');
  lever.title = cfg.cameraLock
    ? 'カメラ固定：ON（カメラは自動移動しません）'
    : 'カメラ固定：OFF（タップで固定）';
}

// ══════════════════════════════════════════════════════════════
//  リアルタイム雨雲（気象庁 高解像度降水ナウキャスト）
// ──────────────────────────────────────────────────────────────
//  ・時刻一覧(JSON)から最新の実況コマを選び、PNGタイルを重ねる。
//  ・5分ごとに更新。降水のない領域は透過PNGなので地図が透けて見える。
//  ・専用ペイン(zIndex 250)に敷くため、落雷点・演出より必ず下に描画される。
// ══════════════════════════════════════════════════════════════
const RAIN_TIMES_URL = 'https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json';

// 現在時刻を気象庁タイルのキー形式(UTC, YYYYMMDDHHMMSS)で返す
function utcTileKeyNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate())
       + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds());
}

// 雨雲レバーの見た目を更新
function updateRainLever() {
  const lever = document.getElementById('leverRain');
  if (!lever) return;
  lever.classList.toggle('rain-on', !!cfg.showRain);
  lever.setAttribute('aria-checked', cfg.showRain ? 'true' : 'false');
  lever.title = cfg.showRain
    ? '雨雲：ON（気象庁ナウキャストを表示中・5分毎更新）'
    : '雨雲：OFF（タップで表示）';
}

// 最新の雨雲タイルを取得してレイヤーを張り替える
async function refreshRainLayer() {
  if (!cfg.showRain || !map) return;
  let times;
  try {
    const res = await fetch(RAIN_TIMES_URL, { cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (!res.ok) return;
    times = await res.json();
  } catch { return; }               // 取得失敗時は既存レイヤーを維持
  if (!Array.isArray(times) || times.length === 0) return;

  // basetime 昇順に整列し、未来コマを除いた最新の実況コマを採用する
  const sorted = times.slice().sort((a, b) => a.basetime < b.basetime ? -1 : 1);
  const nowKey = utcTileKeyNow();
  const latest = sorted.filter(t => t.validtime <= nowKey).pop() || sorted[sorted.length - 1];
  if (!latest || latest.basetime === rainBasetime) return;  // 変化なしなら張り替えない
  rainBasetime = latest.basetime;

  const url = `https://www.jma.go.jp/bosai/jmatile/data/nowc/${latest.basetime}/none/${latest.validtime}/surf/hrpns/{z}/{x}/{y}.png`;
  const next = L.tileLayer(url, {
    // OSM と同じ tilePane に載せ、zIndex で OSM(既定) より上・落雷より下にする。
    zIndex: 5,
    opacity: 1,                // 透過はレイヤーのコンテナ CSS opacity で表現（タイル個別のフェード競合を避ける）
    tileSize: 256,
    maxZoom: 18,
    keepBuffer: 4,             // 安定動作している OSM と同じ設定に揃える
    attribution: '雨雲: 気象庁ナウキャスト',
  });
  next.addTo(map);
  // 半透明はレイヤー全体（コンテナ要素）にかける。タイル個別の opacity(<1) は
  // Leaflet のフェード処理と競合してタイルが消える原因になるため使わない。
  const el = next.getContainer();
  if (el) {
    el.style.opacity = String(cfg.rainOpacity);
    el.style.pointerEvents = 'none';  // クリックは地図側へ透過
  }

  // 旧レイヤーは「新レイヤーの表示タイルが出揃ってから」除去する。
  // 固定ディレイだと配信が遅いとき切替時に一瞬空白になるため load を待つ。
  const prev = rainLayer;
  rainLayer = next;
  if (prev) {
    let removed = false;
    const dropPrev = () => {
      if (removed) return;
      removed = true;
      if (map.hasLayer(prev)) map.removeLayer(prev);
    };
    next.once('load', dropPrev);
    setTimeout(dropPrev, 8000);  // load が発火しない場合のフォールバック
  }
}

// 設定に応じて雨雲レイヤーと自動更新の ON/OFF を反映する
function updateRainLayer() {
  if (cfg.showRain) {
    refreshRainLayer();
    if (!rainTimer) rainTimer = setInterval(refreshRainLayer, 5 * 60 * 1000);
  } else {
    if (rainTimer) { clearInterval(rainTimer); rainTimer = null; }
    if (rainLayer && map.hasLayer(rainLayer)) map.removeLayer(rainLayer);
    rainLayer = null;
    rainBasetime = null;
  }
  updateRainLever();
}

// ══════════════════════════════════════════════════════════════
//  地図
// ══════════════════════════════════════════════════════════════
function initMap() {
  canvasRenderer = L.canvas({ padding: 0.5 });
  // 監視地点が未設定なら日本全体を俯瞰表示
  map = L.map('map', {
    center: hasLocation() ? [cfg.lat, cfg.lon] : [36.5, 138.0],
    zoom: hasLocation() ? 8 : 5,
    preferCanvas: true,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
    keepBuffer: 4,
  }).addTo(map);
  // 雨雲は OSM と同じ tilePane に載せる（refreshRainLayer で zIndex を OSM より上に設定）。
  // 専用ペインに載せるとズームアニメーション時にタイルが消える不具合があるため、
  // 落雷(overlayPane z400 / canvas z450)より下・OSM の上、という重なりは
  // tilePane 内の zIndex で担保する。
  placeMonitorMarker();
  drawSoundRing();
  map.on('zoomend', placeMonitorMarker);
  setupManualInteractionTracking();
  initAnimCanvas();
}

// ユーザーがマップを直接操作したことを検知して時刻を記録する。
// これらの入力イベントはプログラムによる flyTo/fitBounds では発火しないため、
// 自動カメラ移動と確実に区別できる。
function setupManualInteractionTracking() {
  const container = map.getContainer();
  const mark = () => { lastUserInteractMs = Date.now(); };
  container.addEventListener('mousedown', mark);              // ドラッグ開始・ズームボタン
  container.addEventListener('wheel', mark, { passive: true }); // ホイールズーム
  container.addEventListener('touchstart', mark, { passive: true }); // タッチ操作
  container.addEventListener('keydown', mark);               // 矢印キーでのパン
}

function placeMonitorMarker() {
  if (monitorMarker) { map.removeLayer(monitorMarker); monitorMarker = null; }
  if (!hasLocation()) return;   // 監視地点未設定ならマーカーを置かない
  const zoom = map ? map.getZoom() : 8;
  const size = Math.max(8, Math.min(24, Math.round(zoom * 2)));
  const half = Math.round(size / 2);
  const icon = L.divIcon({
    className: 'monitor-marker',
    html: `<div class="monitor-pulse" style="width:${size}px;height:${size}px"></div>`,
    iconSize: [size, size], iconAnchor: [half, half],
  });
  monitorMarker = L.marker([cfg.lat, cfg.lon], { icon, zIndexOffset: 1000 })
    .addTo(map);
  // 自宅（監視地点）に小さな吹き出しを常時表示する
  const label = cfg.name && cfg.name !== '監視地点'
    ? `現在地（${cfg.name}）` : '現在地';
  monitorMarker.bindTooltip(label, {
    permanent: true,
    direction: 'top',
    offset: [0, -half - 2],
    className: 'home-tooltip',
  });
}

function drawSoundRing() {
  if (soundRingLayer) { map.removeLayer(soundRingLayer); soundRingLayer = null; }
  if (!cfg.showRing || !hasLocation()) return;
  soundRingLayer = L.circle([cfg.lat, cfg.lon], {
    radius: cfg.radius * 1000,
    color: '#ff6b35', weight: 1.5, opacity: 0.6,
    fillColor: '#ff6b35', fillOpacity: 0.04, dashArray: '6,4',
  }).addTo(map);
}

function removeStrikeFromMap(strike) {
  if (strike.mapLayer) {
    if (map && map.hasLayer(strike.mapLayer)) map.removeLayer(strike.mapLayer);
    strike.mapLayer = null;
  }
  if (strike.ringLayer) {
    if (map && map.hasLayer(strike.ringLayer)) map.removeLayer(strike.ringLayer);
    strike.ringLayer = null;
  }
}

function renderStrikeOnMap(strike, isHistory) {
  const now = Date.now();
  const soundArrived = (now - strike.timeMs) >= strike.soundSec * 1000;
  const show = isVisible(strike);
  const isFar = !!strike.isFar;
  const chosen = getChosenColor();

  let dotColor, dotOpacity, dotRadius, interactive;

  if (isFar) {
    dotColor   = chosen;
    dotOpacity = 0.55;
    dotRadius  = 4;
    interactive = true;
  } else if (isHistory) {
    dotColor   = chosen;
    dotOpacity = 0.45;
    dotRadius  = 4;
    interactive = true;
  } else if (!soundArrived && strike.isWarn) {
    dotColor   = '#ff6b35';
    dotOpacity = 0.9;
    dotRadius  = 6;
    interactive = true;
  } else {
    dotColor   = chosen;
    dotOpacity = 0.9;
    dotRadius  = 5;
    interactive = true;
  }

  const dot = L.circleMarker([strike.lat, strike.lon], {
    radius: dotRadius,
    renderer: canvasRenderer,
    color: dotColor,
    weight: isFar ? 1 : 1.5,
    opacity: dotOpacity,
    fillColor: dotColor,
    fillOpacity: dotOpacity * 0.7,
    interactive,
  });

  // ポップアップHTMLは開かれた時に初めて生成する（遅延バインド）。
  // 大量の落雷点で毎回HTML文字列を作るコストを省く（クリックされなければ生成しない）。
  dot.bindPopup(() => buildPopupHTML(strike));

  strike.mapLayer = dot;
  if (show) dot.addTo(map);

  // 発生アニメーション（canvas波紋）：圏外は rippleFar が ON の場合のみ
  if (!isHistory && (!isFar || cfg.rippleFar)) {
    showRipple(strike.lat, strike.lon, strike.isWarn);
  }

  // 音の伝播円：圏外は soundRingFar が ON の場合のみ
  if (!isHistory && (!isFar || cfg.soundRingFar) && !soundArrived) {
    const ring = L.circle([strike.lat, strike.lon], {
      radius: 1000,
      color: strike.isWarn ? '#ff6b35' : chosen,
      weight: 1.2, opacity: 0.55,
      fill: false, dashArray: '5,4',
    });
    if (show) ring.addTo(map);
    strike.ringLayer = ring;
    scheduleRingAnimation(strike);
  }
}

function buildPopupHTML(s) {
  const now = Date.now();
  const arrivalMs = s.timeMs + s.soundSec * 1000;
  const arrived = now >= arrivalMs;
  const remainSec = Math.max(0, (arrivalMs - now) / 1000);
  const histTag = s.isHistorical ? ' <span style="color:#6b7fa8;font-size:10px">[履歴]</span>' : '';
  const farTag = s.isFar ? ' <span style="color:#6b7fa8;font-size:10px">[圏外]</span>' : '';
  const placeText = s.place ? ` ${s.place}${s.pref ? ' (' + s.pref + ')' : ''}` : '';
  return `
    <div class="popup-title">⚡ #${s.id}${histTag}${farTag}${placeText}</div>
    <div class="popup-row">📍 <b>${s.lat.toFixed(4)}°N, ${s.lon.toFixed(4)}°E</b></div>
    <div class="popup-row">🕐 発生: <b>${fmtDateTime(s.strikeTime)}</b></div>
    <div class="popup-row">📏 距離: <b>${s.dist.toFixed(1)} km</b></div>
    <div class="popup-row">🔊 音到達: <b>${arrived ? '到達済み' : fmtTime(s.arrivalTime) + '（あと' + fmtSec(remainSec) + '）'}</b></div>
    ${s.isWarn ? (() => {
      const db = calcThunderDb(s.dist);
      return `<div class="popup-row">📢 推定音量: <b>${db.toFixed(0)} dB</b> <span class="popup-vol-label">${dbToLabel(db)}</span></div>`;
    })() : ''}
  `;
}

// ══════════════════════════════════════════════════════════════
//  波紋演出（キャンバスオーバーレイ）
// ══════════════════════════════════════════════════════════════
let animCssW = 0, animCssH = 0;   // CSS ピクセルでの描画領域サイズ

function initAnimCanvas() {
  const wrap = document.querySelector('.map-wrap');
  animCanvas = document.createElement('canvas');
  animCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:450';
  wrap.appendChild(animCanvas);
  animCtx = animCanvas.getContext('2d', { alpha: true });
  resizeAnimCanvas();
  window.addEventListener('resize', resizeAnimCanvas);
  window.addEventListener('orientationchange', resizeAnimCanvas);
  map.on('resize', resizeAnimCanvas);
  // iOS では初期レイアウト確定が遅れてサイズ0のままになることがあるため、
  // ResizeObserver で確実に追従させる。
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(resizeAnimCanvas).observe(wrap);
  }
}

// Retina（高DPR）対応でキャンバスをくっきり描画し、
// 実サイズが0のまま（iOSの初期化タイミング等）にならないようにする。
function resizeAnimCanvas() {
  if (!animCanvas) return;
  const rect = animCanvas.getBoundingClientRect();
  const cssW = rect.width  || animCanvas.offsetWidth;
  const cssH = rect.height || animCanvas.offsetHeight;
  if (!cssW || !cssH) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  animCssW = cssW;
  animCssH = cssH;
  animCanvas.width  = Math.round(cssW * dpr);
  animCanvas.height = Math.round(cssH * dpr);
  // 以降は CSS ピクセル座標で描画できるよう変換を設定
  animCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// 同時に走らせる波紋アニメーションの上限。豪雨時に大量発生しても
// canvas 描画コストが青天井にならないよう、古いものから間引く。
const MAX_ACTIVE_RIPPLES = 90;

function showRipple(lat, lon, isWarn) {
  if (!cfg.showRipple) return;
  if (activeAnimations.length >= MAX_ACTIVE_RIPPLES) activeAnimations.shift();
  activeAnimations.push({
    lat, lon,
    color: isWarn ? '#ff6b35' : getChosenColor(),
    isWarn,
    born: performance.now(),
  });
  if (!animRafId) animRafId = requestAnimationFrame(renderAnimCanvas);
}

function renderAnimCanvas(now) {
  // 30fps に間引く（演出は十分滑らかなまま描画コストを抑える）
  if (now - _lastRippleDrawTs < RIPPLE_MIN_INTERVAL && activeAnimations.length > 0) {
    animRafId = requestAnimationFrame(renderAnimCanvas);
    return;
  }
  _lastRippleDrawTs = now;

  // 寿命切れを swap-delete で除去
  let i = 0;
  while (i < activeAnimations.length) {
    if (now - activeAnimations[i].born >= ANIM_LIFE) {
      activeAnimations[i] = activeAnimations[activeAnimations.length - 1];
      activeAnimations.pop();
    } else i++;
  }

  // 実サイズが未確定（iOS初期化タイミング等）なら描画前に確定させる
  if (!animCssW || !animCssH) resizeAnimCanvas();
  const W = animCssW, H = animCssH;
  animCtx.clearRect(0, 0, W, H);

  if (activeAnimations.length === 0) {
    animRafId = null;
    return;
  }

  const zoom = map.getZoom();
  const baseR = Math.max(14, Math.min(32, 10 + zoom * 2));

  for (const c of activeAnimations) {
    const age = now - c.born;
    const remaining = ANIM_LIFE - age;
    const alpha = remaining < 280 ? remaining / 280 : 1;
    const p = map.latLngToContainerPoint(L.latLng(c.lat, c.lon));
    const cx = p.x, cy = p.y;

    // Phase 1: 爆発フラッシュ（塗りつぶし円が急膨張→消滅）
    if (age < ANIM_BURST) {
      const bt = age / ANIM_BURST;
      animCtx.globalAlpha = (1 - bt) * 0.5 * alpha;
      animCtx.fillStyle = c.color;
      animCtx.beginPath();
      animCtx.arc(cx, cy, baseR * (1 + bt * 2.4), 0, TWO_PI);
      animCtx.fill();
    }

    // Phase 2a: 主拡散リング
    if (age < ANIM_RING) {
      const rt = age / ANIM_RING;
      animCtx.globalAlpha = (1 - rt) * 0.88 * alpha;
      animCtx.strokeStyle = c.color;
      animCtx.lineWidth = Math.max(2, baseR * 0.15);
      animCtx.beginPath();
      animCtx.arc(cx, cy, baseR * (1 + rt * 4.2), 0, TWO_PI);
      animCtx.stroke();
    }

    // Phase 2b: 第2リング（130ms 遅延・細め）
    if (age >= 130 && (age - 130) < ANIM_RING) {
      const rt = (age - 130) / ANIM_RING;
      animCtx.globalAlpha = (1 - rt) * 0.52 * alpha;
      animCtx.strokeStyle = c.color;
      animCtx.lineWidth = Math.max(1.5, baseR * 0.09);
      animCtx.beginPath();
      animCtx.arc(cx, cy, baseR * (1 + rt * 4.2), 0, TWO_PI);
      animCtx.stroke();
    }

    // Phase 2c: 警告時のみ白いシェア輪（視認性アップ）
    if (c.isWarn && age < ANIM_RING * 0.6) {
      const rt = age / (ANIM_RING * 0.6);
      animCtx.globalAlpha = (1 - rt) * 0.35 * alpha;
      animCtx.strokeStyle = '#ffffff';
      animCtx.lineWidth = Math.max(1, baseR * 0.07);
      animCtx.beginPath();
      animCtx.arc(cx, cy, baseR * (1 + rt * 2.0), 0, TWO_PI);
      animCtx.stroke();
    }

    // Phase 3: 本体ドット（弾性ポップイン）
    let scale = 1;
    if (age < ANIM_SCALE) {
      const t = age / ANIM_SCALE;
      scale = t === 0 ? 0 : Math.pow(2, -8 * t) * Math.sin((t * 10 - 0.75) * (TWO_PI / 3)) + 1;
      if (scale < 0) scale = 0;
    }
    const r = Math.max(2, baseR * 0.48 * scale);
    animCtx.globalAlpha = alpha * 0.95;
    animCtx.fillStyle = c.color;
    animCtx.beginPath();
    animCtx.arc(cx, cy, r, 0, TWO_PI);
    animCtx.fill();
  }

  animCtx.globalAlpha = 1;
  animRafId = requestAnimationFrame(renderAnimCanvas);
}

// ══════════════════════════════════════════════════════════════
//  アニメーション（単一 RAF ループ、FPS設定対応）
// ══════════════════════════════════════════════════════════════
const activeRings = new Map();
let rafId = null;
let lastTickTs = 0;

function scheduleRingAnimation(strike) {
  activeRings.set(strike.id, strike);
  if (!rafId) rafId = requestAnimationFrame(animationTick);
}

function animationTick(timestamp) {
  const interval = 1000 / Math.max(1, cfg.fps || 10);
  if (timestamp - lastTickTs >= interval) {
    lastTickTs = timestamp;
    const now = Date.now();
    const chosen = getChosenColor();

    for (const [id, strike] of activeRings) {
      if (!strike.ringLayer) { activeRings.delete(id); continue; }

      const elapsed = now - strike.timeMs;
      const durationMs = strike.soundSec * 1000;

      if (elapsed >= durationMs) {
        if (map.hasLayer(strike.ringLayer)) map.removeLayer(strike.ringLayer);
        strike.ringLayer = null;
        if (strike.mapLayer) {
          strike.mapLayer.setStyle({
            color: chosen, fillColor: chosen, opacity: 0.6, fillOpacity: 0.4,
          });
          strike.mapLayer.setPopupContent(buildPopupHTML(strike));
        }
        activeRings.delete(id);
        renderHistoryDebounced();
        scheduleSoundPanel();
        scheduleFadeOut(strike, 3 * 60 * 1000);
      } else {
        const ratio = elapsed / durationMs;
        const r = Math.max(1000, strike.dist * 1000 * ratio);
        if (map.hasLayer(strike.ringLayer)) strike.ringLayer.setRadius(r);
      }
    }
  }

  rafId = activeRings.size > 0 ? requestAnimationFrame(animationTick) : null;
}

function scheduleFadeOut(strike, delay) {
  setTimeout(() => {
    if (!strike.mapLayer) return;
    let op = 0.4;
    let lastFadeTs = 0;
    const fadeStep = (ts) => {
      if (!strike.mapLayer) return;
      if (ts - lastFadeTs >= 120) {
        lastFadeTs = ts;
        op -= 0.025;
        if (op <= 0) {
          if (map.hasLayer(strike.mapLayer)) map.removeLayer(strike.mapLayer);
          strike.mapLayer = null;
          return;
        }
        strike.mapLayer.setStyle({ opacity: op, fillOpacity: op * 0.65 });
      }
      requestAnimationFrame(fadeStep);
    };
    requestAnimationFrame(fadeStep);
  }, delay);
}

// ══════════════════════════════════════════════════════════════
//  マップ表示制限（件数・秒数）
// ══════════════════════════════════════════════════════════════
function enforceMapDisplayRules() {
  if (!map) return;
  const now = Date.now();

  // 時間制限: mapDisplaySec 秒より古いマーカーを非表示（付近の保護対象は除外）
  if (cfg.mapDisplaySec > 0) {
    const cutoff = now - cfg.mapDisplaySec * 1000;
    for (const s of strikes) {
      if (s.mapLayer && map.hasLayer(s.mapLayer) && s.timeMs < cutoff) {
        if (!isProtectedNearby(s)) map.removeLayer(s.mapLayer);
      }
    }
  }

  // 件数制限: 古いものから非表示（付近の保護対象は除外）
  const limit = Math.max(10, cfg.mapDisplayCount || 500);
  const visible = strikes.filter(s => s.mapLayer && map.hasLayer(s.mapLayer));
  if (visible.length > limit) {
    // visible は新着順なので末尾が古い
    for (let i = limit; i < visible.length; i++) {
      if (!isProtectedNearby(visible[i])) map.removeLayer(visible[i].mapLayer);
    }
  }
}

// ══════════════════════════════════════════════════════════════
//  マップフィルター
// ══════════════════════════════════════════════════════════════
function setMapFilter(sec) {
  mapFilterSec = sec;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.filter) === sec);
  });
  applyMapFilter();
}

function applyMapFilter() {
  if (!map) return;
  const now = Date.now();
  for (const s of strikes) {
    const withinFilter = mapFilterSec === 0 || (now - s.timeMs) <= mapFilterSec * 1000;
    const show = withinFilter || isProtectedNearby(s);
    if (s.mapLayer) {
      if (show && !map.hasLayer(s.mapLayer)) s.mapLayer.addTo(map);
      else if (!show && map.hasLayer(s.mapLayer)) map.removeLayer(s.mapLayer);
    }
    if (s.ringLayer) {
      if (show && !map.hasLayer(s.ringLayer)) s.ringLayer.addTo(map);
      else if (!show && map.hasLayer(s.ringLayer)) map.removeLayer(s.ringLayer);
    }
  }
}

setInterval(() => {
  if (mapFilterSec > 0) applyMapFilter();
  enforceMapDisplayRules();
}, 10000);

// ══════════════════════════════════════════════════════════════
//  履歴 UI
// ══════════════════════════════════════════════════════════════
let _knownIds = new Set();
let _historyDebounce = null;

function renderHistoryDebounced() {
  clearTimeout(_historyDebounce);
  _historyDebounce = setTimeout(renderHistory, 200);
}

function renderHistory() {
  const list = document.getElementById('historyList');
  const limit = Math.max(1, cfg.historyDisplayCount || 50);
  const near = strikes.filter(s => !s.isFar);

  // 保護対象（音到達から15秒以内）は件数上限を超えても必ず表示する
  const protectedIds = new Set(near.filter(isProtectedNearby).map(s => s.id));
  const base = cfg.showFarHistory ? strikes : near;
  const regular = base.slice(0, limit);
  const regularIds = new Set(regular.map(s => s.id));
  const extraProtected = near.filter(s => protectedIds.has(s.id) && !regularIds.has(s.id));
  const visibleStrikes = [...regular, ...extraProtected];

  if (visibleStrikes.length === 0) {
    list.innerHTML = '<div class="history-empty">データ待機中...</div>';
    _knownIds.clear();
    return;
  }

  const newIds = new Set(visibleStrikes.map(s => s.id));
  const needRebuild = visibleStrikes.some(s => !_knownIds.has(s.id)) ||
                      [..._knownIds].some(id => !newIds.has(id));
  if (!needRebuild) return;

  const scrollTop = list.scrollTop;
  list.innerHTML = visibleStrikes.map(s => {
    const isNew = !_knownIds.has(s.id);
    const histBadge = s.isHistorical ? '<span class="hist-badge">履歴</span>' : '';
    const farBadge  = s.isFar        ? '<span class="hist-badge far-badge">圏外</span>' : '';
    const itemClass = s.isFar ? 'far' : (s.isWarn ? 'warn' : 'safe');
    const placeName = s.place || `${s.lat.toFixed(3)}°N, ${s.lon.toFixed(3)}°E`;
    return `
      <div class="history-item ${itemClass}${isNew ? ' new-item' : ''}" data-id="${s.id}">
        <div class="history-num">#${s.id} ${histBadge}${farBadge}</div>
        <div class="history-place">⚡ ${placeName}${s.pref ? ' · ' + s.pref : ''}</div>
        <div class="history-coords">${s.lat.toFixed(4)}°N &nbsp;${s.lon.toFixed(4)}°E</div>
        <div class="history-time-row">
          <span class="history-time">🕐 ${fmtDateTime(s.strikeTime)}</span>
          <span class="history-dist">${s.dist.toFixed(1)} km</span>
        </div>
        ${!s.isFar ? `<div class="history-sound" data-sound="${s.id}"></div>` : ''}
      </div>`;
  }).join('');

  list.querySelectorAll('.history-item').forEach(el => {
    el.addEventListener('click', () => {
      const s = strikes.find(x => x.id === parseInt(el.dataset.id));
      if (!s) return;
      map.flyTo([s.lat, s.lon], 10, { duration: 1 });
      if (s.mapLayer) {
        if (!map.hasLayer(s.mapLayer)) s.mapLayer.addTo(map);
        s.mapLayer.openPopup();
      }
    });
  });

  _knownIds = newIds;
  list.scrollTop = scrollTop;

  // 再構築直後に音波到達情報を即時反映（毎秒更新を待たない）
  updateSoundPanel();
}

// ══════════════════════════════════════════════════════════════
//  音波到達パネル（監視圏内のみ）
// ══════════════════════════════════════════════════════════════
// 履歴パネル内の各項目に音波到達カウントダウン・推定音量を差し込む。
// （旧・地図上のフローティング「音波到達」窓を廃止し、右の履歴に統合した）
// 履歴の全面再構築はせず、該当項目の .history-sound だけを毎秒書き換える。
function updateSoundPanel() {
  const list = document.getElementById('historyList');
  if (!list) return;
  const now = Date.now();
  const nodes = list.querySelectorAll('.history-sound');
  for (const el of nodes) {
    const id = parseInt(el.dataset.sound);
    const s = strikes.find(x => x.id === id);
    if (!s || s.isFar) { el.textContent = ''; el.className = 'history-sound'; continue; }

    const arrivalMs = s.timeMs + s.soundSec * 1000;
    const remSec = (arrivalMs - now) / 1000;
    // 到達前、または到達から90秒以内のものだけ表示する（それ以外は消す）
    const active = remSec > 0 || (now - arrivalMs) < 90000;
    if (!active) { el.textContent = ''; el.className = 'history-sound'; continue; }

    let countdown, state;
    if (remSec <= 0) {
      countdown = '🔊 到達済み ✓';
      state = 'arrived';
    } else if (remSec < 60) {
      countdown = `🔊 音: ${Math.round(remSec)}秒後`;
      state = 'pending';
    } else {
      const m = Math.floor(remSec / 60);
      const sc = Math.round(remSec % 60);
      countdown = `🔊 音: ${m}:${String(sc).padStart(2, '0')}後`;
      state = 'pending';
    }
    const db = calcThunderDb(s.dist);
    const vol = s.isWarn ? `　📢 ${db.toFixed(0)}dB ${dbToLabel(db)}` : '';
    // 外部由来の地名等は含まないため textContent で安全に描画
    el.textContent = countdown + vol;
    el.className = 'history-sound ' + state;
  }
}

setInterval(() => {
  renderHistory();
  updateSoundPanel();
  checkUrgentCamera();
}, 1000);

// ══════════════════════════════════════════════════════════════
//  統計チップ
// ══════════════════════════════════════════════════════════════
function updateStatChips() {
  const now = Date.now();
  const cutoff = now - cfg.hours * 3600 * 1000;
  const monitorStrikes = strikes.filter(s => !s.isFar);
  const recent  = monitorStrikes.filter(s => s.timeMs >= cutoff);
  const t = new Date();
  const ty = t.getFullYear(), tm = t.getMonth(), td = t.getDate();
  const today   = monitorStrikes.filter(s => {
    const d = new Date(s.timeMs);
    return d.getFullYear()===ty && d.getMonth()===tm && d.getDate()===td;
  });
  const japanRecent = strikes.filter(s => s.timeMs >= cutoff);
  document.getElementById('statTotal').innerHTML  = `本日(監視) <b>${today.length}</b>`;
  document.getElementById('statRecent').innerHTML = `直近${cfg.hours}h <b>${recent.length}</b>`;
  document.getElementById('statJapan').innerHTML  = `🗾 <b>${japanRecent.length}</b>`;
}

// ══════════════════════════════════════════════════════════════
//  統計モーダル
// ══════════════════════════════════════════════════════════════
function openStats() {
  const now = Date.now();
  const cutoff = now - cfg.hours * 3600 * 1000;
  const monitorStrikes = strikes.filter(s => !s.isFar);
  const recent      = monitorStrikes.filter(s => s.timeMs >= cutoff);
  const warn        = recent.filter(s => s.isWarn);
  const japanRecent = strikes.filter(s => s.timeMs >= cutoff);
  document.getElementById('statsGrid').innerHTML = `
    <div class="stats-card"><div class="num">${recent.length}</div><div class="lbl">直近${cfg.hours}h 監視圏</div></div>
    <div class="stats-card"><div class="num" style="color:var(--accent2)">${warn.length}</div><div class="lbl">${cfg.radius}km圏内</div></div>
    <div class="stats-card"><div class="num" style="color:#3ddc84">${japanRecent.length}</div><div class="lbl">直近${cfg.hours}h 日本全体</div></div>
    <div class="stats-card"><div class="num">${strikes.length}</div><div class="lbl">全履歴件数</div></div>
  `;
  drawStatsChart(recent);
  document.getElementById('statsModal').classList.add('open');
}

function drawStatsChart(data) {
  const canvas = document.getElementById('statsChart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const bins = 18;
  const now = Date.now();
  const span = cfg.hours * 3600 * 1000;
  const binSize = span / bins;
  const counts = new Array(bins).fill(0);
  for (const s of data) {
    const idx = Math.floor((now - s.timeMs) / binSize);
    if (idx >= 0 && idx < bins) counts[bins - 1 - idx]++;
  }
  const max = Math.max(...counts, 1);
  const pad = { l: 30, r: 10, t: 10, b: 28 };
  const bw = (W - pad.l - pad.r) / bins;
  const bh = H - pad.t - pad.b;
  ctx.fillStyle = '#1c2840';
  ctx.fillRect(pad.l, pad.t, W - pad.l - pad.r, bh);
  ctx.strokeStyle = '#1e2d4a'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + bh * (1 - i/4);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
  }
  counts.forEach((c, i) => {
    const x = pad.l + i * bw;
    const h = (c / max) * bh;
    const g = ctx.createLinearGradient(x, pad.t + bh - h, x, pad.t + bh);
    g.addColorStop(0, '#f5c842'); g.addColorStop(1, '#ff6b3566');
    ctx.fillStyle = g;
    ctx.fillRect(x + 1, pad.t + bh - h, bw - 2, h);
  });
  ctx.fillStyle = '#6b7fa8'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
  const step = Math.ceil(bins / 6);
  for (let i = 0; i < bins; i += step) {
    const t = new Date(now - span + (i + 0.5) * binSize);
    ctx.fillText(`${t.getHours()}:${String(t.getMinutes()).padStart(2,'0')}`, pad.l + (i+0.5)*bw, H - 8);
  }
  ctx.textAlign = 'right'; ctx.fillText(max, pad.l - 3, pad.t + 10);
  ctx.fillText('0', pad.l - 3, pad.t + bh);
}

function updateAllDotColors() {
  const chosen = getChosenColor();
  const now = Date.now();
  for (const s of strikes) {
    if (!s.mapLayer) continue;
    const soundArrived = (now - s.timeMs) >= s.soundSec * 1000;
    if (!soundArrived && s.isWarn && !s.isHistorical) continue;
    s.mapLayer.setStyle({ color: chosen, fillColor: chosen });
  }
  for (const [, s] of activeRings) {
    if (!s.ringLayer) continue;
    if (!((Date.now() - s.timeMs) >= s.soundSec * 1000) && s.isWarn) continue;
    s.ringLayer.setStyle({ color: chosen });
  }
}

// ══════════════════════════════════════════════════════════════
//  設定モーダル
// ══════════════════════════════════════════════════════════════
function openSettings() {
  document.getElementById('cfgName').value = cfg.name;
  document.getElementById('cfgLat').value  = cfg.lat ?? '';
  document.getElementById('cfgLon').value  = cfg.lon ?? '';
  document.getElementById('cfgRadius').value = cfg.radius;
  document.getElementById('cfgHours').value  = cfg.hours;
  document.getElementById('cfgMonitorRadius').value = cfg.monitorRadius;
  document.getElementById('cfgMaxHistory').value    = cfg.maxHistory;
  document.getElementById('cfgFps').value           = cfg.fps || 10;
  document.getElementById('cfgShowRing').checked    = !!cfg.showRing;
  document.getElementById('cfgShowRipple').checked     = cfg.showRipple !== false;
  document.getElementById('cfgRippleFar').checked      = !!cfg.rippleFar;
  document.getElementById('cfgSoundRingFar').checked   = !!cfg.soundRingFar;
  document.getElementById('cfgShowFarHistory').checked = !!cfg.showFarHistory;
  document.getElementById('cfgCameraFar').checked      = !!cfg.cameraFar;
  document.getElementById('cfgDotColor').value         = cfg.dotColor || 'blue';
  document.getElementById('cfgHistoryDisplayCount').value = cfg.historyDisplayCount || 50;
  document.getElementById('cfgMapDisplaySec').value       = cfg.mapDisplaySec || 0;
  document.getElementById('cfgMapDisplayCount').value     = cfg.mapDisplayCount || 500;
  const gpsStatus = document.getElementById('gpsStatus');
  if (gpsStatus) gpsStatus.textContent = '';
  document.getElementById('settingsModal').classList.add('open');
}

// 現在地（GPS）から緯度経度を取得して入力欄に反映する。
// セキュリティ: ユーザーのボタン操作を起点にのみ実行し、HTTPS(secure context)
// と明示的な許可が必要。取得座標は設定欄に入れるだけで外部送信はしない。
function fillLocationFromGPS() {
  const statusEl = document.getElementById('gpsStatus');
  const btn = document.getElementById('btnUseGPS');
  if (!window.isSecureContext || !navigator.geolocation) {
    statusEl.textContent = '位置情報は利用できません（HTTPS接続が必要です）';
    return;
  }
  statusEl.textContent = '取得中…';
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      document.getElementById('cfgLat').value = latitude.toFixed(5);
      document.getElementById('cfgLon').value = longitude.toFixed(5);
      // 取得した瞬間に自宅位置を地図へ反映し保存する（次回も引き継ぐ）
      cfg.lat = latitude;
      cfg.lon = longitude;
      saveConfig();
      placeMonitorMarker();
      drawSoundRing();
      updateStatChips();
      if (map) map.flyTo([latitude, longitude], 9, { duration: 1 });
      statusEl.textContent = `現在地を自宅に設定しました（誤差±${Math.round(accuracy)}m）`;
      btn.disabled = false;
    },
    (err) => {
      const msg = err.code === err.PERMISSION_DENIED ? '位置情報の利用が許可されませんでした'
                : err.code === err.POSITION_UNAVAILABLE ? '現在地を特定できませんでした'
                : err.code === err.TIMEOUT ? 'タイムアウトしました。もう一度お試しください'
                : '取得に失敗しました';
      statusEl.textContent = msg;
      btn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
  );
}

function applySettings() {
  const prevDotColor = cfg.dotColor;
  cfg.name    = document.getElementById('cfgName').value.trim() || cfg.name;
  // 0 も有効な座標なので、|| ではなく数値として妥当かどうかで判定する
  const inLat = parseFloat(document.getElementById('cfgLat').value);
  const inLon = parseFloat(document.getElementById('cfgLon').value);
  if (isFinite(inLat)) cfg.lat = inLat;
  if (isFinite(inLon)) cfg.lon = inLon;
  cfg.radius  = parseInt(document.getElementById('cfgRadius').value) || cfg.radius;
  cfg.hours   = parseInt(document.getElementById('cfgHours').value) || cfg.hours;
  cfg.monitorRadius     = parseInt(document.getElementById('cfgMonitorRadius').value) || cfg.monitorRadius;
  cfg.maxHistory        = parseInt(document.getElementById('cfgMaxHistory').value) || cfg.maxHistory;
  cfg.fps               = parseInt(document.getElementById('cfgFps').value) || 10;
  cfg.showRing          = document.getElementById('cfgShowRing').checked;
  cfg.showRipple        = document.getElementById('cfgShowRipple').checked;
  cfg.rippleFar         = document.getElementById('cfgRippleFar').checked;
  cfg.soundRingFar      = document.getElementById('cfgSoundRingFar').checked;
  cfg.showFarHistory    = document.getElementById('cfgShowFarHistory').checked;
  cfg.cameraFar         = document.getElementById('cfgCameraFar').checked;
  cfg.dotColor          = document.getElementById('cfgDotColor').value || 'blue';
  cfg.historyDisplayCount = parseInt(document.getElementById('cfgHistoryDisplayCount').value) || 50;
  cfg.mapDisplaySec     = parseInt(document.getElementById('cfgMapDisplaySec').value) || 0;
  cfg.mapDisplayCount   = parseInt(document.getElementById('cfgMapDisplayCount').value) || 500;
  saveConfig();
  if (prevDotColor !== cfg.dotColor) updateAllDotColors();
  if (hasLocation()) map.flyTo([cfg.lat, cfg.lon], 8, { duration: 1 });
  placeMonitorMarker();
  drawSoundRing();
  updateStatChips();
  renderHistoryDebounced();
  document.getElementById('settingsModal').classList.remove('open');
}

// ══════════════════════════════════════════════════════════════
//  AR ビュー（カメラで方角に落雷を重ねて表示）
// ──────────────────────────────────────────────────────────────
//  セキュリティ方針:
//   - カメラはボタンのタップ操作を起点にのみ起動し、終了時に
//     全トラックを stop() して確実に解放する（録画・保持しない）。
//   - 映像はブラウザ内でのみ扱い、外部へ送信しない（新規の通信なし）。
//   - HTTPS（secure context）でのみ動作。非対応環境ではメッセージ表示。
//   - ラベルは textContent で描画（innerHTML を使わず XSS を防ぐ）。
// ══════════════════════════════════════════════════════════════
const AR = {
  active: false,
  stream: null,
  heading: null,      // 端末が向いている方位（真北=0, 時計回り）
  pitch: 90,          // 端末の上下の傾き（beta 由来）。直立=約90°=水平線を見ている状態
  rafId: null,
  orientHandler: null,
  markers: new Map(), // strikeId -> DOM要素
};

// 水平・垂直の視野角（一般的なスマホ背面カメラの近似値）
const AR_HFOV = 65;   // 度
const AR_VFOV = 50;   // 度
// AR に出す落雷の条件
const AR_MAX_AGE_MS = 15 * 60 * 1000;  // 直近15分
const AR_MAX_COUNT  = 60;

function arSupported() {
  return window.isSecureContext &&
         navigator.mediaDevices &&
         typeof navigator.mediaDevices.getUserMedia === 'function';
}

async function openAR() {
  if (AR.active) return;
  if (!hasLocation()) {
    alert('先に⚙️設定で監視地点（自宅）の座標を登録してください。');
    return;
  }
  if (!arSupported()) {
    alert('この環境ではカメラを利用できません（HTTPS接続と対応ブラウザが必要です）。');
    return;
  }

  const view    = document.getElementById('arView');
  const video   = document.getElementById('arVideo');
  const msgEl    = document.getElementById('arMsg');
  view.hidden = false;
  msgEl.textContent = 'カメラとセンサーを準備中…';

  // iOS 13+ はモーションセンサーの明示的な許可が必要（ユーザー操作起点で呼ぶ）
  try {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      const res = await DOE.requestPermission();
      if (res !== 'granted') {
        msgEl.textContent = '方位センサーの利用が許可されませんでした。';
      }
    }
  } catch { /* 許可ダイアログのキャンセル等は無視して続行 */ }

  // カメラ起動（背面カメラ優先）
  try {
    AR.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch (e) {
    msgEl.textContent = 'カメラを起動できませんでした（許可が必要です）。';
    // 少し見せてから閉じる
    setTimeout(closeAR, 2500);
    return;
  }

  video.srcObject = AR.stream;
  try { await video.play(); } catch {}

  // 方位センサーの購読（Android は absolute、iOS は webkitCompassHeading）
  AR.orientHandler = onDeviceOrientation;
  window.addEventListener('deviceorientationabsolute', AR.orientHandler, true);
  window.addEventListener('deviceorientation', AR.orientHandler, true);

  AR.active = true;
  msgEl.textContent = '';
  arRenderLoop();
}

function closeAR() {
  if (AR.orientHandler) {
    window.removeEventListener('deviceorientationabsolute', AR.orientHandler, true);
    window.removeEventListener('deviceorientation', AR.orientHandler, true);
    AR.orientHandler = null;
  }
  if (AR.rafId) { cancelAnimationFrame(AR.rafId); AR.rafId = null; }

  // カメラを確実に解放する
  if (AR.stream) {
    AR.stream.getTracks().forEach(t => t.stop());
    AR.stream = null;
  }
  const video = document.getElementById('arVideo');
  if (video) video.srcObject = null;

  const overlay = document.getElementById('arOverlay');
  if (overlay) overlay.replaceChildren();
  AR.markers.clear();

  const view = document.getElementById('arView');
  if (view) view.hidden = true;
  AR.active = false;
}

// 端末の向きから方位（真北基準・時計回り）と上下の傾きを求める
function onDeviceOrientation(e) {
  let heading = null;
  if (typeof e.webkitCompassHeading === 'number') {
    heading = e.webkitCompassHeading;                 // iOS: 既に真北基準
  } else if (e.absolute && typeof e.alpha === 'number') {
    heading = (360 - e.alpha) % 360;                  // Android(absolute): alpha は反時計回り
  }
  if (heading !== null) {
    // 画面の回転（横持ち等）を補正
    const scr = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    AR.heading = (heading + scr + 360) % 360;
  }
  if (typeof e.beta === 'number') AR.pitch = e.beta;   // 直立で約90°
}

// AR 表示対象の落雷を抽出する（監視圏内・直近・新しい順）
function arVisibleStrikes() {
  const now = Date.now();
  const out = [];
  for (const s of strikes) {
    if (s.isFar) continue;
    if (!isFinite(s.dist)) continue;
    if (now - s.timeMs > AR_MAX_AGE_MS) continue;
    out.push(s);
    if (out.length >= AR_MAX_COUNT) break;
  }
  return out;
}

function arRenderLoop() {
  if (!AR.active) return;
  const overlay = document.getElementById('arOverlay');
  const headEl  = document.getElementById('arHeading');
  const W = overlay.clientWidth, H = overlay.clientHeight;

  if (AR.heading === null) {
    headEl.textContent = '方位センサー校正中…（端末を8の字に動かしてください）';
  } else {
    headEl.textContent = `方位 ${Math.round(AR.heading)}° ${headingName(AR.heading)}`;
  }

  const seen = new Set();
  if (AR.heading !== null) {
    const now = Date.now();
    for (const s of arVisibleStrikes()) {
      const bearing = bearingTo(cfg.lat, cfg.lon, s.lat, s.lon);
      const dx = angleDelta(bearing, AR.heading);       // 左右方向のずれ（度）
      if (Math.abs(dx) > AR_HFOV / 2) continue;         // 視野外は描かない

      // 水平: 視野中心からの割合で画面X座標へ
      const x = W / 2 + (dx / (AR_HFOV / 2)) * (W / 2);
      // 垂直: 落雷は地上=地平線付近で「高さ」は本質的に無い。
      // そのため縦は画面中央（地平線）に固定し、端末の傾きはごく弱くだけ反映。
      // どんな持ち方でも必ず中央帯(30〜70%)に収まり、画面下端に張り付かない。
      const pitch = (typeof AR.pitch === 'number') ? AR.pitch : 90;
      const camElev = 90 - pitch;                       // カメラ中心の仰角(度)。上向きで正
      // 基準位置を中央より少し上（画面の約42%）に置く。落雷は地平線付近だが
      // 画面下部に張り付くと視認しづらいため、やや上寄りの帯に収める。
      let y = H * 0.42 + (camElev / 90) * (H * 0.20);    // 感度を大きく下げる
      y = Math.max(H * 0.22, Math.min(H * 0.58, y));     // やや上寄りの帯に必ず収める

      seen.add(s.id);
      let el = AR.markers.get(s.id);
      if (!el) { el = createArMarker(s); overlay.appendChild(el); AR.markers.set(s.id, el); }
      updateArMarker(el, s, now);
      el.style.transform =
        `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  // 視野から外れた/消えたマーカーを撤去
  for (const [id, el] of AR.markers) {
    if (!seen.has(id)) { el.remove(); AR.markers.delete(id); }
  }

  AR.rafId = requestAnimationFrame(arRenderLoop);
}

function headingName(deg) {
  const names = ['北','北東','東','南東','南','南西','西','北西'];
  return names[Math.round(deg / 45) % 8];
}

function createArMarker(s) {
  const el = document.createElement('div');
  el.className = 'ar-marker' + (s.isWarn ? ' ar-warn' : '');
  const dot = document.createElement('div');
  dot.className = 'ar-marker-dot';
  const label = document.createElement('div');
  label.className = 'ar-marker-label';
  el.appendChild(dot);
  el.appendChild(label);
  el._label = label;   // 参照を保持
  return el;
}

function updateArMarker(el, s, now) {
  // textContent のみ使用（外部由来の地名を安全に描画）
  const remSec = (s.timeMs + s.soundSec * 1000 - now) / 1000;
  const place = s.place && s.place !== '取得中...' ? s.place : '';
  const sound = s.isWarn
    ? (remSec > 0 ? `　🔊${fmtSec(remSec)}` : '　🔊到達済み')
    : '';
  el._label.textContent = `${s.dist.toFixed(1)}km${place ? ' ' + place : ''}${sound}`;
  el.classList.toggle('ar-warn', !!s.isWarn);
}

// ══════════════════════════════════════════════════════════════
//  履歴パネルの横幅リサイズ
// ══════════════════════════════════════════════════════════════
const PANEL_MIN_W = 200;
const PANEL_MAX_W = 720;

function clampPanelWidth(w) {
  // 画面が狭いときは上限を画面幅の7割までに抑える
  const hardMax = Math.min(PANEL_MAX_W, Math.round(window.innerWidth * 0.7));
  return Math.max(PANEL_MIN_W, Math.min(hardMax, w));
}

function applyPanelWidth(w) {
  const panel = document.querySelector('.side-panel');
  if (!panel) return;
  panel.style.width = clampPanelWidth(w) + 'px';
  // 地図のサイズが変わるので Leaflet に再計算させる
  if (map) map.invalidateSize({ pan: false });
}

function setupPanelResizer() {
  const resizer = document.getElementById('panelResizer');
  const panel = document.querySelector('.side-panel');
  if (!resizer || !panel) return;

  // 保存済みの幅を復元
  applyPanelWidth(cfg.sidePanelWidth || 320);

  let dragging = false;
  let rafPending = false;
  let pendingW = cfg.sidePanelWidth || 320;

  const onMove = (clientX) => {
    // パネルは右端にあるので「ウィンドウ右端 − カーソルX」が新しい幅
    pendingW = clampPanelWidth(window.innerWidth - clientX);
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      panel.style.width = pendingW + 'px';
      if (map) map.invalidateSize({ pan: false });
    });
  };

  const startDrag = () => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing-panel');
    // ドラッグ中は自動カメラ移動を抑止（誤作動防止）
    lastUserInteractMs = Date.now();
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing-panel');
    cfg.sidePanelWidth = clampPanelWidth(pendingW);
    saveConfig();
    if (map) map.invalidateSize({ pan: false });
  };

  // マウス
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startDrag();
    const mm = (ev) => { if (dragging) onMove(ev.clientX); };
    const mu = () => {
      window.removeEventListener('mousemove', mm);
      window.removeEventListener('mouseup', mu);
      endDrag();
    };
    window.addEventListener('mousemove', mm);
    window.addEventListener('mouseup', mu);
  });

  // タッチ
  resizer.addEventListener('touchstart', (e) => {
    startDrag();
    const tm = (ev) => {
      if (dragging && ev.touches[0]) onMove(ev.touches[0].clientX);
    };
    const te = () => {
      window.removeEventListener('touchmove', tm);
      window.removeEventListener('touchend', te);
      window.removeEventListener('touchcancel', te);
      endDrag();
    };
    window.addEventListener('touchmove', tm, { passive: true });
    window.addEventListener('touchend', te);
    window.addEventListener('touchcancel', te);
  }, { passive: true });

  // ダブルクリックで既定幅に戻す
  resizer.addEventListener('dblclick', () => {
    pendingW = DEFAULT_CONFIG.sidePanelWidth;
    applyPanelWidth(pendingW);
    cfg.sidePanelWidth = pendingW;
    saveConfig();
  });

  // ウィンドウリサイズ時に上限を超えないよう補正
  window.addEventListener('resize', () => {
    if (window.innerWidth > 900) applyPanelWidth(cfg.sidePanelWidth || 320);
  });
}

// ══════════════════════════════════════════════════════════════
//  初期化
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupPanelResizer();
  restoreStoredStrikes();

  window.electronAPI.onWsStatus(setBadge);
  window.electronAPI.onStrike(onStrikeData);
  window.electronAPI.onWsStats(onWsStats);

  document.getElementById('btnStats').addEventListener('click', openStats);
  document.getElementById('btnSettings').addEventListener('click', openSettings);

  // AR ビュー（カメラで方角に落雷を重ねる）
  const btnAR = document.getElementById('btnAR');
  if (btnAR) btnAR.addEventListener('click', openAR);
  const arClose = document.getElementById('arClose');
  if (arClose) arClose.addEventListener('click', closeAR);
  // 非対応環境ではボタンを無効化
  if (btnAR && !arSupported()) {
    btnAR.disabled = true;
    btnAR.title = 'ARビューは HTTPS 接続と対応ブラウザが必要です';
  }
  // タブが隠れた/離脱した際はカメラを確実に解放する
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && AR.active) closeAR();
  });
  window.addEventListener('pagehide', () => { if (AR.active) closeAR(); });
  document.getElementById('closeStats').addEventListener('click', () =>
    document.getElementById('statsModal').classList.remove('open'));
  document.getElementById('closeSettings').addEventListener('click', () =>
    document.getElementById('settingsModal').classList.remove('open'));
  document.getElementById('saveSettings').addEventListener('click', applySettings);
  const btnGPS = document.getElementById('btnUseGPS');
  if (btnGPS) btnGPS.addEventListener('click', fillLocationFromGPS);
  document.querySelectorAll('.modal-overlay').forEach(el =>
    el.addEventListener('click', e => { if (e.target === el) el.classList.remove('open'); }));
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => setMapFilter(parseInt(btn.dataset.filter)));
  });

  // カメラ追従トグル
  document.getElementById('btnCamera').addEventListener('click', () => {
    cfg.autoCamera = !cfg.autoCamera;
    saveConfig();
    updateCameraBtn();
  });
  updateCameraBtn();

  // カメラ固定レバー（ON の間はカメラを自動移動しない）
  document.getElementById('leverCameraLock').addEventListener('click', () => {
    cfg.cameraLock = !cfg.cameraLock;
    saveConfig();
    updateCameraLockLever();
  });
  updateCameraLockLever();

  // 雨雲レバー（ON で気象庁ナウキャストの雨雲を地図に重ねる）
  const leverRain = document.getElementById('leverRain');
  if (leverRain) leverRain.addEventListener('click', () => {
    cfg.showRain = !cfg.showRain;
    saveConfig();
    updateRainLayer();
  });
  updateRainLayer();

  // 監視地点が未設定なら、初回起動時に設定モーダルを自動で開いて入力を促す
  if (!hasLocation()) openSettings();
});
