require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const QRCode = require('qrcode');
const crypto = require('crypto');
const open = require('open');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── State ────────────────────────────────────────────────────────────────────
let currentPIN = generatePIN();
let publicURL = null;
let translationActive = false;
let subtitleVisible = true;
let autoHideDelay = 5000; // ms; 0 = off
let translationMode = 'precise'; // 'quick' | 'precise'
let selectedAudioDevice = null;
let soxProcess = null;
let openaiWS = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 3;

const translations = [];      // { timestamp, korean, japanese }
const MAX_TRANSLATIONS = 100;

const logs = [];
const MAX_LOGS = 100;

const viewers = new Map();       // ws → { id, connectedAt }  (legacy WS viewers)
const allClients = [];           // all SSE clients: { res, type: 'control'|'viewer', id }
let clientIdCounter = 0;

let viewerIdCounter = 0;
let subtitleHideTimer = null;
let lastSubtitleTime = 0;
let subtitleQueue = [];
let subtitleProcessing = false;

// Rolling buffer for progressive translation
let rollingBuffer = '';
const MAX_ROLLING_CHARS = 25;
let latestKorean = '';

// ── Helpers ──────────────────────────────────────────────────────────────────
function generatePIN() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function timestamp() {
  return new Date().toLocaleTimeString('ko-KR', { hour12: false });
}

function addLog(level, title, detail = '') {
  const entry = { level, title, detail, time: timestamp(), id: Date.now() + Math.random() };
  logs.unshift(entry);
  if (logs.length > MAX_LOGS) logs.pop();
  broadcast('log', entry);
}

function broadcast(type, data) {
  let msg;
  if (Array.isArray(data)) {
    msg = JSON.stringify({ type, items: data });
  } else {
    msg = JSON.stringify({ type, ...(data || {}) });
  }
  const line = `data: ${msg}\n\n`;
  allClients.forEach(({ res }) => {
    try { res.write(line); } catch (_) {}
  });
}

// ── ngrok ────────────────────────────────────────────────────────────────────
async function startNgrok() {
  try {
    const ngrok = require('ngrok');
    publicURL = await ngrok.connect({ addr: 3000, proto: 'http' });
    addLog('green', '공개 URL 생성됨', `URL: ${publicURL}`);
    broadcast('ngrok', { url: publicURL });
  } catch (e) {
    // fallback to local IP
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    let localIP = 'localhost';
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          localIP = net.address;
          break;
        }
      }
    }
    publicURL = `http://${localIP}:3000`;
    addLog('yellow', 'ngrok 연결 실패. 로컬 IP 사용 중', `URL: ${publicURL}`);
    broadcast('ngrok', { url: publicURL });
  }
}

// ── sox audio devices ─────────────────────────────────────────────────────────

// Classify a device by its Transport string (from system_profiler) + name fallback
function classifyDevice(name, transport) {
  const t = (transport || '').toLowerCase();
  const l = name.toLowerCase();

  if (t === 'built-in')  return 'Built-in';
  if (t === 'usb')       return 'USB';
  if (t === 'bluetooth') return 'Bluetooth';
  if (t === 'virtual' || t === 'aggregate') return 'Virtual';
  if (t === 'displayport' || t === 'thunderbolt' || t === 'pci' || t === 'firewire') return 'External';

  // name-based fallback
  if (l.includes('built-in') || l.includes('macbook') || l.includes('internal')) return 'Built-in';
  if (l.includes('blackhole') || l.includes('loopback') || l.includes('soundflower') ||
      l.includes('teams') || l.includes('zoom')) return 'Virtual';
  if (l.includes('usb'))  return 'USB';
  if (l.includes('bluetooth') || l.includes('airpods')) return 'Bluetooth';
  return 'External';
}

// Parse system_profiler SPAudioDataType output.
// Device names are indented 8 spaces; properties 10 spaces.
// The same device can appear twice (input entry + output entry) — we merge by name.
function parseSystemProfilerAudio(output) {
  const byName = {};  // name → { transport, inputChannels, isDefaultInput }
  const lines  = output.split('\n');
  let current  = null;

  for (const line of lines) {
    // Device name line: exactly 8 leading spaces, text, colon, nothing after
    const nameM = line.match(/^        ([^:]+):\s*$/);
    if (nameM && nameM[1].trim() !== 'Devices') {
      current = nameM[1].trim();
      if (!byName[current]) byName[current] = { transport: 'Unknown', inputChannels: 0, isDefaultInput: false };
      continue;
    }

    if (!current) continue;

    // Property line: 10 leading spaces
    const propM = line.match(/^          (.+?):\s*(.+)$/);
    if (!propM) continue;
    const key = propM[1].trim();
    const val = propM[2].trim();

    if (key === 'Transport')           byName[current].transport      = val;
    if (key === 'Input Channels')      byName[current].inputChannels  = parseInt(val) || 0;
    if (key === 'Default Input Device' && val === 'Yes') byName[current].isDefaultInput = true;
  }

  // Keep only input-capable devices, build typed array
  const result = [];
  const typeOrder = { 'Built-in': 0, 'USB': 1, 'Bluetooth': 2, 'Virtual': 3, 'External': 4 };

  for (const [name, info] of Object.entries(byName)) {
    if (info.inputChannels === 0) continue;
    result.push({
      name,
      type:           classifyDevice(name, info.transport),
      isDefaultInput: info.isDefaultInput
    });
  }

  result.sort((a, b) => (typeOrder[a.type] ?? 5) - (typeOrder[b.type] ?? 5));
  return result.map((d, i) => ({ ...d, id: i }));
}

// Main async device listing — uses system_profiler as primary source
async function listAudioDevices() {
  return new Promise((resolve) => {
    exec('system_profiler SPAudioDataType', (err, output) => {
      if (err || !output) {
        // Absolute fallback: return a single Built-in entry
        resolve([{ id: 0, name: 'MacBook Pro Microphone', type: 'Built-in', isDefaultInput: true }]);
        return;
      }
      resolve(parseSystemProfilerAudio(output));
    });
  });
}

// Test a device: spawn sox for 1.5s, check if data flows
function testAudioDevice(deviceName, cb) {
  const args = buildSoxInputArgs(deviceName)
    .concat(['-r', '24000', '-c', '1', '-e', 'signed-integer', '-b', '16', '-t', 'raw', '-']);

  const proc = spawn('sox', args);
  let gotData = false;
  let errMsg  = '';
  let done    = false;

  const finish = (ok, detail) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    cb(ok, detail);
  };

  proc.stdout.on('data', () => { gotData = true; });
  proc.stderr.on('data', d  => { errMsg += d.toString(); });

  const timer = setTimeout(() => {
    proc.kill();
    finish(gotData, gotData ? '' : errMsg.trim());
  }, 1500);

  proc.on('close', (code) => {
    finish(gotData, code !== 0 && !gotData ? errMsg.trim() : '');
  });
}

// ── Translation pipeline ──────────────────────────────────────────────────────
function startTranslation() {
  if (translationActive) return;
  if (!process.env.OPENAI_API_KEY) {
    addLog('red', 'API 키가 올바르지 않습니다', 'OPENAI_API_KEY not set in .env');
    return;
  }

  translationActive = true;
  reconnectAttempts = 0;
  deltaBuffer     = '';
  rollingBuffer   = '';
  latestKorean    = '';
  quickModeBuffer = '';
  if (quickModeTimer) { clearTimeout(quickModeTimer); quickModeTimer = null; }
  broadcast('status', { translationActive: true });

  startOpenAIWebSocket();
  startSox();
}

function stopTranslation() {
  translationActive = false;
  reconnectAttempts = 0;

  if (soxProcess) {
    soxProcess.kill();
    soxProcess = null;
  }
  if (wsStateTimer) { clearInterval(wsStateTimer); wsStateTimer = null; }
  if (openaiWS) {
    if (openaiWS.readyState === WebSocket.OPEN) {
      openaiWS.send(JSON.stringify({ type: 'session.close' }));
    }
    openaiWS.close();
    openaiWS = null;
  }

  addLog('green', '번역 중지됨', '');
  broadcast('status', { translationActive: false });
}

let wsStateTimer = null;

function startOpenAIWebSocket() {
  if (!translationActive) return;
  if (!process.env.OPENAI_API_KEY) return;

  const wsURL = 'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate';
  openaiWS = new WebSocket(wsURL, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  // Log WebSocket state every 5 seconds
  if (wsStateTimer) clearInterval(wsStateTimer);
  wsStateTimer = setInterval(() => {
    if (!openaiWS) { clearInterval(wsStateTimer); return; }
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    const state  = states[openaiWS.readyState] || `UNKNOWN(${openaiWS.readyState})`;
    addLog('green', `WebSocket 상태: ${state}`, '');
  }, 5000);

  openaiWS.on('open', () => {
    reconnectAttempts = 0;
    addLog('green', 'OpenAI 서버 연결됨', 'Model: gpt-realtime-translate');
    broadcast('status', { openaiConnected: true });

    const sessionUpdate = {
      type: 'session.update',
      session: {
        audio: {
          output: {
            language: 'ja'
          }
        }
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
    addLog('green', `session.update 전송: ${JSON.stringify(sessionUpdate.session)}`, '');
  });

  openaiWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    switch (msg.type) {

      // ── Japanese text output (what we want) ──────────────────────────────
      case 'session.output_transcript.delta': {
        const delta = msg.delta || '';
        addLog('green', `번역 수신: ${delta}`, `[OpenAI] ${msg.type}`);
        processTranslationDelta(delta);
        break;
      }

      case 'session.output_transcript.done': {
        const transcript = msg.transcript || rollingBuffer;
        addLog('green', `번역 수신: ${transcript}`, `[OpenAI] ${msg.type}`);
        if (transcript) flushTranslation(transcript);
        break;
      }

      // ── Korean source text ────────────────────────────────────────────────
      case 'session.input_transcript.delta': {
        const delta = msg.delta || '';
        addLog('green', `원문 수신: ${delta}`, `[OpenAI] ${msg.type}`);
        latestKorean += delta;
        break;
      }

      case 'session.input_transcript.done': {
        const src = msg.transcript || latestKorean;
        addLog('green', `원문 수신: ${src}`, `[OpenAI] ${msg.type}`);
        latestKorean = src;
        break;
      }

      // ── Audio output — silently ignored, we want text only ───────────────
      case 'session.output_audio.delta':
      case 'session.output_audio.done':
        break;

      // ── Session lifecycle ─────────────────────────────────────────────────
      case 'session.created':
        addLog('green', `[OpenAI] ${msg.type}`, `Session ID: ${msg.session?.id || 'unknown'}`);
        addLog('green', '번역 시작됨', `Session ID: ${msg.session?.id || 'unknown'}`);
        break;

      case 'session.updated':
        addLog('green', `[OpenAI] ${msg.type}`, JSON.stringify(msg.session?.audio || {}));
        break;

      // ── Errors ────────────────────────────────────────────────────────────
      case 'error':
        addLog('red', `[OpenAI] error: ${msg.error?.message || JSON.stringify(msg.error || msg)}`, '');
        break;

      // ── Everything else ───────────────────────────────────────────────────
      default:
        addLog('green', `[OpenAI] ${msg.type}`, '');
        break;
    }
  });

  openaiWS.on('close', (code, reason) => {
    if (wsStateTimer) { clearInterval(wsStateTimer); wsStateTimer = null; }
    addLog('green', `[OpenAI] 연결 종료`, `code: ${code} reason: ${reason || '(none)'}`);
    broadcast('status', { openaiConnected: false });
    if (translationActive) {
      attemptReconnect();
    }
  });

  openaiWS.on('error', (err) => {
    addLog('red', 'WebSocket 연결 끊김', `Error: ${err.message}`);
  });
}

let deltaBuffer = '';
let deltaFlushTimer = null;
const MIN_UPDATE_INTERVAL = 1500;

let quickModeBuffer = '';
let quickModeTimer  = null;
const QUICK_MODE_FLUSH_MS = 300;

function processTranslationDelta(delta) {
  deltaBuffer += delta;
  rollingBuffer = (rollingBuffer + delta).slice(-MAX_ROLLING_CHARS);

  if (translationMode === 'superfast') {
    // Zero buffering — broadcast every delta immediately
    broadcast('subtitle-update', { text: deltaBuffer, state: 'streaming' });
  } else if (translationMode === 'quick') {
    // 300ms word-boundary micro-buffer
    quickModeBuffer += delta;
    if (quickModeTimer) clearTimeout(quickModeTimer);
    quickModeTimer = setTimeout(() => {
      broadcast('subtitle-update', { text: deltaBuffer, state: 'streaming' });
      quickModeBuffer = '';
      quickModeTimer  = null;
    }, QUICK_MODE_FLUSH_MS);
  }
  // Precise mode: no streaming updates — wait for sentence done event

  if (!deltaFlushTimer) {
    deltaFlushTimer = setTimeout(() => {
      if (deltaBuffer) { flushTranslation(deltaBuffer); deltaBuffer = ''; }
      deltaFlushTimer = null;
    }, MIN_UPDATE_INTERVAL);
  }
}

function flushTranslation(japanese) {
  if (deltaFlushTimer) { clearTimeout(deltaFlushTimer); deltaFlushTimer = null; }
  deltaBuffer  = '';
  rollingBuffer = '';

  const korean = latestKorean || '(음성 인식 중)';
  latestKorean = '';

  // Send final text to ALL SSE clients
  broadcast('subtitle-update', { text: japanese, state: 'done' });

  const entry = { timestamp: timestamp(), korean, japanese, id: Date.now() };
  translations.unshift(entry);
  if (translations.length > MAX_TRANSLATIONS) translations.pop();
  broadcast('translation', entry);

  if (autoHideDelay > 0) {
    if (subtitleHideTimer) clearTimeout(subtitleHideTimer);
    subtitleHideTimer = setTimeout(() => {
      broadcast('subtitle-hide', {});
    }, autoHideDelay);
  }

  const totalViewers = viewers.size + allClients.filter(c => c.type === 'viewer').length;
  addLog('green', `번역 완료: ${japanese}`, `→ ${totalViewers}명에게 전송됨`);
}

function attemptReconnect() {
  if (!translationActive) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT) {
    addLog('red', '재연결 실패 인터넷을 확인해주세요', `Attempts: ${MAX_RECONNECT}`);
    translationActive = false;
    broadcast('status', { translationActive: false });
    return;
  }
  addLog('red', 'WebSocket 연결 끊김', `재연결 시도 중... (${reconnectAttempts}/${MAX_RECONNECT})`);
  setTimeout(() => {
    if (!translationActive) return;
    startOpenAIWebSocket();
    addLog('green', '재연결 성공', `Attempt: ${reconnectAttempts}/${MAX_RECONNECT}`);
  }, 2000);
}

// Build sox input args for a named coreaudio device (or default)
function buildSoxInputArgs(deviceName) {
  if (!deviceName) return ['-d']; // sox default audio device
  return ['-t', 'coreaudio', deviceName];
}

function startSox() {
  if (!translationActive) return;

  const args = buildSoxInputArgs(selectedAudioDevice)
    .concat(['-r', '24000', '-c', '1', '-e', 'signed-integer', '-b', '16', '-t', 'raw', '-']);

  soxProcess = spawn('sox', args);

  const deviceName = selectedAudioDevice || 'Built-in Microphone (default)';
  addLog('green', '마이크 시작됨 - 오디오 전송 시작', `Device: ${deviceName}`);

  let chunkCount = 0;

  soxProcess.stdout.on('data', (chunk) => {
    chunkCount++;

    // Log first 5 chunks and then every 50th to confirm data is flowing
    if (chunkCount <= 5 || chunkCount % 50 === 0) {
      addLog('green', `청크 전송: #${chunkCount} (${chunk.length} bytes)`,
        `WS state: ${openaiWS ? ['CONNECTING','OPEN','CLOSING','CLOSED'][openaiWS.readyState] : 'NO_WS'}`);
    }

    if (!openaiWS || openaiWS.readyState !== WebSocket.OPEN) return;

    openaiWS.send(JSON.stringify({
      type: 'session.input_audio_buffer.append',
      audio: chunk.toString('base64')
    }));
  });

  soxProcess.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (!msg) return;
    if (msg.includes('no handler') || msg.includes('FAIL') || msg.includes('Error')) {
      addLog('red', '마이크를 찾을 수 없습니다', msg);
    }
    // Ignore sox informational stderr (In:0.00% progress lines etc.)
  });

  soxProcess.on('close', (code) => {
    addLog(
      code === 0 || !translationActive ? 'green' : 'red',
      code === 0 ? '마이크 종료됨' : '마이크를 찾을 수 없습니다',
      `Sox exited with code ${code}, total chunks sent: ${chunkCount}`
    );
  });
}

// ── WebSocket (viewer clients) ────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws/viewer') { ws.close(); return; }

  const pin = url.searchParams.get('pin');
  if (pin !== currentPIN) {
    ws.send(JSON.stringify({ type: 'pin_error', message: 'PIN이 변경되었습니다. 새 PIN을 입력하세요' }));
    ws.close();
    return;
  }

  const id = ++viewerIdCounter;
  viewers.set(ws, { id, connectedAt: new Date() });
  addLog('green', '새 기기 접속', `Total: ${viewers.size}명`);
  broadcast('viewers', getViewerList());

  ws.on('close', () => {
    viewers.delete(ws);
    addLog('green', '기기 연결 끊김', `Total: ${viewers.size}명`);
    broadcast('viewers', getViewerList());
  });

  ws.on('error', () => {
    viewers.delete(ws);
    broadcast('viewers', getViewerList());
  });

  // send current state
  ws.send(JSON.stringify({ type: 'init', subtitleVisible, autoHideDelay }));
  if (translations.length > 0 && subtitleVisible) {
    ws.send(JSON.stringify({ type: 'history', items: translations.slice(0, 20).map(t => t.japanese) }));
  }
});

function getViewerList() {
  const list = [];
  viewers.forEach((info, ws) => {
    list.push({ id: info.id, connected: ws.readyState === WebSocket.OPEN });
  });
  allClients.filter(c => c.type === 'viewer').forEach(client => {
    list.push({ id: client.id, connected: true });
  });
  return list;
}

// ── Heartbeat: keeps all SSE connections alive ────────────────────────────────
setInterval(() => {
  const heartbeat = ': heartbeat\n\n';
  allClients.forEach(({ res }) => { try { res.write(heartbeat); } catch (_) {} });
}, 30000);

// ── Unified SSE endpoint for both control and viewer ──────────────────────────
app.get('/events', (req, res) => {
  const clientType = req.query.type || 'control';
  const incomingPIN = req.query.pin;
  console.log(`SSE /events called: type=${clientType} pin=${incomingPIN} currentPIN=${currentPIN}`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  if (clientType === 'viewer' && incomingPIN !== currentPIN) {
    console.log(`SSE viewer PIN mismatch — sending pin_error and closing`);
    res.write(`data: ${JSON.stringify({ type: 'pin_error', message: '잘못된 PIN입니다' })}\n\n`);
    res.end();
    return;
  }

  const id = ++clientIdCounter;
  const client = { res, type: clientType, id };
  allClients.push(client);
  console.log(`SSE connected: ${clientType} id=${id} (total: ${allClients.length})`);

  if (clientType === 'control') {
    const initMsg = {
      type: 'init',
      pin: currentPIN,
      publicURL,
      translationActive,
      subtitleVisible,
      autoHideDelay,
      translationMode,
      viewers: getViewerList(),
      logs: logs.slice(0, 50),
      translations: translations.slice(0, 50)
    };
    res.write(`data: ${JSON.stringify(initMsg)}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify({ type: 'init', subtitleVisible, autoHideDelay, translationMode })}\n\n`);
    const historyItems = translations.slice(0, 20).map(t => t.japanese).filter(Boolean);
    if (historyItems.length) {
      res.write(`data: ${JSON.stringify({ type: 'history', items: historyItems })}\n\n`);
    }
    const viewerCount = allClients.filter(c => c.type === 'viewer').length + viewers.size;
    addLog('green', '새 기기 접속 (SSE)', `Total: ${viewerCount}명`);
    broadcast('viewers', getViewerList());
  }

  req.on('close', () => {
    const idx = allClients.indexOf(client);
    if (idx !== -1) allClients.splice(idx, 1);
    console.log(`SSE disconnected: ${clientType} id=${id} (total: ${allClients.length})`);
    if (clientType === 'viewer') {
      const viewerCount = allClients.filter(c => c.type === 'viewer').length + viewers.size;
      addLog('green', '기기 연결 끊김', `Total: ${viewerCount}명`);
      broadcast('viewers', getViewerList());
    }
  });
});

// ── REST API ──────────────────────────────────────────────────────────────────
app.post('/api/translation/start', (req, res) => {
  startTranslation();
  res.json({ ok: true });
});

app.post('/api/translation/stop', (req, res) => {
  stopTranslation();
  res.json({ ok: true });
});

app.post('/api/subtitle/show', (req, res) => {
  subtitleVisible = true;
  broadcast('visibility', { visible: true });
  broadcast('status', { subtitleVisible: true });
  res.json({ ok: true });
});

app.post('/api/subtitle/hide', (req, res) => {
  subtitleVisible = false;
  broadcast('visibility', { visible: false });
  broadcast('status', { subtitleVisible: false });
  res.json({ ok: true });
});

app.post('/api/pin/regenerate', (req, res) => {
  currentPIN = generatePIN();
  disconnectAllViewers();
  addLog('green', 'PIN이 변경되었습니다', `New PIN: ${currentPIN}`);
  broadcast('pin', { pin: currentPIN });
  res.json({ pin: currentPIN });
});

app.post('/api/pin/set', (req, res) => {
  const { pin } = req.body;
  if (!/^\d{6}$/.test(pin)) {
    return res.status(400).json({ error: '6자리 숫자를 입력해주세요' });
  }
  currentPIN = pin;
  disconnectAllViewers();
  addLog('green', 'PIN이 변경되었습니다', `New PIN: ${currentPIN}`);
  broadcast('pin', { pin: currentPIN });
  res.json({ pin: currentPIN });
});

app.get('/api/pin', (req, res) => res.json({ pin: currentPIN }));

app.post('/api/autohide', (req, res) => {
  const { delay } = req.body; // 2000, 5000, 10000, 0
  autoHideDelay = delay;
  broadcast('autohide', { delay });
  broadcast('status', { autoHideDelay: delay });
  res.json({ ok: true });
});

app.post('/api/translation-mode', (req, res) => {
  const { mode } = req.body;
  if (!['superfast', 'quick', 'precise'].includes(mode)) return res.status(400).json({ error: 'Invalid mode' });
  translationMode = mode;
  const label = { superfast: '초고속 번역', quick: '빠른 번역', precise: '정확한 번역' }[mode];
  addLog('green', `번역 모드 변경됨: ${label}`, '');
  broadcast('status', { translationMode });
  res.json({ ok: true });
});

app.get('/api/devices', async (req, res) => {
  const devices = await listAudioDevices();
  res.json({ devices, selected: selectedAudioDevice });
});

app.post('/api/devices/select', async (req, res) => {
  const { device } = req.body;
  selectedAudioDevice = device || null;
  const label = device || 'Built-in Microphone (default)';
  addLog('green', '오디오 입력 변경됨', `Device: ${label}`);
  if (translationActive) {
    if (soxProcess) { soxProcess.kill(); soxProcess = null; }
    startSox();
  }
  broadcast('status', { selectedAudioDevice });
  res.json({ ok: true });
});

app.post('/api/devices/test', (req, res) => {
  const { device } = req.body;
  const label = device || 'Built-in Microphone (default)';
  testAudioDevice(device || null, (ok, detail) => {
    if (ok) {
      addLog('green', `오디오 입력 테스트 성공: ${label}`, detail || '');
    } else {
      addLog('red', `오디오 입력 테스트 실패: ${label}`, detail || '장치에서 오디오 데이터를 받지 못했습니다');
    }
    res.json({ ok, detail });
  });
});

app.get('/api/qr', async (req, res) => {
  const url = publicURL ? `${publicURL}/viewer` : `http://localhost:3000/viewer`;
  try {
    const dataURL = await QRCode.toDataURL(url, { width: 200, margin: 1 });
    res.json({ qr: dataURL, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/translations/clear', (req, res) => {
  translations.length = 0;
  broadcast('translations_cleared', {});
  res.json({ ok: true });
});

app.post('/api/logs/clear', (req, res) => {
  logs.length = 0;
  broadcast('logs_cleared', {});
  res.json({ ok: true });
});

// ── PIN verification for viewer ───────────────────────────────────────────────
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body;
  if (pin === currentPIN) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: '잘못된 PIN입니다' });
  }
});

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/control', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'control.html'));
});

app.get('/viewer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/', (req, res) => res.redirect('/control'));

// ── Disconnect helpers ────────────────────────────────────────────────────────
function disconnectAllViewers() {
  viewers.forEach((info, ws) => {
    try { ws.send(JSON.stringify({ type: 'pin_changed', message: 'PIN이 변경되었습니다. 새 PIN을 입력하세요' })); ws.close(); } catch (_) {}
  });
  viewers.clear();

  const pinMsg = `data: ${JSON.stringify({ type: 'pin_changed' })}\n\n`;
  for (let i = allClients.length - 1; i >= 0; i--) {
    if (allClients[i].type === 'viewer') {
      try { allClients[i].res.write(pinMsg); allClients[i].res.end(); } catch (_) {}
      allClients.splice(i, 1);
    }
  }

  broadcast('viewers', []);
}

// ── Startup ───────────────────────────────────────────────────────────────────
server.listen(3000, '0.0.0.0', async () => {
  addLog('green', '서버가 시작되었습니다', `Port: 3000`);

  // Check sox + enumerate default input device
  exec('which sox', async (err) => {
    if (err) {
      addLog('red', '마이크를 찾을 수 없습니다', 'sox not installed. Run: brew install sox');
      return;
    }
    const devices = await listAudioDevices();
    if (devices.length === 0) {
      addLog('yellow', '음성이 감지되지 않습니다', '오디오 입력 장치를 찾을 수 없습니다');
      return;
    }
    // Prefer: system default input → Built-in → first device
    const defaultDevice =
      devices.find(d => d.isDefaultInput) ||
      devices.find(d => d.type === 'Built-in') ||
      devices[0];
    selectedAudioDevice = defaultDevice.name;
    addLog('green', '마이크 연결됨', `Device: ${defaultDevice.name} (${defaultDevice.type})`);
    broadcast('status', { selectedAudioDevice });
  });

  // Check API key
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
    addLog('red', 'API 키가 올바르지 않습니다', 'Set OPENAI_API_KEY in .env file');
  }

  addLog('green', 'PIN이 변경되었습니다', `New PIN: ${currentPIN}`);

  await startNgrok();

  // Open control panel
  try {
    const { default: openPkg } = await import('open');
    await openPkg('http://localhost:3000/control');
  } catch (_) {}
});

process.on('SIGINT', () => {
  stopTranslation();
  process.exit();
});
