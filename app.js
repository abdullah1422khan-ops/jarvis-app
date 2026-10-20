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

const WORDS = { idle: 'Tap the core to wake me, sir.', paused: "Paused. I'm not listening.", listening: 'Listening…', thinking: 'One moment, sir…', speaking: '' };
const BAR = {
  idle: ['WAKE JARVIS', 'Tap here or the core'],
  paused: ['PAUSED', 'Tap to start listening again'],
  listening: ['LISTENING', 'Just talk, sir · tap to pause'],
  thinking: ['THINKING', 'One moment…'],
  speaking: ['SPEAKING', 'Tap to interrupt'],
};

function setPhase(phase, text) {
  S.phase = phase;
  $('app').dataset.phase = phase;
  $('status').textContent = text ?? WORDS[phase];
  const [title, sub] = BAR[phase === 'idle' && S.paused ? 'paused' : phase];
  $('talkTitle').textContent = title;
  $('talkSub').textContent = sub;
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
  return item;
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
          api('/warm', { method: 'POST' }).catch(() => {}); // wake Claude while he's still talking
        } else {
          noise = noise * 0.97 + rms * 0.03;
        }
        return;
      }
      chunks.push(data);
      if (rms > threshold) lastLoud = t;
      if (t - lastLoud > 1000 || t - startedAt > 30000) finish(true);
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

// Plays one piece of Jarvis's reply (base64 audio from the Mac).
async function speakPart(part) {
  setPhase('speaking');
  audioSession('playback');
  try {
    if (!part.audio) throw new Error('no audio');
    const bytes = Uint8Array.from(atob(part.audio), (c) => c.charCodeAt(0));
    const audio = await S.ctx.decodeAudioData(bytes.buffer);
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
    await phoneVoice(part.text);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sends what he said (or asks for the greeting) and speaks the reply as it arrives, a sentence or two at a time,
// so Jarvis starts talking while the rest is still being prepared. Returns 'ok', 'empty', 'retry' or 'error'.
async function exchange(init, greeting = false) {
  S.interrupted = false;
  let turn, said = null;
  try {
    const r = await api('/turn', { method: 'POST', ...init });
    turn = await r.json();
    if (!r.ok) throw new Error(turn.error);
  } catch (e) {
    return trouble(e);
  }
  if (!greeting) {
    if (!turn.heard) return 'empty';
    said = addLine('you', turn.heard);
  }

  const parts = [...turn.parts];
  let failed = null, wake = null, shown = false;
  const show = () => { if (turn.reply && !shown) { addLine('jarvis', turn.reply); shown = true; } };
  show();
  (async () => {
    while (turn.status !== 'done' && !S.interrupted) {
      const r = await api(`/turn/${turn.id}?have=${turn.have}`);
      if (!r.ok) throw new Error('expired');
      turn = await r.json();
      parts.push(...turn.parts);
      show();
      wake?.();
    }
  })().catch((e) => { failed = e; wake?.(); });

  for (let i = 0; !S.interrupted;) {
    if (i < parts.length) { await speakPart(parts[i++]); continue; }
    if (failed) return trouble(failed);
    if (turn.status === 'done') break;
    setPhase('thinking', `${turn.step}…`);
    await new Promise((resolve) => { wake = resolve; });
    wake = null;
  }
  if (S.interrupted) return 'ok'; // he cut Jarvis short
  if (!turn.reply) said?.remove(); // it wasn't meant for Jarvis (the TV, someone else): leave it out of the feed
  refreshStatus();
  return 'ok';
}

// A problem mid-conversation. Lost pairing stops everything; anything else (say the Mac is briefly unreachable)
// is shown for a moment, then Jarvis carries on listening.
async function trouble(e) {
  const msg = problem(e);
  if (e instanceof Unpaired || !S.conversation) { stopConversation(msg); return 'error'; }
  setPhase('thinking', msg);
  await sleep(4000);
  return 'retry';
}

// Jarvis's side of the call: greet him (the first time the app wakes), then listen and answer, over and over,
// until he pauses it or leaves the app. No tapping needed in between.
async function converse(greet) {
  const me = (S.loop = (S.loop || 0) + 1);
  S.conversation = true;
  S.paused = false;
  keepAwake(true);
  if (greet && (await exchange({ body: JSON.stringify({ greet: true }), headers: { 'Content-Type': 'application/json' } }, true)) === 'error') return;
  while (S.conversation && S.loop === me) {
    setPhase('listening');
    let chunks;
    try {
      chunks = await record();
    } catch (e) {
      return stopConversation(problem(e));
    }
    if (!S.conversation || S.loop !== me) return;
    if (!chunks) continue;
    setPhase('thinking');
    if ((await exchange({ body: wav(chunks, S.ctx.sampleRate), headers: { 'Content-Type': 'audio/wav' } })) === 'error') return;
  }
}

function stopConversation(text) {
  S.conversation = false;
  S.interrupted = true;
  S.rec?.cancel();
  S.playing?.stop();
  keepAwake(false);
  setPhase('idle', text || (S.paused ? WORDS.paused : WORDS.idle));
}

function wake() {
  unlockAudio();
  if (!navigator.mediaDevices?.getUserMedia) return setPhase('idle', "This browser can't use the microphone. Type instead.");
  const greet = !S.greeted;
  S.greeted = true;
  converse(greet);
}

function interrupt() {
  S.interrupted = true;
  S.playing?.stop();
}

async function sendText(text) {
  if (!text || S.phase === 'thinking') return;
  unlockAudio();
  const listening = S.conversation;
  stopConversation('');
  setPhase('thinking');
  if ((await exchange({ body: JSON.stringify({ text }), headers: { 'Content-Type': 'application/json' } })) === 'error') return;
  if (listening) converse(false);
  else setPhase('idle');
}

$('core').addEventListener('click', () => {
  if (!S.conversation) return wake();
  if (S.phase === 'speaking') interrupt();
});

$('talkBtn').addEventListener('click', () => {
  if (!S.conversation) return wake();
  if (S.phase === 'speaking') return interrupt();
  S.paused = true;
  stopConversation();
});

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
    S.resume = S.conversation;
    if (S.conversation || S.phase === 'speaking') stopConversation();
  } else {
    globe.start();
    if (S.key) refreshStatus();
    if (S.resume && S.ctx) { // back in the app: carry on listening, if iPhone allows it without a tap
      S.resume = false;
      S.ctx.resume().then(() => { if (S.ctx.state === 'running' && !S.conversation) converse(false); }).catch(() => {});
    }
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
    setPhase('idle', 'Paired. Tap the core to wake me, sir.');
  } catch (err) {
    msg.textContent = err instanceof Offline
      ? "I can't reach your Mac. Is it on, with the Jarvis app service running?"
      : "That didn't work; try again.";
  }
});

$('settingsBtn').addEventListener('click', async () => {
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
