'use strict';
// Jarvis home-screen app: records what he says, sends it to the Jarvis app service on his Mac, plays the reply.
// No secrets live in this page: the phone's own key is stored on the phone after pairing, and the Mac's current
// address is looked up from his gist (see config.js and ../jarvis_web.py).

const CFG = window.JARVIS_CONFIG || {};
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const S = {
  key: store.get('jarvis.key'),
  base: store.get('jarvis.base'),
  handsFree: store.get('jarvis.handsFree') !== 'off',
  phase: 'idle',
  level: 0,
  conversation: false,
  ctx: null,
  worklet: null,
  rec: null,     // the recording in progress
  playing: null, // the reply being spoken
  wake: null,
};

class Unpaired extends Error {}
class Offline extends Error {}

// For testing on the Mac: http://localhost:8000/?mac=http://127.0.0.1:8788
const devMac = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).get('mac');
const MAC_URL = new RegExp(CFG.macPattern || '^https://[a-z0-9-]+\\.trycloudflare\\.com$');

// --- talking to the Mac ------------------------------------------------------

async function findMac(fresh) {
  if (devMac) return devMac;
  if (!fresh && S.base) return S.base;
  const r = await fetch(`https://api.github.com/gists/${CFG.gistId}`, { cache: 'no-store' });
  if (!r.ok) throw new Offline();
  const url = ((await r.json()).files?.[CFG.gistFile]?.content || '').trim();
  if (!MAC_URL.test(url)) throw new Offline();
  S.base = url;
  store.set('jarvis.base', url);
  return url;
}

async function api(path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (S.key) headers.Authorization = `Bearer ${S.key}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    let base;
    try { base = await findMac(attempt > 0); } catch { throw new Offline(); }
    let r;
    try {
      r = await fetch(base + path, { ...init, headers });
    } catch {
      continue; // the Mac's address may have changed since last time: look it up again
    }
    if (r.status === 401) throw new Unpaired();
    if (r.status === 502 || r.status === 530) continue;
    return r;
  }
  throw new Offline();
}

// --- screen ----------------------------------------------------------------------

const WORDS = { idle: 'Tap to talk', listening: 'Listening…', thinking: 'One moment, sir…', speaking: '' };
const SUBS = { idle: 'Tap to speak', listening: 'I am listening… tap when done', thinking: 'Thinking…', speaking: 'Speaking · tap to interrupt' };

function setPhase(phase, text) {
  S.phase = phase;
  $('app').dataset.phase = phase;
  $('status').textContent = text ?? WORDS[phase];
  $('talkSub').textContent = SUBS[phase];
  $('endBtn').hidden = !S.conversation;
  if (phase !== 'listening' && phase !== 'speaking') setLevel(0);
}

const bars = [];
for (const side of ['waveL', 'waveR']) {
  for (let i = 0; i < 9; i++) bars.push($(side).appendChild(document.createElement('i')));
}
const shape = bars.map((_, i) => 0.35 + 0.65 * Math.abs(Math.sin(i * 1.7)));

function setLevel(v) {
  S.level = Math.min(1, v);
  $('app').style.setProperty('--level', S.level.toFixed(3));
  bars.forEach((b, i) => { b.style.height = `${4 + S.level * 34 * shape[i] * (0.6 + Math.random() * 0.4)}px`; });
}

function addLine(who, text) {
  $('log').querySelector('.empty')?.remove();
  const item = document.createElement('div');
  const ico = document.createElement('i');
  const body = document.createElement('div');
  const p = document.createElement('p');
  const meta = document.createElement('small');
  item.className = `item ${who}`;
  ico.className = 'ico';
  ico.textContent = who === 'you' ? 'YOU' : 'J';
  p.textContent = text;
  meta.textContent = `${who === 'you' ? 'YOU' : 'JARVIS'} · ${new Date().toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  body.append(p, meta);
  item.append(ico, body);
  $('log').prepend(item);
  while ($('log').children.length > 20) $('log').lastChild.remove();
}

function showView() {
  const paired = !!S.key;
  $('pairView').hidden = paired;
  $('talkView').hidden = !paired;
  $('talkbar').hidden = !paired;
  $('settingsBtn').hidden = !paired;
  if (paired) return refreshStatus();
  $('pairCode').focus();
  api('/health').then(() => setSystem('limited', 'AWAITING PAIRING')).catch(() => setSystem('offline', 'MAC OFFLINE'));
}

function problem(e) {
  if (e instanceof Unpaired) {
    S.key = null;
    store.set('jarvis.key', null);
    showView();
    $('pairMsg').textContent = 'This phone needs pairing again.';
    return '';
  }
  if (e instanceof Offline) {
    setSystem('offline', 'MAC OFFLINE');
    return "I can't reach your Mac, sir. Is it on and awake?";
  }
  if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) return 'I need the microphone, sir. Tap and choose Allow.';
  if (e && e.name === 'NotFoundError') return 'No microphone found. Type instead.';
  return 'Something went wrong. Tap to try again.';
}

function tickClock() {
  const now = new Date();
  $('date').textContent = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  $('time').textContent = now.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
}

function setSystem(state, text) {
  $('sysChip').dataset.state = state;
  $('sysText').textContent = text;
}

function gauge(id, pct) {
  const el = $(id);
  el.querySelector('b').textContent = pct == null ? '—' : `${pct}%`;
  el.querySelector('.fill').style.strokeDashoffset = 113.1 * (1 - (pct || 0) / 100);
}

async function refreshStatus() {
  try {
    const d = await (await api('/status')).json();
    setSystem(d.bridge ? 'ok' : 'limited', d.bridge ? 'OPTIMAL' : 'MAC CONTROLS OFF');
    $('stBrain').textContent = `Claude ${d.brain}`;
    $('stVoice').textContent = `Online · ${d.voice}`;
    $('stMac').textContent = d.bridge ? 'Connected' : 'Bridge restarting';
    $('stMac').className = d.bridge ? '' : 'warn';
    $('stMemory').textContent = `${d.memory} exchanges`;
    gauge('gBattery', d.battery);
    gauge('gCpu', d.cpu);
    gauge('gDisk', d.disk);
  } catch (e) {
    if (e instanceof Unpaired) return problem(e);
    setSystem('offline', 'MAC OFFLINE');
    $('stMac').textContent = 'Unreachable';
    $('stMac').className = 'bad';
  }
}

// --- the AI core globe ---------------------------------------------------------------

const globe = (() => {
  const c = $('globe'), g = c.getContext('2d');
  const pts = [];
  for (let i = 0, n = 420; i < n; i++) { // evenly spread points on a sphere
    const y = 1 - (i / (n - 1)) * 2, r = Math.sqrt(1 - y * y), a = i * 2.39996;
    pts.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  const orbits = [[-0.42, 1.38, 0.34, 0.5], [0.3, 1.25, 0.42, -0.35], [1.2, 1.12, 0.26, 0.7]];
  let w = 0, h = 0, dpr = 1, rot = 0, last = 0, level = 0, raf = 0;

  function size() {
    const b = c.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = b.width; h = b.height;
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }

  function frame(t) {
    const dt = Math.min(50, t - last) / 1000;
    last = t;
    const speed = { thinking: 1.4, listening: 0.6, speaking: 0.5 }[S.phase] || 0.22;
    rot += dt * speed * (reducedMotion ? 0.15 : 1);
    level += (S.level - level) * 0.2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.3 * (1 + level * 0.07);

    const halo = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.6);
    halo.addColorStop(0, `rgba(63,208,255,${0.2 + level * 0.3})`);
    halo.addColorStop(0.55, 'rgba(30,120,220,0.08)');
    halo.addColorStop(1, 'rgba(30,120,220,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, w, h);

    for (const [tilt, rx, ry, spd] of orbits) {
      g.save();
      g.translate(cx, cy);
      g.rotate(tilt);
      g.strokeStyle = 'rgba(120,210,255,0.3)';
      g.lineWidth = 1;
      g.beginPath();
      g.ellipse(0, 0, R * rx, R * ry, 0, 0, Math.PI * 2);
      g.stroke();
      const a = (t / 1000) * spd * (reducedMotion ? 0.2 : 1);
      g.fillStyle = '#d6f8ff';
      g.beginPath();
      g.arc(Math.cos(a) * R * rx, Math.sin(a) * R * ry, 2.4, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    const cr = Math.cos(rot), sr = Math.sin(rot), ct = Math.cos(0.38), st = Math.sin(0.38);
    for (const [x, y, z] of pts) {
      const x1 = x * cr - z * sr, z1 = x * sr + z * cr;
      const y2 = y * ct - z1 * st, z2 = y * st + z1 * ct;
      const depth = (z2 + 1) / 2, s = 0.7 + depth * 1.6;
      g.globalAlpha = 0.12 + depth * 0.88;
      g.fillStyle = depth > 0.55 ? '#a8eeff' : '#2c86c4';
      g.fillRect(cx + x1 * R - s / 2, cy + y2 * R - s / 2, s, s);
    }
    g.globalAlpha = 1;

    g.strokeStyle = `rgba(63,208,255,${0.25 + level * 0.6})`;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(cx, cy, R * (1.04 + level * 0.12), 0, Math.PI * 2);
    g.stroke();
    raf = requestAnimationFrame(frame);
  }

  return {
    start() { if (!raf) { size(); raf = requestAnimationFrame((t) => { last = t; frame(t); }); } },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    size,
  };
})();

addEventListener('resize', () => globe.size());

// --- sound -------------------------------------------------------------------------

function unlockAudio() {
  // iPhone only lets a page make sound after a tap, so this runs at the start of every tap.
  if (!S.ctx) S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (S.ctx.state !== 'running') S.ctx.resume();
  if (window.speechSynthesis && !S.voiceUnlocked) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(''));
    S.voiceUnlocked = true;
  }
}

function audioSession(type) {
  try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* older iOS */ }
}

function chime() {
  const t = S.ctx.currentTime, o = S.ctx.createOscillator(), g = S.ctx.createGain();
  o.frequency.setValueAtTime(880, t);
  o.frequency.setValueAtTime(1320, t + 0.07);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.1, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  o.connect(g).connect(S.ctx.destination);
  o.start(t);
  o.stop(t + 0.18);
}

async function keepAwake(on) {
  try {
    if (on && !S.wake && navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen');
    else if (!on && S.wake) { await S.wake.release(); S.wake = null; }
  } catch { /* not supported */ }
}

// Listens until he has spoken and then paused, and returns the audio (or null if he said nothing).
async function record() {
  if (!S.worklet) S.worklet = S.ctx.audioWorklet.addModule('recorder-worklet.js');
  await S.worklet;
  audioSession('play-and-record');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = S.ctx, src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'recorder'), mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute).connect(ctx.destination);
  const frameMs = (1024 / ctx.sampleRate) * 1000;
  const waitMs = S.handsFree ? 9000 : 12000;

  return new Promise((resolve) => {
    const pre = [], chunks = [];
    let noise = null, loudRun = 0, started = false, startedAt = 0, lastLoud = 0, t = 0;
    const rec = {};
    const finish = (keep) => {
      if (S.rec !== rec) return;
      S.rec = null;
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      stream.getTracks().forEach((tr) => tr.stop());
      setLevel(0);
      resolve(keep && started ? chunks : null);
    };
    rec.stop = () => finish(true);
    rec.cancel = () => finish(false);
    S.rec = rec;

    node.port.onmessage = ({ data }) => {
      t += frameMs;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / data.length);
      setLevel(rms * 14);
      if (noise === null) noise = rms;
      const threshold = Math.max(0.01, noise * 3);
      if (!started) {
        pre.push(data);
        if (pre.length > Math.ceil(400 / frameMs)) pre.shift();
        if (t < 250) { noise = noise * 0.8 + rms * 0.2; return; } // learn the room's background noise
        loudRun = rms > threshold ? loudRun + 1 : 0;
        if (loudRun >= 3) {
          started = true;
          startedAt = lastLoud = t;
          chunks.push(...pre);
        } else {
          noise = noise * 0.97 + rms * 0.03;
          if (t > waitMs) finish(false);
        }
        return;
      }
      chunks.push(data);
      if (rms > threshold) lastLoud = t;
      if (t - lastLoud > 1200 || t - startedAt > 30000) finish(true);
    };
  });
}

// 16 kHz mono WAV, which the Mac's speech engine reads directly.
function wav(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0), all = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  const step = rate / 16000, n = Math.floor(total / step), v = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step), b = Math.max(a + 1, Math.min(total, Math.floor((i + 1) * step)));
    let s = 0;
    for (let j = a; j < b; j++) s += all[j];
    const x = Math.max(-1, Math.min(1, s / (b - a)));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([v], { type: 'audio/wav' });
}

async function speak(turn) {
  setPhase('speaking');
  audioSession('playback');
  try {
    if (!turn.audio) throw new Error('no audio');
    const buf = await (await api(`/audio/${turn.id}`)).arrayBuffer();
    const audio = await S.ctx.decodeAudioData(buf);
    await new Promise((resolve) => {
      const src = S.ctx.createBufferSource(), an = S.ctx.createAnalyser(), wave = new Float32Array(512);
      an.fftSize = 512;
      src.buffer = audio;
      src.connect(an).connect(S.ctx.destination);
      let raf = 0;
      const done = () => { cancelAnimationFrame(raf); S.playing = null; resolve(); };
      const pulse = () => {
        an.getFloatTimeDomainData(wave);
        let sum = 0;
        for (const x of wave) sum += x * x;
        setLevel(Math.sqrt(sum / wave.length) * 6);
        raf = requestAnimationFrame(pulse);
      };
      src.onended = done;
      S.playing = { stop: () => { src.onended = null; try { src.stop(); } catch { /* already stopped */ } done(); } };
      src.start();
      pulse();
    });
  } catch {
    await phoneVoice(turn.reply);
  }
}

// Fallback if the Mac's voice didn't come through: the iPhone's own British voice.
function phoneVoice(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices().filter((v) => v.lang === 'en-GB');
    u.voice = voices.find((v) => /Daniel|Arthur|Jamie|Oliver/.test(v.name)) || voices[0] || null;
    u.lang = 'en-GB';
    const timer = setTimeout(done, 30000);
    function done() { clearTimeout(timer); S.playing = null; resolve(); }
    u.onend = u.onerror = done;
    S.playing = { stop: () => { speechSynthesis.cancel(); done(); } };
    speechSynthesis.speak(u);
  });
}

// --- a conversation ----------------------------------------------------------------

// Sends what he said and speaks the reply. Returns 'ok', 'empty', 'end' or 'error'.
async function exchange(init) {
  let turn;
  try {
    const r = await api('/turn', { method: 'POST', ...init });
    turn = await r.json();
    if (!r.ok) throw new Error(turn.error);
    if (!turn.heard) return 'empty';
    addLine('you', turn.heard);
    while (turn.status !== 'done') {
      setPhase('thinking', `${turn.step}…`);
      const p = await api(`/turn/${turn.id}?wait=1`);
      if (!p.ok) throw new Error('expired');
      turn = await p.json();
    }
  } catch (e) {
    stopConversation(problem(e));
    return 'error';
  }
  addLine('jarvis', turn.reply);
  await speak(turn);
  refreshStatus();
  return turn.end ? 'end' : 'ok';
}

async function converse() {
  let misses = 0;
  while (S.conversation) {
    setPhase('listening');
    let chunks;
    try {
      chime();
      chunks = await record();
    } catch (e) {
      return stopConversation(problem(e));
    }
    if (!S.conversation) return;
    let outcome = 'empty';
    if (chunks) {
      setPhase('thinking');
      outcome = await exchange({ body: wav(chunks, S.ctx.sampleRate), headers: { 'Content-Type': 'audio/wav' } });
    }
    if (outcome === 'error') return;
    if (outcome === 'end') return stopConversation('Tap to talk');
    if (outcome === 'empty') {
      if (++misses >= 2 || !S.handsFree) return stopConversation('Standing by, sir. Tap when you need me.');
      continue;
    }
    misses = 0;
    if (!S.handsFree) return stopConversation('Tap to talk');
  }
}

function stopConversation(text) {
  S.conversation = false;
  S.rec?.cancel();
  S.playing?.stop();
  keepAwake(false);
  setPhase('idle', text || WORDS.idle);
}

function onTalk() {
  unlockAudio();
  if (S.phase === 'listening') return S.rec?.stop();     // done talking: send it now
  if (S.phase === 'speaking') return S.playing?.stop();   // interrupt him; hands-free carries on listening
  if (S.phase === 'thinking') return;
  if (!navigator.mediaDevices?.getUserMedia) return setPhase('idle', "This browser can't use the microphone. Type instead.");
  S.conversation = true;
  keepAwake(true);
  converse();
}

async function sendText(text) {
  if (!text || S.phase === 'thinking') return;
  unlockAudio();
  stopConversation('');
  setPhase('thinking');
  const outcome = await exchange({ body: JSON.stringify({ text }), headers: { 'Content-Type': 'application/json' } });
  if (outcome !== 'error') setPhase('idle');
}

$('core').addEventListener('click', onTalk);
$('talkBtn').addEventListener('click', onTalk);
$('endBtn').addEventListener('click', () => stopConversation('Standing by, sir.'));

$('typeBtn').addEventListener('click', () => {
  $('typeForm').hidden = !$('typeForm').hidden;
  if (!$('typeForm').hidden) $('typeInput').focus();
});

$('typeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('typeInput').value.trim();
  $('typeInput').value = '';
  $('typeInput').blur();
  sendText(text);
});

document.querySelectorAll('.cmd').forEach((b) => b.addEventListener('click', () => sendText(b.dataset.say)));

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    globe.stop();
    if (S.conversation || S.phase === 'speaking') stopConversation('Tap to talk');
  } else {
    globe.start();
    if (S.key) refreshStatus();
  }
});

// --- pairing and settings --------------------------------------------------------

$('pairForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('pairCode').value.replace(/\D/g, '');
  const msg = $('pairMsg');
  if (code.length !== 6) { msg.textContent = 'The code is six digits.'; return; }
  msg.textContent = 'Pairing…';
  try {
    const name = /iPad/.test(navigator.userAgent) ? 'iPad' : /iPhone/.test(navigator.userAgent) ? 'iPhone' : 'Browser';
    const r = await api('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
    const d = await r.json();
    if (!r.ok) { msg.textContent = d.error || "That didn't work."; return; }
    S.key = d.key;
    store.set('jarvis.key', d.key);
    msg.textContent = '';
    showView();
    globe.size();
    setPhase('idle', 'Paired. Tap to talk.');
  } catch (err) {
    msg.textContent = err instanceof Offline
      ? "I can't reach your Mac. Is it on, with the Jarvis app service running?"
      : "That didn't work; try again.";
  }
});

$('settingsBtn').addEventListener('click', async () => {
  $('handsFree').checked = S.handsFree;
  $('settingsMsg').textContent = '';
  $('settings').showModal();
  const sel = $('voice');
  try {
    const d = await (await api('/voices')).json();
    sel.replaceChildren(...d.voices.map((name) => new Option(name, name, false, name === d.current)));
  } catch (e) {
    sel.replaceChildren(new Option('Unavailable'));
    $('settingsMsg').textContent = problem(e);
  }
});

$('handsFree').addEventListener('change', (e) => {
  S.handsFree = e.target.checked;
  store.set('jarvis.handsFree', S.handsFree ? 'on' : 'off');
});

$('voice').addEventListener('change', async (e) => {
  try {
    const r = await api('/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: e.target.value }) });
    $('settingsMsg').textContent = r.ok ? `Jarvis will now speak as ${e.target.value}.` : "Couldn't change the voice.";
    if (r.ok) refreshStatus();
  } catch (err) { $('settingsMsg').textContent = problem(err); }
});

$('resetBtn').addEventListener('click', async () => {
  try {
    await api('/reset', { method: 'POST' });
    $('settingsMsg').textContent = 'Fresh conversation started. Your saved preferences stay.';
  } catch (err) { $('settingsMsg').textContent = problem(err); }
});

$('forgetBtn').addEventListener('click', () => {
  S.key = null;
  store.set('jarvis.key', null);
  $('settings').close();
  stopConversation('');
  showView();
});

tickClock();
setInterval(tickClock, 1000);
setInterval(() => { if (S.key && !document.hidden) refreshStatus(); }, 60000);
showView();
setPhase('idle');
globe.start();
