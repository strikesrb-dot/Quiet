/* Samt app (Quiet Glass UI): setup flows, live session, timer, settings, backup. MODE is 'light' or 'neural'. */
(function () {
  'use strict';
  const S = window.Samt, MODE = window.SAMT_MODE, CFG = window.SAMT_CONFIG || {};
  const { Listener, Teacher, Controller, LevelGate } = S.pipeline;
  const { st } = S.models;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const FAKE = params.has('fakemic');
  const store = S.mic.openStore('samt');
  const blobs = S.mic.openBlobs('samt-rec'); // recordings' audio, in parts
  const K = k => MODE + ':' + k;
  const PASSAGE = [
    "Alright, I'm reading this out loud so the app can learn what my voice sounds like.",
    'On a bright morning in early spring, the market by the river fills with people and noise.',
    'A quick brown fox jumps over the lazy dog while the children laugh and point.',
    'Please remember to bring the blue folder, the charger, and a bottle of cold water.',
    "If the bus is late again, we'll walk the long way past the old stone bridge.",
    'Numbers help too: fourteen, sixty-two, three hundred and five, and nine thousand.',
    'She said the soup was too hot, so he waited a minute before taking a sip.',
    'Every evening I try to sit quietly for a few minutes before I go to sleep.',
    'Which way is shorter, through the park or along the busy main road?',
    'The wind pushed the boat toward the shore, and the sails flapped like loud wings.',
    'I usually wake up early, make some tea, and check the weather before leaving.',
    'Thank you for listening; that should be enough to get started.'
  ];

  /* ---------- settings (per device) ---------- */
  // who: what turns the echo on. 'voice' = Samt's voice check (Your voice); 'level' = anything over the line (Sound level)
  const DEF = { mins: 30, delay: 200, vol: 100, strict: 0, kind: 'silence', limit: 15, noInterrupt: true, nudge: true, who: 'voice' };
  const settings = Object.assign({}, DEF, (() => { try { return JSON.parse(localStorage.getItem('samt.' + MODE + '.settings') || '{}'); } catch (e) { return {}; } })());
  settings.vol = Math.min(100, settings.vol); settings.strict = Math.max(-1, Math.min(1, Math.round(settings.strict))); delete settings.psens;
  settings.mins = Math.max(5, Math.min(960, Math.round(+settings.mins || 30))); settings.kind = settings.kind === 'conversation' ? 'conversation' : 'silence'; settings.limit = Math.max(5, Math.min(60, Math.round(+settings.limit || 15)));
  settings.who = settings.who === 'level' ? 'level' : 'voice';
  const saveSettings = () => { try { localStorage.setItem('samt.' + MODE + '.settings', JSON.stringify(settings)); } catch (e) {} };
  const strictValue = () => settings.strict * 1.6;          // threshold moves by 0.8 of your score spread per step
  // Conversation: talk this long in a turn before the echo; at once when talking over someone; a tone first
  const convParams = () => settings.kind === 'conversation' ? { limit: settings.limit * 100, interrupt: !!settings.noInterrupt, nudge: !!settings.nudge } : { limit: 0, interrupt: false, nudge: false };
  /* Shared by Light and Neural on this device: the budget, the cards, the sign, the reminders switch, and for Sound
     level the line (dB; null = not set yet, so it comes from the setup recordings) and the muted sounds. */
  const LINE_MIN = -66, LINE_MAX = -16, MAX_MUTES = 4;
  const clampLine = v => Math.max(LINE_MIN, Math.min(LINE_MAX, Math.round(v)));
  const okTone = t => t && Number.isFinite(+t.f) && +t.f >= 40 && +t.f <= 7600 && Number.isFinite(+t.q) && +t.q > 0;
  const SDEF = { budget: 20, remind: true, sign: "I'm keeping quiet", cards: [], remindAt: 0, line: null, mutes: [] };
  const shared = Object.assign({}, SDEF, (() => { try { return JSON.parse(localStorage.getItem('samt.shared') || '{}'); } catch (e) { return {}; } })());
  shared.budget = Math.max(5, Math.min(240, Math.round(+shared.budget || 20))); if (!Array.isArray(shared.cards)) shared.cards = [];
  const cleanMutes = list => (Array.isArray(list) ? list : []).filter(m => m && Array.isArray(m.tones) && m.tones.length && m.tones.every(okTone))
    .map(m => ({ id: String(m.id || 'm' + Date.now().toString(36)), kind: ['hum', 'tone', 'whine'].includes(m.kind) ? m.kind : 'tone', tones: m.tones.slice(0, 6).map(t => ({ f: +t.f, q: +t.q })), at: +m.at || 0 })).slice(-MAX_MUTES);
  shared.line = shared.line == null || !Number.isFinite(+shared.line) ? null : clampLine(+shared.line); shared.mutes = cleanMutes(shared.mutes);
  const saveShared = () => { try { localStorage.setItem('samt.shared', JSON.stringify(shared)); } catch (e) {} };
  /* Talk freely: 20 s a tap (up to 60 s at once). Any 3 taps within 10 minutes turn it off for an hour, across sessions
     and in Light and Neural alike (shared.freeTaps: recent tap times; shared.freeLock: when it's back). */
  const FREE_SEC = 20, FREE_MAX = 60, FREE_TAPS = 3, FREE_WINDOW = 10 * 60000, FREE_LOCK = 60 * 60000;
  shared.freeTaps = Array.isArray(shared.freeTaps) ? shared.freeTaps.filter(t => Number.isFinite(+t)).map(Number).slice(-FREE_TAPS) : [];
  shared.freeLock = Number.isFinite(+shared.freeLock) ? +shared.freeLock : 0;
  function freeState() {
    const now = Date.now(); shared.freeTaps = shared.freeTaps.filter(t => now - t < FREE_WINDOW && t <= now);
    return { locked: shared.freeLock > now, lockLeft: Math.max(0, shared.freeLock - now) / 1000, left: FREE_TAPS - shared.freeTaps.length };
  }

  /* ---------- state ---------- */
  const listener = new Listener(), teacher = new Teacher(listener);
  let voice = null, ctrl = null, busy = null, gateTap = null, capture = null; // gateTap: the Sound level gate fed the raw audio
  let profile = { meSegs: [], othSegs: [], adaptSegs: [] };
  let ortSession = null, modelP = null, modelMs = 0;
  let session = null; // {mode, endAt, startedAt, timer, paused}
  let tape = null, tapeWait = false; // the recording running now: {r: Recorder, clip, chain, n, failed}
  let wakeLock = null, lastRec = null, toastTimer = 0, pendingFixes = [], howl = 0, echoHoldUntil = 0, starting = null;
  let history = [], endRec = null, endMood = null, moodCtl = null, showCtx = null, cardsEditing = false, txtResolve = null, strictCtl = null;
  const mic = FAKE ? new S.mic.FakeMic({ onChunk: onAudio }) : new S.mic.MicEngine({ onChunk: onAudio, onTrouble });
  if (FAKE) mic.speed = +(params.get('speed') || 1);
  const debug = window.SamtDebug = { listener, mic, get ctrl() { return ctrl; }, get voice() { return voice; }, get engine() { return mic; }, profile: () => profile, events: [], checkLog: [] };

  const feats = s => ({ n: s.n, vec: s.vec, f0: s.f0, eDb: s.eDb });
  const frames = segs => segs.reduce((a, s) => a + s.n, 0);
  const capSegs = (segs, max) => { while (segs.length > 1 && frames(segs) > max) segs.shift(); return segs; };
  const tick = () => new Promise(r => setTimeout(r, 30));

  function onAudio(c) {
    if (tape) tape.r.add(c); // a recording without MediaRecorder (WAV) keeps going through a held pause: the mic is still on
    if (session && session.paused) return; // a paused session's sound is set aside: no echo, no counting, no clock
    listener.push(c);
    if (gateTap) gateTap.push(c);
    if (capture) capture.add(c);
    // feedback guard: echo open and the mic pinned near full scale = the echo is coming back through a speaker
    if (mic.open) { howl = listener.level > -9 ? howl + 1 : 0; if (howl > 25) { holdEcho(4000); note('The echo was feeding back into the mic, so it stopped for a moment. Use headphones.'); } }
    else howl = 0;
  }
  function holdEcho(ms) { echoHoldUntil = Date.now() + ms; howl = 0; mic.setEcho(false); }
  function setEcho(open) { if (open && Date.now() < echoHoldUntil) return; mic.setEcho(open); }

  /* ---------- small UI pieces ---------- */
  function note(msg) { const n = $('note'); n.textContent = msg || ''; n.hidden = !msg; }
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800); }
  function live(state, text) { const l = $('live'); l.dataset.state = state; $('liveText').textContent = text; }
  function fmt(sec) { const s = Math.max(0, Math.ceil(sec)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; const mm = String(m).padStart(2, '0'), rr = String(r).padStart(2, '0'); return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`; }
  const pad2 = n => String(n).padStart(2, '0');
  function clock(sec) { const s = Math.max(0, Math.floor(sec || 0)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60; return h ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`; }
  function minsText(sec) { const s = Math.floor(sec || 0), m = s / 60; if (m >= 60) { const h = Math.floor(m / 60), r = Math.floor(m % 60); return r ? `${h} hr ${r} min` : `${h} hr`; } return m < 1 ? `${s} s` : m < 10 ? `${(Math.floor(m * 10) / 10).toString()} min` : `${Math.floor(m)} min`; }
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
  const timeStr = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function whenStr(t) {
    const k = dayKey(t), y = new Date(); y.setDate(y.getDate() - 1);
    const day = k === dayKey(Date.now()) ? 'Today' : k === dayKey(y) ? 'Yesterday' : new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
    return `${day}, ${timeStr(t)}`;
  }
  const isAr = s => /[؀-ۿ]/.test(s || '');
  function chevron() { const c = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); c.setAttribute('class', 'ic chev'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-chev'); c.appendChild(u); return c; }
  function micError(err) {
    const n = err && err.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone access is blocked. In Safari, tap the aA button, open Website Settings, set Microphone to Allow, then try again.';
    if (n === 'NotFoundError') return 'No microphone was found. Connect headphones with a mic, or use the iPad mic, then try again.';
    if (n === 'NoMediaDevices') return 'The mic is not available here. Open Samt from its web address in Safari, not from a file preview.';
    if (n === 'AudioNotRunning') return 'Audio did not start. Tap the button again.';
    return 'Could not start the mic (' + (n || 'unknown error') + ').';
  }
  /* The one segmented control. */
  function seg(el, items, value, onPick) {
    el.textContent = ''; el.style.setProperty('--n', items.length);
    const th = document.createElement('span'); th.className = 'th'; th.setAttribute('aria-hidden', 'true'); el.appendChild(th);
    const btns = items.map((it, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = it.label;
      b.onclick = () => { set(it.v); onPick(it.v); }; el.appendChild(b); return b;
    });
    function set(v) { const i = items.findIndex(it => it.v === v); btns.forEach((b, k) => b.setAttribute('aria-checked', k === i ? 'true' : 'false')); th.hidden = i < 0; if (i >= 0) el.style.setProperty('--i', i); }
    set(value); return { set };
  }
  /* The action sheet: anything that can't be undone, and a phrase's choices. */
  let actOpen = null;
  function ask({ title, msg, actions }) {
    $('actTitle').textContent = title || ''; $('actMsg').textContent = msg || ''; $('actMsg').hidden = !msg;
    const rows = $('actRows'); rows.textContent = '';
    for (const a of actions) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'row' + (a.danger ? ' danger' : ''); b.textContent = a.label;
      b.onclick = () => { closeAsk(); a.run(); }; rows.appendChild(b);
    }
    $('actScrim').hidden = false; $('actSheet').hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { $('actScrim').classList.add('show'); $('actSheet').classList.add('show'); }));
    actOpen = true; setTimeout(() => { const f = rows.querySelector('button'); if (f) f.focus({ preventScroll: true }); }, 60);
  }
  function closeAsk() {
    if (!actOpen) return; actOpen = null;
    $('actScrim').classList.remove('show'); $('actSheet').classList.remove('show');
    setTimeout(() => { if (!actOpen) { $('actScrim').hidden = true; $('actSheet').hidden = true; } }, 380);
  }
  /* Sheets that rise from the bottom: the cards, the reminders, a session's end, a line of text. */
  const openSheets = [], closers = {};
  function openSheet(name) {
    const p = $(name + 'Panel'), s = $(name + 'Scrim'); p.hidden = false; s.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => { s.classList.add('show'); p.classList.add('show'); }));
    if (!openSheets.includes(name)) openSheets.push(name);
    s.onclick = () => (closers[name] || (() => closeSheet(name)))();
    setTimeout(() => { const f = p.querySelector('.sheet-head button'); if (f && !p.contains(document.activeElement)) f.focus({ preventScroll: true }); }, 80);
  }
  function closeSheet(name) {
    const p = $(name + 'Panel'), s = $(name + 'Scrim'); p.classList.remove('show'); s.classList.remove('show');
    const i = openSheets.indexOf(name); if (i >= 0) openSheets.splice(i, 1);
    setTimeout(() => { if (!openSheets.includes(name)) { p.hidden = true; s.hidden = true; } }, 520);
  }
  /* A line of text (the sign's own words). Resolves to the text, or null if cancelled. */
  function promptText({ title, value, max }) {
    return new Promise(res => {
      if (txtResolve) txtResolve(null);
      txtResolve = res; $('txtTitle').textContent = title; const f = $('txtField'); f.value = value || ''; f.maxLength = max || 80;
      openSheet('txt'); setTimeout(() => f.focus(), 350);
    });
  }
  function endText(save) { const r = txtResolve; txtResolve = null; closeSheet('txt'); if (r) r(save ? $('txtField').value.trim() : null); }
  closers.txt = () => endText(false);
  /* The press: tint at once on touch-down, sink if small; spring back on release; a 10 px move is a scroll. */
  (function press() {
    let cur = null, x0 = 0, y0 = 0;
    const end = () => { if (cur) { cur.classList.remove('is-press', 'sink'); cur = null; } };
    document.addEventListener('pointerdown', e => {
      const el = e.target.closest('button, a.btn'); if (!el || el.disabled || el.closest('[data-nopress]')) return;
      el.classList.add('pressable', 'is-press'); const r = el.getBoundingClientRect(); if (r.width <= 360 && r.height <= 140) el.classList.add('sink');
      cur = el; x0 = e.clientX; y0 = e.clientY;
    }, { passive: true });
    document.addEventListener('pointermove', e => { if (cur && Math.hypot(e.clientX - x0, e.clientY - y0) > 10) end(); }, { passive: true });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave', 'blur']) (t === 'blur' ? window : document).addEventListener(t, end, { passive: true });
  })();

  /* ---------- theme: Auto follows the iPad; Day / Night are fixed ---------- */
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const themePref = () => { try { return localStorage.getItem('samt.theme') || 'auto'; } catch (e) { return 'auto'; } };
  function applyTheme() { const t = themePref(); document.body.classList.toggle('theme-dark', t === 'night' || (t === 'auto' && !!(mq && mq.matches))); }
  if (mq) { try { mq.addEventListener('change', applyTheme); } catch (e) { try { mq.addListener(applyTheme); } catch (e2) {} } }

  /* ---------- mic ---------- */
  /* Starts the mic. prime() runs synchronously so the AudioContext resumes inside the tap. */
  function ensureMic() {
    if (mic.live) { mic.prime(); return Promise.resolve(mic); }
    if (starting) return starting;
    mic.prime();
    starting = mic.start().then(() => { starting = null; mic.setDelay(settings.delay / 1000); mic.setVolume(settings.vol / 100); mic.setNotches(allTones()); startMeter(); return mic; }, e => { starting = null; throw e; });
    return starting;
  }
  function releaseMic() { mic.stop(); $('level').style.transform = 'scaleX(0)'; }
  let meterOn = false;
  function startMeter() {
    if (meterOn) return; meterOn = true;
    const loop = () => {
      if (!mic.live) { meterOn = false; return; }
      // Sound level: the bar shows what the gate measures (muted pitches cut) and turns dark while it's over the line
      const g = gateTap, lv = session && session.paused ? -90 : g ? g.level : listener.level, x = Math.max(0, Math.min(1, (lv + 70) / 55));
      $('level').style.transform = `scaleX(${x.toFixed(3)})`; $('level').parentNode.classList.toggle('over', !!(g && lv >= g.p.line));
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  function onTrouble(kind) {
    if (kind === 'device') { if (session) { holdEcho(2000); toast('Audio output changed. Keep your headphones on so the echo cannot feed back.'); } return; }
    if (kind === 'unmuted') return;
    // interrupted (call, Siri, lock, app switch), muted, or ended: stop the echo at once and ask for a tap
    mic.setEcho(false);
    if (tape) endTape('cut'); // a recording keeps what it has
    if (capture) cancelMute('The mic stopped. Try again.'); // listening to a sound to mute
    if (session && !session.paused) pauseSession(false);
    else if (rec && (rec.kind === 'me' || rec.kind === 'oth')) {
      // a call or Siri mid-reading: keep what was read, wait for Resume
      if (!rec.paused) { rec.paused = true; $('recHint').textContent = 'Paused. What you read so far is kept. Tap Resume to keep going.'; $('recResume').hidden = false; }
    }
    else if (rec) { rec.finish(true); note('The mic stopped. Try again.'); }
    else if (echoTest) endEchoTest('stopped');
  }
  async function resumeAudio() {
    if (!session) return;
    requestWake(); mic.prime();
    if (session.holdPause && micOk()) { endPause(); return; } // a held pause: the mic never stopped
    try {
      if (!mic.trackLive()) { mic.stop(); await ensureMic(); }
      else if (!(await mic.resume())) throw Object.assign(new Error('x'), { name: 'AudioNotRunning' });
      const left = ctrl ? ctrl.passLeft() : 0; // Talk freely's time left, read before the Listener's frames start again
      if (FAKE) session.fakeSec = (session.fakeSec || 0) + listener.fs.nFrames / 100; // the test mic's audio time so far
      listener.reset(); if (ctrl && ctrl.resync) ctrl.resync(left);
      endPause();
    } catch (e) { note(micError(e)); }
  }

  /* ---------- storage ---------- */
  async function saveAll() {
    const ok = await store.set(K('profile'), profile);
    if (voice && voice.ready) await store.set(K('voice'), voice.toJSON());
    if (!ok) toast("Couldn't save the setup on this device.");
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }
  async function loadAll() {
    const [p, v] = await Promise.all([store.get(K('profile')), store.get(K('voice'))]);
    if (p) profile = Object.assign({ meSegs: [], othSegs: [], adaptSegs: [] }, p);
    if (v) { try { voice = MODE === 'light' ? S.LightVoice.fromJSON(v) : S.NeuralVoice.fromJSON(v); } catch (e) { voice = null; } }
    if (voice && MODE === 'neural' && ortSession) voice.attach(window.ort, ortSession);
  }
  /* Past sessions: one list for Light and Neural (same device, same store), newest last. */
  async function loadHistory() { const h = await store.get('shared:history'); history = Array.isArray(h) ? h.filter(r => r && r.id && r.at) : []; }
  async function putRecord(rec) {
    await loadHistory();
    const i = history.findIndex(r => r.id === rec.id);
    if (i >= 0) history[i] = Object.assign({}, history[i], rec); else history.push(rec);
    history.sort((a, b) => a.at - b.at); history = capHistory(history);
    await store.set('shared:history', history);
  }
  /* The 500 newest sessions, and any older one that still has recordings (its audio would be lost with it). */
  function capHistory(h) { let drop = h.length - 500; return drop > 0 ? h.filter(r => { if (drop > 0 && !(r.clips && r.clips.length)) { drop--; return false; } return true; }) : h; }
  async function dropRecord(id) { await loadHistory(); history = history.filter(r => r.id !== id); await store.set('shared:history', history); }
  function backup() {
    // phrases: none recorded; the field is there only so a v6 page (which expects it) can still restore this file
    const data = { app: 'samt', mode: MODE, version: 4, saved: new Date().toISOString(), settings, profile: S.mic.pack(profile), voice: voice && voice.ready ? S.mic.pack(voice.toJSON()) : null,
      phrases: S.mic.pack(new S.pipeline.PhraseBook().toJSON()), shared: { budget: shared.budget, remind: shared.remind, sign: shared.sign, cards: shared.cards, line: shared.line, mutes: shared.mutes }, history };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `samt-${MODE}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function restore(file) {
    try {
      const d = JSON.parse(await file.text());
      if (!d || d.app !== 'samt') throw new Error("This isn't a Samt backup file.");
      if (d.mode !== MODE) throw new Error(`This backup is from Samt ${d.mode === 'neural' ? 'Neural' : 'Light'}. Open that version to restore it.`);
      profile = Object.assign({ meSegs: [], othSegs: [], adaptSegs: [] }, S.mic.unpack(d.profile)); // an older backup's phrases are left out
      voice = d.voice ? (MODE === 'light' ? S.LightVoice.fromJSON(S.mic.unpack(d.voice)) : S.NeuralVoice.fromJSON(S.mic.unpack(d.voice))) : null;
      if (voice && MODE === 'neural' && ortSession) voice.attach(window.ort, ortSession);
      if (d.shared && typeof d.shared === 'object') {
        if (d.shared.budget) shared.budget = Math.max(5, Math.min(240, Math.round(+d.shared.budget) || 20));
        if (typeof d.shared.remind === 'boolean') shared.remind = d.shared.remind;
        if (typeof d.shared.sign === 'string' && d.shared.sign.trim()) shared.sign = d.shared.sign.slice(0, 60);
        if (Array.isArray(d.shared.cards)) shared.cards = d.shared.cards.filter(c => typeof c === 'string' && c.trim()).map(c => c.slice(0, 120)).slice(-24);
        if (d.shared.line != null && Number.isFinite(+d.shared.line)) shared.line = clampLine(+d.shared.line);
        if (Array.isArray(d.shared.mutes)) { shared.mutes = cleanMutes(d.shared.mutes); applyMutes(); }
        saveShared();
      }
      if (Array.isArray(d.history)) {
        await loadHistory(); const ids = new Set(history.map(r => r.id));
        for (const r of d.history) if (r && typeof r.id === 'string' && +r.at > 0 && !ids.has(r.id)) history.push(r);
        history.sort((a, b) => a.at - b.at); history = capHistory(history); await store.set('shared:history', history);
      }
      await saveAll(); render(); renderHistory(); renderToday(); toast('Setup restored.');
    } catch (e) { note(e.message || "Couldn't read that file."); }
  }

  /* ---------- neural model ---------- */
  async function fetchProgress(url, onP) {
    const res = await fetch(url); if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = +res.headers.get('content-length') || 0;
    if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());
    const rd = res.body.getReader(), parts = []; let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onP(total ? got / total : 0, got); }
    const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  function loadModel() {
    if (MODE !== 'neural') return Promise.resolve(null);
    if (modelP) return modelP;
    const st = $('modelStatus');
    modelP = (async () => {
      if (typeof window.ort === 'undefined') throw new Error('engine');
      window.ort.env.wasm.wasmPaths = CFG.ortBase; window.ort.env.wasm.numThreads = 1;
      st.textContent = 'Downloading';
      const bytes = await fetchProgress(CFG.modelUrl, (p, got) => { st.textContent = p ? `Downloading ${Math.round(p * 100)}%` : `Downloading ${(got / 1048576).toFixed(1)} MB`; });
      st.textContent = 'Starting';
      ortSession = await window.ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      const warm = new S.NeuralVoice(); warm.attach(window.ort, ortSession);
      const probe = new Float32Array(16240).map((_, i) => Math.sin(i / 9) * 0.05);
      await warm.embed(probe); const t0 = performance.now(); await warm.embed(probe); modelMs = performance.now() - t0;
      if (voice) voice.attach(window.ort, ortSession);
      st.textContent = 'Ready'; render(); return ortSession;
    })().catch(e => {
      st.textContent = 'Not loaded';
      note(e.message === 'engine' ? "Couldn't load the voice engine. Check your internet connection, then reload." : "Couldn't load the voice model (" + e.message + '). If this keeps happening, close this tab and open Samt in a new one.');
      modelP = null; render(); throw e;
    });
    return modelP;
  }

  /* ---------- teaching ---------- */
  let rec = null; // the open recording sheet
  function openPanel({ title, passage, hint }) {
    $('recTitle').textContent = title;
    const p = $('recPassage'); p.hidden = !passage; p.textContent = passage || '';
    $('recHint').textContent = hint || ''; $('recProg').style.transform = 'scaleX(0)';
    $('recDone').textContent = 'Done'; $('recDone').disabled = true; $('recResume').hidden = true;
    if ($('recPanel').hidden) {
      $('recScrim').hidden = false; $('recPanel').hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => { $('recScrim').classList.add('show'); $('recPanel').classList.add('show'); }));
    }
  }
  function closePanel() {
    $('recScrim').classList.remove('show'); $('recPanel').classList.remove('show');
    setTimeout(() => { if (!rec) { $('recScrim').hidden = true; $('recPanel').hidden = true; } }, 520);
  }
  function teachVoice(kind, opts) {
    opts = opts || {};
    if (busy) return;
    if (MODE === 'neural' && !ortSession) { note('The voice model is still loading.'); return; }
    const started = ensureMic(); // first, inside the tap
    note(''); setBusy(kind === 'me' ? 'voice' : 'others');
    const target = kind === 'me' ? 45 : 30, min = kind === 'me' ? 20 : 10;
    openPanel(kind === 'me'
      ? { title: voice && voice.ready && !opts.fresh ? 'Read this out loud again' : 'Read this out loud in your normal voice', passage: PASSAGE.join(' '), hint: 'Starting the mic' }
      : { title: 'Let other voices talk', passage: 'Play a video or podcast, put a call on speaker, or ask someone to talk near the iPad for about 30 seconds. Stay quiet yourself.', hint: 'Starting the mic' });
    rec = { kind };
    const finish = async (cancel) => {
      if (!rec || rec.kind !== kind) return; rec = null;
      const segs = teacher.end(); closePanel(); releaseMic();
      if (cancel || !segs.length) { setBusy(null); return; }
      await learn(kind, segs, opts);
    };
    rec.finish = finish;
    started.then(() => {
      if (!rec || rec.kind !== kind) return;
      listener.reset();
      $('recHint').textContent = `Listening. 0 of ${target} seconds of speech`;
      teacher.begin({
        withSamples: MODE === 'neural',
        onSegment: (seg, segs) => {
          const secs = frames(segs) / 100;
          $('recProg').style.transform = `scaleX(${Math.min(1, secs / target).toFixed(3)})`;
          $('recHint').textContent = `Listening. ${Math.floor(secs)} of ${target} seconds of speech` + (secs < min ? '' : '. Tap Done when you finish.');
          $('recDone').disabled = secs < min;
          if (secs >= target + 10) finish(false);
        }
      });
    }, e => { rec = null; closePanel(); setBusy(null); note(micError(e)); });
  }
  async function learn(kind, segs, opts) {
    opts = opts || {};
    setBusy('learning');
    live('busy', kind === 'me' ? 'Learning your voice' : 'Learning other voices');
    await tick();
    try {
      const f = segs.map(feats);
      if (kind === 'me' && opts.fresh) { profile.meSegs = capSegs(f, 18000); profile.adaptSegs = []; }
      else if (kind === 'me') profile.meSegs = capSegs(profile.meSegs.concat(f), 18000);
      else profile.othSegs = capSegs(profile.othSegs.concat(f), 9000);
      if (MODE === 'light') {
        const v = opts.fresh || !voice ? new S.LightVoice() : voice;
        v.train(profile.meSegs.concat(profile.adaptSegs), profile.othSegs); voice = v;
      } else {
        const prog = p => live('busy', `${kind === 'me' ? 'Learning your voice' : 'Learning other voices'} ${Math.round(p * 100)}%`);
        if (kind === 'me' && (opts.fresh || !voice || !voice.ready)) {
          const v = new S.NeuralVoice(); v.attach(window.ort, ortSession); await v.train(segs, [], prog);
          if (opts.fresh && voice && voice.N && voice.N.length) v.addNegativeEmbs(voice.N); // keep what it knows about other voices
          voice = v;
        }
        else if (kind === 'me') await voice.addPositive(segs, prog);
        else await voice.addNegative(segs, prog);
      }
      await saveAll();
      if (wiz.check) { wiz.check.stale = true; saveWiz(); } // the last check was of the voice before this
      toast(kind === 'me' ? 'Learned your voice.' : 'Learned what other voices sound like.');
    } catch (e) { note(e.message || String(e)); }
    live('off', 'Ready'); setBusy(null);
    if (kind === 'me' && wantEchoTest && voice && voice.ready) { wantEchoTest = false; openEchoTest(); } // setup's last step
  }
  /* ---------- Sound level: the line, and muted sounds ---------- */
  /* Where the line starts before it's set: between your reading and the other voices from the setup if they're apart,
     else 10 dB under your reading; -40 dB with no setup. In 2 dB steps, like the − and + buttons. */
  function defaultLine() {
    const loud = segs => { const a = []; for (const s of segs || []) { const e = s && s.eDb; if (e) for (let i = 0; i < e.length; i++) if (e[i] > -55) a.push(e[i]); } return a.length >= 50 ? st.median(a) : null; };
    const me = loud(profile.meSegs), oth = loud(profile.othSegs);
    const v = me == null ? -40 : oth != null && me - oth >= 6 ? (me + oth) / 2 : me - 10;
    return clampLine(2 * Math.round(v / 2));
  }
  const lineNow = () => shared.line != null ? shared.line : defaultLine();
  const holdFrames = () => Math.round((settings.delay + 150) / 10); // outlasts the echo's delay, so a word's end isn't cut
  function setLine(v) {
    shared.line = clampLine(v); saveShared();
    for (const g of [ctrl, check && check.ctrl]) if (g && g.kind === 'level') g.p.line = shared.line;
    renderLine();
  }
  function renderLine() {
    const v = lineNow(), x = Math.max(0, Math.min(1, (v + 70) / 55));
    $('lineMark').style.left = (100 * x).toFixed(1) + '%';
    $('lineSr').textContent = `Line ${Math.round((v - LINE_MIN) / 2) + 1} of ${(LINE_MAX - LINE_MIN) / 2 + 1}`;
    $('lineDown').disabled = v <= LINE_MIN; $('lineUp').disabled = v >= LINE_MAX;
  }
  const allTones = () => [].concat(...shared.mutes.map(m => m.tones));
  function applyMutes() {
    const t = allTones(); mic.setNotches(t); if (gateTap) gateTap.setNotches(t);
    if (wiz.check && wiz.check.who === 'level') { wiz.check.stale = true; saveWiz(); } // the line now measures differently
  }
  const MUTE_KIND = { hum: 'Low hum', tone: 'Steady tone', whine: 'Whine' };
  const MUTE_SEC = 3;
  /* Mute a sound: listen 3 s while it plays and you're quiet, find its steady pitches, cut them from the echo and the
     level. A sound spread over every pitch has none, and nothing is saved. In a session the echo stays shut meanwhile. */
  function muteSound() {
    if (capture || shared.mutes.length >= MAX_MUTES || (!session && busy) || (session && session.paused)) return;
    const inSession = !!session, started = inSession ? Promise.resolve() : ensureMic(); // the mic starts inside the tap
    if (!inSession) setBusy('mute');
    const k = capture = { inSession, parts: [], n: 0, add(c) { if (this.n < MUTE_SEC * 16000) { this.parts.push(Float32Array.from(c)); this.n += c.length; } } };
    $('muteGo').disabled = true; $('muteProg').parentNode.hidden = false; $('muteProg').style.transform = 'scaleX(0)';
    $('muteResult').textContent = 'Stay quiet. Listening to the sound…'; $('muteResult').className = 'cstatus';
    started.then(() => {
      if (capture !== k) return;
      if (inSession) holdEcho(MUTE_SEC * 1000 + 800);
      const t0 = Date.now();
      k.timer = setInterval(() => {
        $('muteProg').style.transform = `scaleX(${Math.min(1, k.n / (MUTE_SEC * 16000)).toFixed(3)})`;
        if (k.n >= MUTE_SEC * 16000) finishMute(k);
        else if (Date.now() - t0 > (MUTE_SEC + 4) * 1000) cancelMute("The sound stopped reaching Samt before it had 3 seconds. Try again."); // the audio stopped coming
      }, 100);
    }, e => { if (capture === k) capture = null; if (!inSession) setBusy(null); $('muteProg').parentNode.hidden = true; $('muteResult').textContent = micError(e); renderMutes(); });
  }
  /* Stop listening without muting anything: the mic stopped, the session ended, or the sheet was closed. */
  function cancelMute(msg) {
    const k = capture; if (!k) return; capture = null; clearInterval(k.timer);
    if (!k.inSession) { releaseMic(); setBusy(null); }
    $('muteProg').parentNode.hidden = true; $('muteResult').textContent = msg || ''; $('muteResult').className = 'cstatus';
    renderMutes();
  }
  function finishMute(k) {
    clearInterval(k.timer); if (capture === k) capture = null;
    const inSession = k.inSession;
    if (!inSession) { releaseMic(); setBusy(null); }
    $('muteProg').parentNode.hidden = true;
    const raw = new Float32Array(k.n); let o = 0; for (const p of k.parts) { raw.set(p, o); o += p.length; }
    const x = S.dsp.applyNotches(raw, allTones()), skip = 3200; // what Samt hears now, with the sounds already muted
    const before = S.dsp.levelDb(x, skip), tones = before > -62 ? S.dsp.findTones(x.subarray(skip)) : [];
    const after = tones.length ? S.dsp.levelDb(S.dsp.applyNotches(x, tones), skip) : before;
    let msg, good = false;
    if (before <= -62) msg = "Samt didn't hear a sound to mute. Try again while it's going.";
    else if (!tones.length || before - after < 3) msg = "That sound is spread over every pitch, so cutting it would cut your voice too. Nothing was muted. Raise the line above it instead.";
    else {
      const top = tones[0].f, kind = top < 300 ? 'hum' : top < 2000 ? 'tone' : 'whine';
      shared.mutes = shared.mutes.concat([{ id: 'm' + Date.now().toString(36), kind, tones, at: Date.now() }]).slice(-MAX_MUTES); saveShared(); applyMutes();
      good = true;
      msg = settings.who !== 'level' ? 'Muted. The echo no longer plays it.'
        : after < lineNow() ? 'Muted. It now sits under your line, so it no longer turns the echo on.'
        : "Muted, but it's still over your line. Raise the line a little.";
    }
    $('muteResult').textContent = msg; $('muteResult').className = 'cstatus' + (good ? ' good' : '');
    renderMutes(); render();
  }
  function renderMutes() {
    const box = $('muteList'); box.textContent = '';
    for (const m of shared.mutes) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'row';
      const t = document.createElement('span'); t.className = 'rt'; t.textContent = MUTE_KIND[m.kind] || 'A sound';
      const s2 = document.createElement('span'); s2.className = 'r2'; s2.textContent = m.tones.map(x => Math.round(x.f)).join(' · ') + ' Hz'; t.appendChild(s2);
      b.append(t, chevron());
      b.onclick = () => ask({ title: MUTE_KIND[m.kind] || 'This sound', msg: 'Unmute it? It will reach the echo again.', actions: [{ label: 'Unmute', danger: true, run: () => { shared.mutes = shared.mutes.filter(x => x.id !== m.id); saveShared(); applyMutes(); renderMutes(); render(); } }] });
      box.appendChild(b);
    }
    box.hidden = !shared.mutes.length; $('muteNone').hidden = !!shared.mutes.length;
    const full = shared.mutes.length >= MAX_MUTES;
    $('muteGo').disabled = !!capture || full || (!session && !!busy) || !!(session && session.paused); $('muteFull').hidden = !full;
  }
  function openMutes() { $('muteResult').textContent = ''; $('muteProg').parentNode.hidden = true; renderMutes(); openSheet('mute'); }
  closers.mute = () => { if (capture) cancelMute(''); closeSheet('mute'); };

  /* ---------- session ---------- */
  const MAX_MINS = 960; // sessions run up to 16 hours (and "Until a time" up to 16 hours away)
  function untilMs() {
    const until = $('until').value; if (!until) return null;
    const [h, m] = until.split(':').map(Number), t = new Date(); t.setHours(h, m, 0, 0); if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return t.getTime() - Date.now();
  }
  function plannedMs() {
    const u = untilMs();
    return u != null ? Math.min(u, MAX_MINS * 60000) : Math.max(1, Math.min(MAX_MINS, settings.mins)) * 60000;
  }
  /* A length in words for the stepper: 45 min, 2 hr, 8 hr 15 min. */
  const lenText = m => m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr` + (m % 60 ? ` ${m % 60} min` : '');
  /* A time readout; hours and over get the smaller hero size so 16:00:00 fits a phone. */
  function setReadout(el, sec) { const t = fmt(sec); el.textContent = t; el.classList.toggle('long', t.length > 5); }
  function stateText(e) {
    const test = session && session.mode === 'test';
    if (session && session.who === 'level') {
      if (e.state === 'echo') return ['echo', test ? 'Over the line. The echo would be on' : 'Over the line. Echo on'];
      if (e.state === 'hold') return ['hold', 'Over the line'];
      if (e.state === 'other') return ['other', 'Under the line. Ignored'];
      return ['on', test ? 'Testing. Listening' : 'Listening'];
    }
    if (e.state === 'echo') {
      const over = !!(ctrl && ctrl.seg && ctrl.seg.interrupt);
      return ['echo', over ? (test ? 'Talking over someone. The echo would be on' : 'Talking over someone. Echo on') : (test ? 'You. The echo would be on' : 'You. Echo on')];
    }
    if (e.state === 'other') return ['other', 'Someone else. Ignored'];
    if (e.state === 'holding') return ['hold', 'Hearing speech'];
    return ['on', test ? 'Testing. Listening' : 'Listening'];
  }
  let phraseShowUntil = 0;
  function onEvent(e) {
    if (debug.events.length < 4000) debug.events.push(Object.assign({ t: +(listener.fs.nFrames / 100).toFixed(2) }, e));
    if (session && session.paused) return;
    if (e.type === 'state') {
      if (ctrl && ctrl.passLeft() > 0) return; // the pill shows the free-talk countdown
      if (performance.now() < phraseShowUntil && e.state !== 'echo') return;
      const [s, t] = stateText(e); live(s, t);
    }
    else if (e.type === 'nudge') { live('hold', session && session.mode === 'test' ? 'A nudge would play now' : 'Nudge: time to wrap up'); phraseShowUntil = performance.now() + 2000; renderCounts(); }
    else if (e.type === 'interrupt') renderCounts();
    else if (e.type === 'segment') { lastRec = e.rec; renderCounts(); renderLast(); }
  }
  function renderCounts() {
    const c = ctrl ? ctrl.counts : { talk: 0, talkTime: 0, short: 0, other: 0, interrupt: 0, nudge: 0 };
    $('cTalk').textContent = c.talk; $('cTalkTime').textContent = clock(c.talkTime);
    $('cShort').textContent = c.short; $('cOther').textContent = c.other;
    $('cInt').textContent = c.interrupt || 0; $('cNudge').textContent = c.nudge || 0;
    $('nudgeRow').hidden = (session ? session.kind : settings.kind) !== 'conversation';
    // Sound level can't tell short replies or talking over someone; its "others" are stretches under the line
    const lv = (session ? session.who : settings.who) === 'level';
    $('shortRow').hidden = $('intRow').hidden = lv;
    $('tlHint').textContent = lv ? 'You and Others: talking over the line, and under it.' : 'You and Others: how much of the talking Samt heard was you.';
    $('muteStatus2').textContent = shared.mutes.length ? String(shared.mutes.length) : 'None';
    renderTL();
  }
  /* You and others: the share of the talking Samt heard that was you (the current stretch included). */
  function renderTL() {
    let me = 0, ot = 0;
    if (ctrl && ctrl.counts) {
      me = ctrl.counts.meSec; ot = ctrl.counts.otherSec;
      const g = ctrl.seg;
      if (g && g.cred) { const n = Math.max(0, (g.next - g.since) / 100); me += g.cred.me / 100 + (g.speaker === 'me' ? n : 0); ot += g.cred.other / 100 + (g.speaker === 'other' ? n : 0); }
    }
    const tot = me + ot, you = tot >= 1 ? Math.round(100 * me / tot) : null;
    $('tlMe').textContent = you == null ? '–' : you + '%'; $('tlOth').textContent = you == null ? '–' : (100 - you) + '%';
    $('tlBar').style.width = (you || 0) + '%';
  }
  function renderLast() {
    const r = lastRec;
    if (!r || (session && session.who === 'level')) { $('last').hidden = true; return; } // corrections teach the voice check only
    const who = r.speaker === 'me' ? 'You' : r.speaker === 'other' ? 'Someone else' : 'Not sure';
    const what = r.echo ? 'echoed' : r.passes.length ? 'passed' : r.speaker === 'other' ? 'ignored' : 'let through';
    $('lastText').textContent = `${who}, ${what}, ${((r.end - r.start + 1) / 100).toFixed(1)} s`;
    const can = !!(r.data || r.samples || (r.embs && r.embs.length));
    $('wasMe').disabled = !can || r.speaker === 'me'; $('notMe').disabled = !can || r.speaker === 'other';
    $('last').hidden = false;
  }
  async function applyFix(r, isMe) {
    if (MODE === 'light') {
      if (!r.data) return false;
      if (isMe) profile.adaptSegs = capSegs(profile.adaptSegs.concat([feats(r.data)]), 20000); else profile.othSegs = capSegs(profile.othSegs.concat([feats(r.data)]), 9000);
      return 'retrain';
    }
    let embs = r.embs || [];
    if (r.samples && r.samples.length > 16000 * 0.6) { const e = await voice.embed(r.samples); if (e) embs = embs.concat([e]); }
    if (!embs.length) return false;
    if (isMe) voice.adapt(embs); else voice.addNegativeEmbs(embs);
    return true;
  }
  async function correct(isMe) {
    const r = lastRec; if (!r || busy === 'learning') return;
    r.speaker = isMe ? 'me' : 'other'; renderLast();
    if (session) { pendingFixes.push({ r, isMe }); toast(isMe ? 'Got it. Samt will learn that after this session.' : 'Got it. Samt will learn that after this session.'); return; }
    setBusy('learning'); live('busy', 'Learning'); await tick();
    try { const res = await applyFix(r, isMe); if (res === 'retrain') voice.train(profile.meSegs.concat(profile.adaptSegs), profile.othSegs); await saveAll(); toast(isMe ? 'Got it. That was you.' : 'Got it. That was someone else.'); }
    catch (e) { note(e.message || String(e)); }
    live('off', 'Ready'); setBusy(null);
  }
  const voiceUsable = () => !!(voice && voice.ready) && (MODE !== 'neural' || !!ortSession);
  /* What decides the echo: the voice check (Your voice) or the line (Sound level). counts and lastMeEnd carry a
     running session's numbers over when it switches. */
  function makeJudge(mode, counts, lastMeEnd) {
    const m = mode === 'test' ? 'test' : 'silence', onNudge = () => { if (mic.chime) mic.chime(); };
    if (settings.who === 'level') {
      const g = new LevelGate({ listener, onEcho: setEcho, onEvent, onNudge, params: Object.assign({ line: lineNow(), hold: holdFrames() }, convParams()) });
      g.setNotches(allTones()); g.start(m, counts, lastMeEnd); gateTap = g; return g;
    }
    gateTap = null; voice.strict = strictValue();
    const c = new Controller({ listener, voice, book: null, onEcho: setEcho, onEvent, onNudge, params: convParams() });
    c.start(m, counts, lastMeEnd); return c;
  }
  /* Your voice / Sound level, from Home or mid-session. A running session keeps its numbers and its Talk freely. */
  function setWho(v) {
    if (v === settings.who) return;
    if (v === 'voice' && !voiceUsable()) { syncWho(); toast(voice && voice.ready ? 'The voice model is still loading.' : 'Teach Samt your voice first.'); return; }
    settings.who = v; saveSettings();
    if (session && ctrl && !session.paused) {
      const counts = ctrl.counts, left = ctrl.passLeft();
      try { if (ctrl.seg) ctrl.cut(); } catch (e) {} // closing the stretch still going can move "last talked" on
      const last = ctrl.lastMeEnd;
      if (ctrl.adaptQueue && ctrl.adaptQueue.length) session.adaptQ = session.adaptQ.concat(ctrl.adaptQueue);
      ctrl.stop(); setEcho(false);
      ctrl = makeJudge(session.mode, counts, last);
      if (left > 0) ctrl.pass(left, true);
      session.who = v; if (v === 'level') session.usedLevel = true;
      lastRec = null; renderLast(); renderCounts(); renderLine();
      live('on', session.mode === 'test' ? 'Testing. Listening' : 'Listening');
    }
    syncWho(); render();
  }
  let whoCtl = null, sWhoCtl = null; // the two pickers: Home's and the session screen's (render() enables them)
  function syncWho() {
    for (const c of [whoCtl, sWhoCtl]) if (c) c.set(settings.who);
    const lv = (session ? session.who : settings.who) === 'level';
    document.body.classList.toggle('lv-mode', lv);
    for (const id of ['lineDown', 'lineUp', 'lineMark']) $(id).hidden = !lv;
    if (lv) renderLine();
  }
  function startSession(mode) {
    if (busy) return;
    const lv = settings.who === 'level';
    if (!lv && (!voice || !voice.ready)) { note('Teach Samt your voice first, or pick Sound level.'); return; }
    if (!lv && MODE === 'neural' && !ortSession) { note('The voice model is still loading. Sound level works now.'); return; }
    requestWake();                 // inside the tap, before anything waits
    const started = ensureMic();
    note(''); setBusy(mode);
    started.then(() => {
      listener.reset();
      ctrl = makeJudge(mode);
      const now = Date.now();
      session = { mode, kind: settings.kind, who: settings.who, usedLevel: lv, adaptQ: [], startedAt: now, endAt: mode === 'test' ? null : now + plannedMs(), paused: false, bestQuiet: 0, recId: 's' + now.toString(36), savedAt: now, uiAt: 0, warned: 0, passing: false };
      syncWho();
      lastRec = null; renderLast(); renderCounts(); enterSession(); render();
      if (mode !== 'test') showSessionReminder(); else $('remind').hidden = true;
      session.timer = setInterval(tickSession, 250); tickSession();
    }, e => { setBusy(null); releaseWake(); note(micError(e)); });
  }
  /* A session's clock stands still while it's paused: pausedAt is when the pause began, pauseMs the pauses before it. */
  const sessionNow = s => s.paused && s.pausedAt ? s.pausedAt : Date.now();
  const activeMs = s => Math.max(0, sessionNow(s) - s.startedAt - (s.pauseMs || 0));
  /* The session as a record for the past-sessions list (null for a test). With the test mic, the length is audio time. */
  function sessionSnap() {
    const s = session; if (!s || s.mode === 'test' || !ctrl) return null;
    const c = ctrl.counts;
    const out = { id: s.recId, at: s.startedAt, dur: FAKE ? Math.round((s.fakeSec || 0) + listener.fs.nFrames / 100) : Math.round(activeMs(s) / 1000), page: MODE, kind: s.kind, who: s.usedLevel ? 'level' : 'voice', talkTime: +c.talkTime.toFixed(2), meSec: +c.meSec.toFixed(2), otherSec: +c.otherSec.toFixed(2),
      talks: c.talk, interrupts: c.interrupt, nudges: c.nudge, freePass: c.freePass, shorts: c.short, others: c.other, bestQuiet: Math.round(s.bestQuiet) };
    if (s.clipN) out.clips = (s.clips || []).map(x => Object.assign({}, x)); // its recordings (the audio is in blobs); [] once the only one was dropped
    return out;
  }
  function tickSession() {
    if (!session) return;
    // a held pause: the time until the echo is back, then back by itself (if a call took the mic meanwhile, it waits for Resume)
    if (session.paused && session.holdPause) {
      const p = pauseLeft();
      if (p > 0) live('paused', `Echo back in ${clock(Math.ceil(p))}`);
      else if (micOk()) endPause();
      else { session.holdPause = false; live('paused', 'Paused. Tap Resume.'); render(); }
    }
    if (session.endAt) { const left = (session.endAt - sessionNow(session)) / 1000; setReadout($('sReadout'), left); if (left <= 0 && !session.paused && !session.stopping) { stopSession(true); return; } }
    else setReadout($('sReadout'), activeMs(session) / 1000);
    if (tape) { const sec = tape.r.sec(); tape.clip.dur = Math.round(sec); $('sRecText').textContent = clock(sec); if (!tape.rolling && (sec >= ROLL_SEC || tape.clip.bytes >= ROLL_BYTES)) rollTape(); }
    if (!ctrl || session.paused) return;
    // the quiet timer: since your last words (or since the start)
    const g = ctrl.seg, talking = ctrl.talking ? ctrl.talking() : !!(g && g.speaker === 'me');
    const quiet = talking ? 0 : Math.max(0, ((ctrl.frameNow ? ctrl.frameNow() : listener.fs.nFrames) - ctrl.lastMeEnd) / 100);
    session.bestQuiet = Math.max(session.bestQuiet, quiet);
    $('quietLine').firstChild.textContent = talking ? 'Talking' : 'Quiet for '; $('quietFor').textContent = talking ? '' : clock(quiet);
    // talk freely: the time until the echo is back on the pill; on the button, adding 20 s and how many taps are left,
    // or when Talk freely is back
    const left = ctrl.passLeft(), fs = freeState();
    if (tape || session.echoOff) { $('pass').textContent = session.echoOff ? 'Turn the echo back on' : 'Turn the echo off'; $('pass').disabled = false; } // while recording: no limit
    else {
      $('pass').textContent = fs.locked ? `Talk freely in ${clock(fs.lockLeft)}`
        : (left > 0 ? `Add ${FREE_SEC} s` : `Talk freely, ${FREE_SEC} s`) + (fs.left < FREE_TAPS ? ` · ${fs.left} left` : '');
      $('pass').disabled = fs.locked;
    }
    if (session.echoOff) { live('pass', 'Echo off'); session.passing = true; }
    else if (left > 0) { live('pass', `Echo back in ${clock(Math.ceil(left))}`); session.passing = true; }
    else if (session.passing) { session.passing = false; live('on', 'Listening'); }
    renderTL(); $('cTalkTime').textContent = clock(ctrl.counts.talkTime);
    if (session.mode === 'test') return;
    const now = Date.now();
    if (now - session.uiAt >= 1000) { session.uiAt = now; renderToday(true); budgetWarn(); }
    if (now - session.savedAt >= 30000) { session.savedAt = now; listNow(session); } // in case the tab is closed
  }
  function budgetWarn() {
    const m = dayTotals(), t = (m.get(dayKey(Date.now())) || { talk: 0 }).talk, bud = shared.budget * 60;
    if (session.warned < 1 && t >= bud * 0.8 && t < bud) { session.warned = 1; toast(`${clock(bud - t)} of talk left in today's budget.`); }
    if (session.warned < 2 && t >= bud) { session.warned = 2; toast("You've used today's talk budget."); }
  }
  async function stopSession(finished) {
    if (!session || session.stopping) return;
    if (tape || tapeEnd) { session.stopping = true; render(); try { await (tape ? endTape('end') : tapeEnd); } catch (e) {} if (!session) return; } // the recording's last part first
    if (ctrl && ctrl.seg) { try { ctrl.cut(); } catch (e) {} } // count the words still in progress
    if (capture && capture.inSession) cancelMute(''); // the session's mic is about to stop
    const snap = sessionSnap(), adaptQ = session.adaptQ.concat(ctrl && ctrl.adaptQueue ? ctrl.adaptQueue : []), listed = !!session.listed; // Sound level adds no adaptQ
    clearInterval(session.timer); session = null;
    if (ctrl) ctrl.stop(); gateTap = null; syncWho();
    releaseMic(); if (!showCtx) releaseWake();
    const c = ctrl ? ctrl.counts : { talk: 0 };
    $('remind').hidden = true; leaveSession();
    refreshReadout(); setBusy(null);
    live(finished ? 'done' : 'off', finished ? `Done. You talked ${c.talk} time${c.talk === 1 ? '' : 's'}.` : 'Stopped');
    // keep the session (30 seconds or longer, or with a recording) and open its summary
    if (snap && (snap.dur >= 30 || (snap.clips && snap.clips.length))) {
      snap.open = false;
      try { await putRecord(snap); } catch (e) {}
      renderHistory(); renderToday();
      openEnd(history.find(r => r.id === snap.id) || snap, false);
    }
    else if (snap && listed) { try { await dropRecord(snap.id); } catch (e) {} renderHistory(); renderToday(); } // listed early, but too short to keep
    // keep learning: speech that was confidently you, plus any That was me / Not me from this session
    const q = adaptQ, fixes = pendingFixes.splice(0);
    if ((q.length || fixes.length) && voice) {
      setBusy('learning'); await tick();
      try {
        let retrain = false;
        for (const f of fixes) if ((await applyFix(f.r, f.isMe)) === 'retrain') retrain = true;
        if (MODE === 'light') { const add = q.filter(r => r.data).map(r => feats(r.data)); if (add.length) { profile.adaptSegs = capSegs(profile.adaptSegs.concat(add), 20000); retrain = true; } if (retrain) voice.train(profile.meSegs.concat(profile.adaptSegs), profile.othSegs); }
        else { const embs = [].concat(...q.map(r => r.embs || [])); if (embs.length) voice.adapt(embs.slice(-60)); }
        await saveAll();
      } catch (e) {}
      setBusy(null);
      live(finished ? 'done' : 'off', finished ? `Done. You talked ${c.talk} time${c.talk === 1 ? '' : 's'}.` : 'Stopped');
    }
  }
  /* Paused: the echo stops and the clock stands still. From a hold on the main button (byHold: the mic is let go too,
     and Resume starts it again inside its tap), or from a call, Siri or the screen locking. Resume carries on; End
     session finishes it. */
  function pauseSession(byHold) {
    if (!session || session.paused || session.stopping) return;
    session.paused = true; session.pausedAt = Date.now(); session.holdPause = !!byHold;
    if (ctrl) { try { ctrl.cut(); } catch (e) {} }
    mic.setEcho(false); if (capture && capture.inSession) cancelMute('');
    live('paused', byHold ? `Echo back in ${clock(PAUSE_SEC)}` : 'Paused. Tap Resume.'); render();
    setTimeout(() => { if (session && session.paused) $('resume').focus({ preventScroll: true }); }, 60);
  }
  /* A held pause lasts PAUSE_SEC at most, then the echo comes back by itself. The mic keeps running through it (its
     sound is set aside), because iPhone Safari won't reliably start a mic again without a tap. */
  const PAUSE_SEC = 60;
  const pauseLeft = () => session && session.holdPause ? Math.max(0, PAUSE_SEC - (Date.now() - session.pausedAt) / 1000) : 0;
  const micOk = () => mic.running && mic.trackLive();
  /* The pause is over: the clock carries on from where it stopped (a pause doesn't count toward the session's time). */
  function endPause() {
    if (!session || !session.paused) return;
    const d = Date.now() - session.pausedAt; session.pauseMs = (session.pauseMs || 0) + d; if (session.endAt) session.endAt += d;
    session.pausedAt = 0; session.paused = false; session.holdPause = false;
    note(''); live('on', session.mode === 'test' ? 'Testing. Listening' : 'Listening'); render();
  }
  /* Talk freely: 20 s more without the echo; the third tap within 10 minutes still counts, then it's off for an hour. */
  function talkFreely() {
    if (!ctrl || !session || session.mode === 'test' || session.paused) return;
    if (freeState().locked) return;
    const now = Date.now(); shared.freeTaps.push(now);
    const third = shared.freeTaps.length >= FREE_TAPS;
    if (third) { shared.freeLock = now + FREE_LOCK; shared.freeTaps = []; }
    saveShared();
    ctrl.pass(Math.min(FREE_MAX, ctrl.passLeft() + FREE_SEC)); tickSession();
    if (third) toast('That was 3 in 10 minutes: Talk freely is off for an hour after this one.');
  }
  /* ---------- recording a session: the mic only (you and anyone near you), never the echo; kept on this device ---------- */
  const ECHO_OFF_SEC = 24 * 3600; // "echo off" is a Talk freely with no end that isn't counted as a tap
  let ROLL_SEC = 3600, ROLL_BYTES = 60e6; // a long recording carries on in a new file each hour (or 60 MB): each stays easy to play and save
  let tapeEnd = null; // a recording being put away: ending the session waits for it
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function startTape(roll) {
    if (!session || session.mode === 'test' || tape || tapeWait || tapeEnd || session.stopping) return;
    if (session.paused && !session.holdPause) { if (!roll) toast('Tap Resume first.'); return; }
    const stream = mic.recStream ? mic.recStream() : null; // inside the tap
    tapeWait = true; render();
    try {
      let room = Infinity;
      try { const e = navigator.storage && navigator.storage.estimate ? await Promise.race([navigator.storage.estimate(), wait(2000).then(() => null)]) : null; if (e && e.quota) room = e.quota - (e.usage || 0); } catch (e) {}
      if (room < 25e6) { toast(roll ? 'This device is nearly out of room, so the recording stopped.' : 'Not enough room on this device to record.'); return; }
      const s = session; if (!s || s.stopping || tape || (s.paused && !s.holdPause)) return;
      const t = { r: null, clip: null, recId: s.recId, chain: Promise.resolve(), n: 0, failed: null, ended: false, settled: false, dropped: false };
      const opts = { onPart: d => keepPart(t, d), onEnd: () => { if (tape === t) endTape('cut'); } };
      try { t.r = new S.mic.Recorder(stream, opts); } catch (e) { t.r = new S.mic.Recorder(null, opts); } // MediaRecorder said no: WAV
      s.clipN = (s.clipN || 0) + 1; // a clip's id is never used twice, even after a too-short one is dropped
      t.clip = { id: `${s.recId}.${s.clipN}`, mime: t.r.mime, parts: 0, bytes: 0, dur: 0, at: Date.now(), done: false };
      (s.clips = s.clips || []).push(t.clip); tape = t;
      listNow(s); // listed at once, in case the tab closes
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
    } catch (e) { toast("Couldn't start recording on this device."); }
    finally { tapeWait = false; render(); if (session) tickSession(); }
  }
  /* The running session as it stands, into the past-sessions list (marked open), in case the tab is closed. */
  function listNow(s) { if (!s || s !== session || s.stopping) return; const snap = sessionSnap(); if (snap) { s.listed = true; putRecord(Object.assign(snap, { open: true })).catch(() => {}); } }
  /* A part to disk, in order; if one can't be saved, the recording stops with what it has. */
  function keepPart(t, d) {
    const c = t.clip, key = `${c.id}:${String(t.n++).padStart(5, '0')}`;
    t.chain = t.chain.then(async () => {
      if (t.failed || t.dropped) return;
      const buf = d instanceof ArrayBuffer ? d : await (d.arrayBuffer ? d.arrayBuffer() : new Response(d).arrayBuffer());
      await blobs.put(key, buf); c.parts++; c.bytes += buf.byteLength;
      if (t.settled) saveClip(t); // it came in after the recording was put away (a slow browser): update the listing
    }).catch(e => { if (!t.failed) { t.failed = e || new Error('not saved'); if (tape === t) endTape(e && e.name === 'QuotaExceededError' ? 'full' : 'fail'); } });
  }
  /* A clip's latest numbers into its session's listing, once that session isn't running any more. */
  async function saveClip(t) {
    if (session && session.recId === t.recId && !session.stopping) return; // the running session's next save carries them
    try {
      await loadHistory(); const r = history.find(x => x.id === t.recId);
      if (r && Array.isArray(r.clips) && r.clips.some(x => x.id === t.clip.id)) await putRecord({ id: r.id, at: r.at, clips: r.clips.map(x => x.id === t.clip.id ? Object.assign({}, t.clip) : x) });
    } catch (e) {}
  }
  /* Stops the recording and keeps it (why: '' a tap, 'end' the session is ending, 'roll' going on in a new file, 'cut'
     the mic stopped, 'full' / 'fail' a part couldn't be saved). The echo comes back, except when it rolls on. Ending the
     session waits for this (tapeEnd), so the listing always has the recording's last part and length. */
  function endTape(why) {
    const t = tape; if (!t) return tapeEnd || Promise.resolve();
    tape = null; t.ended = true;
    const s = session;
    if (why !== 'roll' && s && s.echoOff) setEchoOff(false);
    const p = (async () => {
      try { await t.r.stop(); } catch (e) {}
      const settled = await Promise.race([t.chain.then(() => true, () => true), wait(8000).then(() => false)]);
      const c = t.clip, sec = t.r.sec();
      c.dur = Math.round(sec); c.done = true;
      // kept unless it's under a second, or the browser said it was done and nothing came (if it didn't say, parts may still come)
      const kept = sec >= 1 && (c.parts > 0 || !t.r.confirmed || !settled);
      if (!kept) { t.dropped = true; if (s && s.clips) s.clips = s.clips.filter(x => x !== c); blobs.del(c.id).catch(() => {}); }
      t.settled = true;
      listNow(s);
      if (s && s === session) tickSession();
      const say = { '': kept ? 'Recording saved. It shows with this session when the session ends.' : 'Too short to keep.',
        cut: 'The mic stopped, so the recording did too.' + (kept ? ' What it got is kept.' : ''),
        full: 'This device is out of room, so the recording stopped.' + (kept ? ' What it got is kept.' : ''),
        fail: "Couldn't save the recording on this device, so it stopped." }[why];
      if (say) toast(say);
      return kept;
    })().finally(() => { if (tapeEnd === p) tapeEnd = null; render(); });
    tapeEnd = p; render();
    return p;
  }
  /* A long recording rolls on into a new file; the echo stays as it was. */
  async function rollTape() {
    const t = tape; if (!t || t.rolling) return; t.rolling = true;
    await endTape('roll');
    if (session && !session.stopping) await startTape(true);
    if (!tape && session && session.echoOff) setEchoOff(false); // it couldn't go on: the echo comes back, as when a recording stops
  }
  /* While recording, Talk freely's button turns the echo off and on, with no limit: no echo and no nudges, and your
     talk still counts. Turning it back on gives back any Talk freely time that was left. */
  const frameNow = () => ctrl && ctrl.frameNow ? ctrl.frameNow() : listener.fs.nFrames;
  function setEchoOff(off) {
    if (!session || !ctrl || !!session.echoOff === !!off) return;
    session.echoOff = !!off;
    if (off) { session.freeEnd = frameNow() + Math.round(ctrl.passLeft() * 100); ctrl.pass(ECHO_OFF_SEC, true); }
    else { ctrl.pass(Math.max(0, ((session.freeEnd || 0) - frameNow()) / 100), true); session.freeEnd = 0; }
    if (!off && !session.paused && !(ctrl.passLeft() > 0)) { session.passing = false; live('on', 'Listening'); }
    tickSession();
  }
  /* A session's recordings in its sheet: play, save to a file, delete. A clip is put together from its parts when asked. */
  let recUrls = [];
  function stopPlayers() {
    $('endRecs').querySelectorAll('audio').forEach(a => { try { a.pause(); a.removeAttribute('src'); a.load(); } catch (e) {} });
    for (const u of recUrls) URL.revokeObjectURL(u); recUrls = [];
  }
  async function clipBlob(c) {
    const parts = await blobs.parts(c.id);
    if (!parts || !parts.length) return null;
    if (c.mime === 'audio/wav') return new Blob([S.mic.wavHeader(parts.reduce((a, p) => a + p.byteLength, 0)), ...parts], { type: 'audio/wav' });
    return new Blob(parts, { type: c.mime || 'audio/mp4' });
  }
  const clipExt = m => m === 'audio/wav' ? 'wav' : /webm/.test(m || '') ? 'webm' : 'm4a';
  function clipName(c) { const d = new Date(c.at); return `samt-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.${clipExt(c.mime)}`; }
  const sizeText = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e5) / 10 + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  function renderRecs(r) {
    stopPlayers();
    const box = $('endRecs'), clips = Array.isArray(r.clips) ? r.clips.filter(c => c && c.id) : [];
    box.textContent = ''; box.hidden = $('capRecs').hidden = $('recsHint').hidden = !clips.length;
    clips.forEach((c, i) => {
      const row = document.createElement('div'); row.className = 'row';
      const t = document.createElement('span'); t.className = 'rt'; t.textContent = clips.length > 1 ? `Recording ${i + 1}` : 'Recording';
      const s2 = document.createElement('span'); s2.className = 'r2'; s2.textContent = `${timeStr(c.at)} · ${sizeText(+c.bytes || 0)}${c.done ? '' : ' · cut off'}`; t.appendChild(s2);
      const v = document.createElement('span'); v.className = 'rv'; v.textContent = clock(c.dur);
      row.append(t, v);
      const bar = document.createElement('div'); bar.className = 'row btns';
      const btn = (label, fn, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn plain' + (cls ? ' ' + cls : ''); b.textContent = label; b.onclick = fn; bar.appendChild(b); return b; };
      let urlP = null;
      const ready = () => urlP || (urlP = clipBlob(c).then(b => { if (!b) { urlP = null; return null; } const u = URL.createObjectURL(b); recUrls.push(u); asLink(u); return u; }, () => { urlP = null; return null; }));
      // once the audio is put together, Save is a plain link to it, so a tap saves it straight away (iPhone wants the tap)
      const asLink = u => { const a = document.createElement('a'); a.className = 'btn plain'; a.href = u; a.download = clipName(c); a.textContent = 'Save'; if (save.parentNode) save.replaceWith(a); };
      const missing = () => { s2.textContent = "This recording isn't on this device."; play.disabled = save.disabled = true; };
      const play = btn('Play', async () => {
        play.disabled = true;
        const u = await ready(); if (!u) { missing(); return; }
        const a = document.createElement('audio'); a.controls = true; a.preload = 'metadata';
        const go = () => { a.play().catch(() => {}); };
        // a recording without a length in it (Chrome's): seek to the end once so the player can show one
        a.addEventListener('loadedmetadata', () => {
          if (a.duration !== Infinity) { go(); return; }
          a.addEventListener('timeupdate', function back() { a.removeEventListener('timeupdate', back); a.currentTime = 0; go(); });
          a.currentTime = 1e7;
        }, { once: true });
        a.src = u;
        const p = document.createElement('div'); p.className = 'row player'; p.appendChild(a); bar.after(p); play.remove();
      });
      const save = btn('Save', async () => {
        save.disabled = true; // one at a time
        const u = await ready(); if (!u) { missing(); return; }
        const link = bar.querySelector('a[download]'); if (link) link.click();
      });
      btn('Delete', () => ask({ title: 'Delete this recording?', msg: "It's deleted from this device. A copy you saved stays.", actions: [{ label: 'Delete', danger: true, run: () => deleteClip(r, c) }] }), 'danger');
      box.append(row, bar);
      blobs.count(c.id).then(n => { if (!n) missing(); }).catch(() => {});
    });
  }
  async function deleteClip(r, c) {
    stopPlayers();
    try { await blobs.del(c.id); } catch (e) {}
    r.clips = (r.clips || []).filter(x => x.id !== c.id);
    try { await putRecord({ id: r.id, at: r.at, clips: r.clips }); } catch (e) {}
    if (endRec === r) renderRecs(r);
    renderHistory(); toast('Recording deleted.');
  }
  /* Parts that no past session lists (a session dropped from the list, or one deleted on another page) go after a day.
     Only when the list itself was read, so a failed read never takes recordings with it. */
  async function sweepTapes() {
    try {
      const h = await store.get('shared:history'); if (!Array.isArray(h) || !h.length) return;
      const keep = new Set(); for (const r of h) for (const c of (r && r.clips) || []) keep.add(c.id);
      const old = new Set();
      for (const k of await blobs.keys()) {
        const id = String(k).split(':')[0]; if (keep.has(id) || old.has(id) || (tape && tape.clip.id === id)) continue;
        const at = parseInt(id.slice(1), 36); if (at > 0 && Date.now() - at > 864e5) old.add(id);
      }
      for (const id of old) await blobs.del(id);
    } catch (e) {}
  }
  async function requestWake() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { wakeLock = null; } }
  function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !mic.live) return;
    if (!mic.running || !mic.trackLive()) onTrouble('interrupted');
  });

  /* ---------- today: talk time against the daily budget, the week, past sessions ---------- */
  const MOODS = { easy: 'Easy', okay: 'Okay', hard: 'Hard' };
  function allRecs() { const snap = sessionSnap(), list = history.filter(r => !snap || r.id !== snap.id); if (snap) list.push(snap); return list; }
  function dayTotals() {
    const m = new Map();
    for (const r of allRecs()) { const k = dayKey(r.at), d = m.get(k) || { talk: 0, n: 0 }; d.talk += +r.talkTime || 0; d.n++; m.set(k, d); }
    return m;
  }
  /* Days in a row (to today, or to yesterday if there's no session yet today) with sessions and talk within the budget. */
  function streakDays(m) {
    let n = 0; const d = new Date(); if (!m.has(dayKey(d))) d.setDate(d.getDate() - 1);
    for (let g = 0; g < 1000; g++) { const x = m.get(dayKey(d)); if (!x || x.talk > shared.budget * 60) break; n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  let weekDays = [], weekSel = 6;
  function renderToday(quick) {
    const m = dayTotals(), talk = Math.floor((m.get(dayKey(Date.now())) || { talk: 0 }).talk), bud = shared.budget * 60, over = talk > bud;
    $('todayTalk').textContent = clock(talk); $('todayBudget').textContent = clock(bud);
    $('todayLeft').textContent = over ? `Over by ${clock(talk - bud)}` : `${clock(bud - talk)} left`;
    $('budgetBar').style.width = Math.min(100, 100 * talk / bud).toFixed(1) + '%'; $('budgetTrack').classList.toggle('over', over);
    $('budgetOut').textContent = shared.budget + ' min';
    const n = streakDays(m); $('streak').textContent = n === 1 ? '1 day' : `${n} days`;
    const tl = $('todayLine'), b = document.createElement('b'); b.textContent = clock(talk); tl.textContent = ''; tl.classList.toggle('over', over);
    tl.append('Today: ', b, over ? ` talk, over the ${clock(bud)} budget` : ` of ${clock(bud)} talk`);
    $('progressStatus').textContent = n ? (n === 1 ? '1 day in budget' : `${n} days in budget`) : '';
    renderWeek(m, quick);
  }
  function renderWeek(m, quick) {
    const plot = $('weekPlot'), bud = shared.budget * 60, now = new Date(), days = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i), x = m.get(dayKey(d)) || { talk: 0, n: 0 }; days.push({ d, talk: x.talk, n: x.n }); }
    const max = Math.max(bud * 1.25, 60, ...days.map(x => x.talk));
    let cols = plot.querySelectorAll('.wk-col');
    if (cols.length !== 7) {
      for (let i = 0; i < 7; i++) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'wk-col';
        const bar = document.createElement('i'); bar.className = 'wk-bar'; b.appendChild(bar);
        b.onclick = () => { weekSel = i; plot.classList.add('touched'); renderWeekSel(); };
        b.onpointerenter = e => { if (e.pointerType === 'mouse') { weekSel = i; plot.classList.add('touched'); renderWeekSel(); } };
        plot.appendChild(b);
      }
      cols = plot.querySelectorAll('.wk-col');
    }
    days.forEach((x, i) => {
      const bar = cols[i].firstChild; bar.classList.toggle('none', !x.n);
      bar.style.height = x.n ? Math.max(1.5, 100 * x.talk / max).toFixed(1) + '%' : '0';
      cols[i].setAttribute('aria-label', `${x.d.toLocaleDateString([], { weekday: 'long' })}: ${x.n ? minsText(x.talk) + ' of talk' : 'no sessions'}`);
    });
    $('weekBudget').style.bottom = (100 * bud / max).toFixed(1) + '%';
    const key = dayKey(now) + '|' + days.map(x => x.n + ':' + Math.round(x.talk)).join(',');
    if (!quick || $('weekDays').dataset.key !== dayKey(now)) {
      const lab = $('weekDays'); lab.textContent = ''; lab.dataset.key = dayKey(now);
      days.forEach((x, i) => { const s = document.createElement('span'); s.textContent = x.d.toLocaleDateString([], { weekday: 'short' }); if (i === 6) s.className = 'today'; lab.appendChild(s); });
    }
    if (!quick || $('weekTable').dataset.key !== key) {
      const tb = $('weekTable'); tb.textContent = ''; tb.dataset.key = key;
      const cap = document.createElement('caption'); cap.textContent = 'Talk time, last 7 days'; tb.appendChild(cap);
      for (const x of days) { const tr = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td'); th.textContent = x.d.toDateString(); td.textContent = x.n ? minsText(x.talk) : 'no sessions'; tr.append(th, td); tb.appendChild(tr); }
    }
    weekDays = days; renderWeekSel();
  }
  function renderWeekSel() {
    const x = weekDays[weekSel]; if (!x) return;
    $('weekPlot').querySelectorAll('.wk-col').forEach((c, i) => c.setAttribute('aria-pressed', String(i === weekSel)));
    const el = $('weekSel'); el.textContent = (weekSel === 6 ? 'Today' : x.d.toLocaleDateString([], { weekday: 'long' })) + ': ';
    const b = document.createElement('b'); b.textContent = x.n ? minsText(x.talk) : 'no sessions'; el.appendChild(b);
  }
  function renderHistory() {
    const box = $('histList'); box.textContent = '';
    const live = session && session.recId; // the session running now is not a past one yet
    const all = history.filter(r => r.id !== live).sort((a, b) => b.at - a.at);
    const list = all.slice(0, 30).concat(all.slice(30).filter(r => r.clips && r.clips.length)); // the 30 newest, and older ones with recordings
    if (!list.length) {
      box.innerHTML = '<div class="empty"><span class="tile soft" aria-hidden="true"><svg class="ic"><use href="#i-hush"/></svg></span><b>No sessions yet</b><span>Each session you finish shows here, with how much you talked.</span></div>';
      return;
    }
    for (const r of list) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'row';
      const t = document.createElement('span'); t.className = 'rt'; t.textContent = whenStr(r.at);
      const s2 = document.createElement('span'); s2.className = 'r2'; s2.textContent = `${r.kind === 'conversation' ? 'Conversation' : 'Silence'}${r.who === 'level' ? ' · Sound level' : ''} · ${minsText(r.dur)}${MOODS[r.mood] ? ' · ' + MOODS[r.mood] : ''}${r.clips && r.clips.length ? ' · Recorded' : ''}`; t.appendChild(s2);
      const v = document.createElement('span'); v.className = 'rv'; v.textContent = clock(r.talkTime) + ' talk';
      b.append(t, v, chevron()); b.onclick = () => openEnd(r, true); box.appendChild(b);
    }
    const clr = document.createElement('button'); clr.type = 'button'; clr.className = 'row danger'; clr.textContent = 'Clear the past sessions';
    clr.onclick = () => ask({ title: 'Clear the past sessions?', msg: 'Every past session on this device is deleted, with its recordings, for Light and Neural. Your voice setup stays.',
      actions: [{ label: 'Clear them', danger: true, run: async () => {
        await loadHistory(); const gone = [].concat(...history.map(r => r.clips || []));
        history = []; await store.set('shared:history', []);
        for (const c of gone) await blobs.del(c.id).catch(() => {});
        renderHistory(); renderToday(); toast('Cleared.');
      } }] });
    box.appendChild(clr);
  }

  /* ---------- a session's end: the numbers, a mood, a note, and Claude's summary if asked for ---------- */
  const CLAUDE_HINT = "Sends this session's numbers, your mood and your note to Claude. Your voice and the audio stay on this device.";
  function openEnd(rec, review) {
    if (endRec && endRec !== rec) { // another session's sheet was still open: keep what was typed there
      const prev = endRec; prev.note = $('endNote').value.trim().slice(0, 300); prev.mood = endMood;
      putRecord({ id: prev.id, at: prev.at, mood: prev.mood, note: prev.note, summary: prev.summary || '' }).catch(() => {});
    }
    endRec = rec; endMood = rec.mood || null;
    $('endTitle').textContent = review ? whenStr(rec.at) : 'Session done';
    const st = $('endStats'); st.textContent = '';
    const tot = (+rec.meSec || 0) + (+rec.otherSec || 0), you = tot >= 1 ? Math.round(100 * rec.meSec / tot) : null;
    const rows = [['Kind', rec.kind === 'conversation' ? 'Conversation' : 'Silence'], ['Echo by', rec.who === 'level' ? 'Sound level' : 'Your voice'], ['Length', clock(rec.dur)], ['Talk time', clock(rec.talkTime)],
      ['You and others', you == null ? 'No talking heard' : `You ${you}% · Others ${100 - you}%`], ['Longest quiet', clock(rec.bestQuiet)], ['Times echoed', String(rec.talks || 0)]];
    if (rec.interrupts) rows.push(['Talked over someone', String(rec.interrupts)]);
    if (rec.kind === 'conversation') rows.push(['Nudges', String(rec.nudges || 0)]);
    if (rec.freePass) rows.push(['Talk freely taps', String(rec.freePass)]);
    for (const [a, b] of rows) { const r = document.createElement('div'); r.className = 'row'; const x = document.createElement('span'); x.className = 'rt'; x.textContent = a; const y = document.createElement('span'); y.className = 'rv'; y.textContent = b; r.append(x, y); st.appendChild(r); }
    moodCtl.set(endMood); $('endNote').value = rec.note || '';
    showSummary(rec.summary);
    $('askClaude').disabled = false; $('askClaude').textContent = rec.summary ? 'Ask Claude again' : 'Ask Claude for a summary';
    $('claudeHint').textContent = CLAUDE_HINT; $('endDelete').hidden = !review;
    $('endTip').hidden = !!review || rec.who === 'level' || !(rec.others > 0) || !!profile.othSegs.length || !!(voice && voice.N && voice.N.length);
    renderRecs(rec);
    openSheet('end');
  }
  function showSummary(t) { $('endSummary').hidden = !t; $('endSummaryText').textContent = t || ''; }
  async function closeEnd() {
    const r = endRec; endRec = null; stopPlayers(); closeSheet('end');
    if (!r) return;
    r.note = $('endNote').value.trim().slice(0, 300); r.mood = endMood;
    try { await putRecord({ id: r.id, at: r.at, mood: r.mood, note: r.note, summary: r.summary || '' }); } catch (e) {}
    renderHistory();
  }
  closers.end = closeEnd;
  async function askClaude() {
    const r = endRec; if (!r) return;
    r.note = $('endNote').value.trim().slice(0, 300); r.mood = endMood;
    const m = dayTotals(), now = new Date(), week = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i), x = m.get(dayKey(d)) || { talk: 0, n: 0 }; week.push({ day: d.toLocaleDateString('en-US', { weekday: 'short' }), talkMin: +(x.talk / 60).toFixed(1), sessions: x.n }); }
    const tot = (+r.meSec || 0) + (+r.otherSec || 0);
    const body = { session: { kind: r.kind, echoBy: r.who === 'level' ? 'sound level' : 'voice', minutes: +(r.dur / 60).toFixed(1), talkMin: +((+r.talkTime || 0) / 60).toFixed(1), youPercent: tot >= 1 ? Math.round(100 * r.meSec / tot) : null,
      longestQuietMin: +((+r.bestQuiet || 0) / 60).toFixed(1), echoes: r.talks || 0, talkedOverSomeone: r.interrupts || 0, nudges: r.nudges || 0, talkFreelyTaps: r.freePass || 0,
      mood: r.mood || null, note: r.note || '' }, dailyBudgetMin: shared.budget, last7Days: week, daysWithinBudget: streakDays(m) };
    const btn = $('askClaude'); btn.disabled = true; btn.textContent = 'Asking Claude…'; $('claudeHint').textContent = CLAUDE_HINT;
    try {
      const res = await fetch(CFG.summaryUrl || '/api/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      let j = {}; try { j = await res.json(); } catch (e) {}
      if (res.status === 429) throw new Error('Claude was asked too often just now. Try again in a minute.');
      if (!res.ok || !j.summary) throw new Error(j.error || 'Claude is not available right now. Try again later.');
      r.summary = String(j.summary).slice(0, 1500);
      if (endRec === r) showSummary(r.summary);
      await putRecord({ id: r.id, at: r.at, summary: r.summary, mood: r.mood, note: r.note });
      btn.textContent = 'Ask Claude again';
    } catch (e) {
      $('claudeHint').textContent = e && e.name === 'TypeError' ? "Couldn't reach Claude. A summary needs the internet, and Samt opened from samt-quiet.netlify.app." : (e && e.message) || "Couldn't get a summary.";
      btn.textContent = r.summary ? 'Ask Claude again' : 'Ask Claude for a summary';
    }
    btn.disabled = false;
  }

  /* ---------- without your voice: cards, speaking them, the sign ---------- */
  const CARDS = ['Yes', 'No', 'One moment', 'Thank you', "I'm keeping quiet right now", 'Please write it down', "I'll answer later", 'جزاك الله خيرًا'];
  const SIGN_WORDS = ["I'm keeping quiet", 'Quiet time', 'In silence for now', 'Not talking right now'];
  function setDir(el, text) { if (isAr(text)) { el.lang = 'ar'; el.dir = 'rtl'; } else { el.removeAttribute('lang'); el.removeAttribute('dir'); } }
  function renderCards() {
    const g = $('cardGrid'); g.textContent = ''; g.classList.toggle('editing', cardsEditing);
    const all = CARDS.map(t => ({ t, custom: false })).concat(shared.cards.map(t => ({ t, custom: true })));
    for (const c of all) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'cardb' + (isAr(c.t) ? ' ar' : '') + (c.custom ? ' custom' : ''); b.textContent = c.t; setDir(b, c.t);
      b.onclick = () => {
        if (!cardsEditing) { show(c.t); return; }
        if (c.custom) ask({ title: c.t, actions: [{ label: 'Delete this card', danger: true, run: () => { shared.cards = shared.cards.filter(x => x !== c.t); saveShared(); if (!shared.cards.length) cardsEditing = false; renderCards(); } }] });
      };
      g.appendChild(b);
    }
    $('cardsEdit').textContent = cardsEditing ? 'Done' : 'Edit'; $('cardsEdit').hidden = !shared.cards.length && !cardsEditing; $('cardsHint').hidden = !cardsEditing;
  }
  function show(text, opt) {
    opt = opt || {};
    const keepTurn = !!(showCtx && opt.keepTurn && $('showView').classList.contains('turned'));
    showCtx = Object.assign({ text }, opt);
    const t = $('showText'); t.textContent = text; t.classList.toggle('ar', isAr(text)); setDir(t, text);
    $('showSub').textContent = opt.sub || ''; $('showSub').hidden = !opt.sub;
    $('showGlyph').hidden = !opt.sign; $('showWords').hidden = !opt.sign;
    const v = $('showView'); v.classList.toggle('turned', keepTurn); v.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => v.classList.add('show')));
    setTimeout(() => { if (showCtx) $('showClose').focus({ preventScroll: true }); }, 60);
    requestWake();
  }
  function hideShow() {
    if (!showCtx) return; showCtx = null;
    try { if (window.speechSynthesis) speechSynthesis.cancel(); } catch (e) {}
    const v = $('showView'); v.classList.remove('show'); setTimeout(() => { if (!showCtx) v.hidden = true; }, 260);
    if (!session) releaseWake();
  }
  function speak(text) {
    const ss = window.speechSynthesis;
    if (!ss || typeof SpeechSynthesisUtterance === 'undefined') { toast("This browser can't read text out loud."); return; }
    try {
      ss.cancel();
      const u = new SpeechSynthesisUtterance(text), ar = isAr(text); u.lang = ar ? 'ar-SA' : 'en-US'; u.rate = 0.95;
      const vs = ss.getVoices ? ss.getVoices() : [], v = vs.find(x => (x.lang || '').toLowerCase().startsWith(ar ? 'ar' : 'en'));
      if (v) u.voice = v; else if (ar && vs.length) toast('No Arabic voice is installed, so it may sound wrong.');
      ss.speak(u);
    } catch (e) { toast("Couldn't read it out loud."); }
  }
  const signSub = () => session && session.endAt && session.mode !== 'test' ? `Until ${timeStr(session.endAt)}. I can read and write.` : 'I can read and write.';
  function openSign() { show(shared.sign || SIGN_WORDS[0], { sub: signSub(), sign: true }); }
  function setSign(w) { shared.sign = w.slice(0, 60); saveShared(); if (showCtx && showCtx.sign) show(shared.sign, { sub: signSub(), sign: true, keepTurn: true }); }
  function changeSignWords() {
    ask({ title: 'Words for the sign', actions: SIGN_WORDS.map(w => ({ label: w, run: () => setSign(w) })).concat([{ label: 'Your own words', run: async () => { const v = await promptText({ title: 'Words for the sign', value: shared.sign, max: 60 }); if (v) setSign(v); } }]) });
  }

  /* ---------- reminders: Qur'an (Tanzil Uthmani) and hadith (sunnah.com), the meaning on a tap ---------- */
  const REM = window.SAMT_REMINDERS || { verses: [], hadith: [] };
  const remItems = () => (REM.verses || []).map(v => Object.assign({ kind: 'verse' }, v)).concat((REM.hadith || []).map(h => Object.assign({ kind: 'hadith' }, h)));
  /* ﷺ (ṣallā llāhu ʿalayhi wa-sallam, "God bless him and give him peace") is one compact Amiri glyph that blurs at text
     size, so it gets its own larger span. */
  function setSaw(el, text) {
    el.textContent = '';
    text.split('ﷺ').forEach((part, i) => { if (i) { const s = document.createElement('span'); s.className = 'saw'; s.lang = 'ar'; s.textContent = 'ﷺ'; el.append(s); } if (part) el.append(part); });
    return el;
  }
  function fillRem(box, it, full) {
    box.textContent = '';
    const add = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; box.appendChild(e); return e; };
    if (it.kind === 'hadith') setSaw(add('p', 'ref'), 'The Prophet ﷺ said');
    const ar = add('p', it.kind === 'verse' ? 'ar quran' : 'ar', it.text); ar.lang = 'ar'; ar.dir = 'rtl';
    const ref = add('p', 'ref');
    if (it.kind === 'verse') { const n = document.createElement('span'); n.className = 'arn'; n.lang = 'ar'; n.dir = 'rtl'; n.textContent = it.surah; ref.append(n, ' ' + it.ref); }
    else ref.textContent = it.ref + (it.grade ? ' · ' + it.grade : '');
    const meaning = it.kind === 'verse' ? (it.pickthall ? it.pickthall + ' (Pickthall)' : null) : (it.meaning ? 'In plain words: ' + it.meaning : null);
    if (meaning) {
      const b = add('button', 'btn plain', 'Meaning'); b.type = 'button'; b.setAttribute('aria-expanded', 'false');
      const m = add('p', 'mean', meaning); m.hidden = true;
      b.onclick = () => { m.hidden = !m.hidden; b.textContent = m.hidden ? 'Meaning' : 'Hide the meaning'; b.setAttribute('aria-expanded', String(!m.hidden)); };
    }
    if (full && it.url) { const a = add('a', 'btn plain', 'Open on sunnah.com'); a.href = it.url; a.target = '_blank'; a.rel = 'noopener'; }
  }
  function renderRemList() {
    const box = $('remList'); box.textContent = '';
    const items = remItems();
    for (const [cap, kind] of [["Qur'an", 'verse'], ['Hadith (sayings of the Prophet ﷺ)', 'hadith']]) {
      const list = items.filter(x => x.kind === kind); if (!list.length) continue;
      const h = document.createElement('h3'); h.className = 'cap'; setSaw(h, cap); box.appendChild(h);
      for (const it of list) { const g = document.createElement('div'); g.className = 'group'; const r = document.createElement('div'); r.className = 'rem'; fillRem(r, it, true); g.appendChild(r); box.appendChild(g); }
    }
    $('remSource').textContent = REM.sources || '';
    $('swRemind').setAttribute('aria-checked', String(!!shared.remind));
  }
  function showSessionReminder() {
    const box = $('remind'), items = remItems();
    if (!shared.remind || !items.length) { box.hidden = true; return; }
    const i = (+shared.remindAt || 0) % items.length; shared.remindAt = (i + 1) % items.length; saveShared();
    fillRem(box, items[i], false); box.hidden = false;
  }

  /* ---------- views: Home, the session, and the pages under Home (Back, and the iPad's back gesture) ---------- */
  const VIEWS = { home: 'vHome', session: 'vSession', progress: 'vProgress', settings: 'vSettings', wizard: 'vWizard' };
  let view = 'home';
  function goView(v, how) {
    if (!VIEWS[v]) v = 'home';
    for (const k of Object.keys(VIEWS)) $(VIEWS[k]).hidden = k !== v;
    const changed = v !== view; view = v; document.body.dataset.view = v;
    try { if (how === 'push') window.history.pushState({ samt: v }, ''); else if (how === 'replace') window.history.replaceState({ samt: v }, ''); } catch (e) {}
    if (!changed) return;
    window.scrollTo(0, 0);
    if (v === 'progress') { renderToday(); renderHistory(); }
    if (v === 'wizard') renderWizard();
    const h = $(VIEWS[v]).querySelector('.ptitle'); if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
  }
  window.addEventListener('popstate', e => {
    if (session) { try { window.history.pushState({ samt: 'session' }, ''); } catch (err) {} return; } // a running session stays on screen
    const v = e.state && e.state.samt; goView(v && v !== 'session' ? v : 'home', 'none');
  });
  function goBack() {
    const st = window.history.state;
    if (st && st.samt && st.samt !== 'home' && window.history.length > 1) window.history.back();
    else goView(view === 'wizard' && wizFrom === 'settings' ? 'settings' : 'home', 'replace');
  }
  function enterSession() {
    document.body.classList.add('in-session');
    $('sKind').textContent = session.mode === 'test' ? 'Test, no echo' : session.kind === 'conversation' ? 'Conversation' : 'Silence';
    goView('session', 'push'); // its own history entry, so a Back swipe lands on the popstate guard instead of leaving Samt
  }
  function leaveSession() {
    document.body.classList.remove('in-session');
    for (const s of ['mute', 'details']) if (openSheets.includes(s)) closeSheet(s);
    const ours = window.history.state && window.history.state.samt === 'session';
    goView('home', 'none');
    if (ours) try { window.history.back(); } catch (e) {} // drop the session's entry; the popstate lands on Home again
  }
  const LEVEL = { '-1': 'Looser', 0: 'Balanced', 1: 'Stricter' };
  function settingsValues() {
    $('echoStatus').textContent = `${settings.delay} ms · ${settings.vol}%`;
    $('matchStatus').textContent = LEVEL[settings.strict];
  }
  const convText = () => `${settings.limit} s turns · ${settings.noInterrupt ? 'no interrupting' : 'interrupting allowed'} · ${settings.nudge ? 'nudge first' : 'no nudge'}`;
  /* Pausing a real session takes a 2-second hold while a ring fills, so it can't happen by accident or on impulse; from
     the pause, Resume or End session. A test stops with a tap. */
  function wireHoldStop() {
    const b = $('stop'); let t = 0;
    const cancel = tell => { if (!t) return; clearTimeout(t); t = 0; b.classList.remove('holding'); if (tell) toast('Hold 2 seconds to pause.'); };
    const begin = () => {
      if (!session || session.paused) return;
      if (session.mode === 'test') { stopSession(false); return; }
      if (t) return;
      b.classList.add('holding');
      t = setTimeout(() => { t = 0; b.classList.remove('holding'); pauseSession(true); }, 2000);
    };
    b.addEventListener('pointerdown', e => { if (e.pointerType !== 'mouse' || e.button === 0) begin(); });
    b.addEventListener('pointerup', () => cancel(true));
    b.addEventListener('pointerleave', () => cancel(false));
    b.addEventListener('pointercancel', () => cancel(false));
    b.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); begin(); } });
    b.addEventListener('keyup', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); cancel(true); } });
    b.addEventListener('contextmenu', e => e.preventDefault());
  }

  /* ---------- setup's last step: ten seconds of the real echo, to hear it once and check that Samt knows the voice ---------- */
  let wantEchoTest = false, echoTest = null;
  function openEchoTest() {
    if (busy || !voice || !voice.ready) return;
    $('testText').textContent = 'Tap Start, then say anything for a few seconds, like counting to ten. You should hear yourself a moment late in your headphones.';
    $('testHint').textContent = ''; $('testProg').style.transform = 'scaleX(0)';
    $('testStart').hidden = false; $('testStart').textContent = 'Start'; $('testDone').hidden = true; $('testMore').hidden = true;
    $('testSkip').hidden = false; $('testSkip').textContent = 'Skip the test';
    openSheet('test');
  }
  function startEchoTest() {
    if (echoTest || busy) return;
    const started = ensureMic(); // inside the tap
    $('testStart').hidden = true; $('testHint').textContent = 'Starting the mic'; setBusy('echotest');
    started.then(() => {
      listener.reset(); voice.strict = strictValue();
      const t = { me: 0, speech: 0, echo: false, start: listener.fs.nFrames };
      t.ctrl = new Controller({ listener, voice, book: null, onEcho: setEcho, onEvent: e => {
        if (e.type === 'segment') { t.speech++; if (e.rec.speaker === 'me') t.me++; }
        else if (e.type === 'verdict' && e.isMe) t.me++;
        else if (e.type === 'state' && e.state === 'echo') t.echo = true;
      } });
      t.ctrl.start('silence');
      t.timer = setInterval(() => {
        const sec = (listener.fs.nFrames - t.start) / 100;
        $('testProg').style.transform = `scaleX(${Math.min(1, sec / 10).toFixed(3)})`;
        $('testHint').textContent = t.echo ? 'That was you. Keep talking to hear the echo.' : `Listening, ${Math.max(0, Math.ceil(10 - sec))} s`;
        if (sec >= 10) endEchoTest('done');
      }, 200);
      echoTest = t;
    }, e => { setBusy(null); $('testStart').hidden = false; $('testHint').textContent = micError(e); });
  }
  function endEchoTest(why) {
    const t = echoTest; echoTest = null;
    if (t) { clearInterval(t.timer); try { t.ctrl.stop(); } catch (e) {} releaseMic(); setBusy(null); }
    if (why === 'skip' || why === 'close') { closeSheet('test'); return; }
    $('testHint').textContent = '';
    if (why === 'stopped') { $('testHint').textContent = 'The mic stopped.'; $('testStart').hidden = false; $('testStart').textContent = 'Try again'; return; }
    if (t && (t.me > 0 || t.echo)) {
      $('testText').textContent = 'Samt knows your voice and turned the echo on.' + (view === 'wizard' ? '' : " You're set.");
      $('testDone').hidden = false; $('testSkip').hidden = true;
      wiz.echoOk = true; delete wiz.skip.echo; saveWiz(); render();
    } else if (t && t.speech > 0) {
      $('testText').textContent = "Samt heard talking but didn't recognise it as you yet. Reading a little more usually fixes it.";
      $('testMore').hidden = false; $('testSkip').textContent = 'Continue anyway';
    } else {
      $('testText').textContent = "Samt didn't hear any talking. Check that your headphones' mic is on, then try again.";
      $('testStart').hidden = false; $('testStart').textContent = 'Try again'; $('testSkip').textContent = 'Continue anyway';
    }
  }
  closers.test = () => endEchoTest('close');

  /* ---------- the check: you talk, then someone else does; how often Samt got each right. No echo plays. ---------- */
  // A stretch of talk counts when it lasts a second or more (shorter ones never echo, by design). For you, it's right
  // when the echo would have come on at any point; for others, when it never would have.
  const CHECK_SEC = 20, CHECK_MIN = 10;
  let check = null;
  function startCheck() {
    const lv = settings.who === 'level';
    if (busy || (!lv && (!voice || !voice.ready))) return;
    if (!lv && MODE === 'neural' && !ortSession) { note('The voice model is still loading.'); return; }
    const started = ensureMic(); // first, inside the tap
    note(''); setBusy('check');
    check = { who: settings.who, round: 0, waiting: false, tally: [{ n: 0, ok: 0 }, { n: 0, ok: 0 }], lv: [null, null] }; debug.checkLog = [];
    openPanel({ title: 'Round 1 of 2: you talk', passage: 'Talk about anything in your normal voice, like what you did today. Only you, about 20 seconds.', hint: 'Starting the mic' });
    rec = { kind: 'check', finish: cancel => cancel ? endCheck(true) : check && check.waiting ? beginRound(1) : endRound() };
    started.then(() => { if (rec && rec.kind === 'check') beginRound(0); }, e => { rec = null; check = null; closePanel(); setBusy(null); note(micError(e)); });
  }
  function beginRound(i) {
    const k = check; if (!k) return;
    k.round = i; k.waiting = false; k.speech = 0; k.seen = new Set();
    listener.reset();
    // Silence's rules (the echo as soon as it's you, or as soon as it's over the line), in test mode: the decisions
    // happen, the echo doesn't play
    const params = { limit: 0, interrupt: false, nudge: false }, onEvent = e => {
      if (k.ctrl !== c) return;
      if (e.type === 'state' && e.state === 'echo' && c.seg) k.seen.add(c.seg.id);
      else if (e.type === 'segment') tallySeg(k, e.rec);
    };
    let c;
    if (k.who === 'level') { c = new LevelGate({ listener, onEcho: () => {}, onEvent, params: Object.assign({ line: lineNow(), hold: holdFrames() }, params) }); c.setNotches(allTones()); c.collect = []; gateTap = c; }
    else { voice.strict = strictValue(); c = new Controller({ listener, voice, book: null, onEcho: () => {}, onEvent, params }); }
    k.ctrl = c; c.start('test');
    $('recDone').textContent = 'Done'; $('recDone').disabled = true; $('recProg').style.transform = 'scaleX(0)';
    k.timer = setInterval(() => roundTick(k), 200); roundTick(k);
  }
  function tallySeg(k, r) {
    const sec = (r.end - r.start + 1) / 100, echoed = !!r.echo || k.seen.has(r.id), t = k.tally[k.round];
    k.speech += sec; debug.checkLog.push({ round: k.round, sec: +sec.toFixed(2), echoed, echoAtEnd: !!r.echo, speaker: r.speaker, passes: r.passes.length });
    if (k.round === 0) { if (sec >= 1 && !r.passes.length) { t.n++; if (echoed) t.ok++; } } // a phrase that passed isn't a miss
    else if (sec >= 1 || echoed) { t.n++; if (!echoed) t.ok++; }
  }
  function roundTick(k) {
    if (check !== k || k.waiting || !k.ctrl) return;
    const c = k.ctrl, g = c.seg, now = c.frameNow ? c.frameNow() : g && g.next; // the stretch still going counts too
    const sec = k.speech + (g ? Math.max(0, now - g.start) / 100 : 0), t = k.tally[k.round];
    $('recProg').style.transform = `scaleX(${Math.min(1, sec / CHECK_SEC).toFixed(3)})`;
    $('recHint').textContent = `Listening. ${Math.floor(sec)} of ${CHECK_SEC} seconds` +
      (t.n ? (k.round === 0 ? `. Caught you ${t.ok} of ${t.n} so far.` : `. Ignored them ${t.ok} of ${t.n} so far.`) : '.');
    $('recDone').disabled = sec < CHECK_MIN;
    if (sec >= CHECK_SEC) endRound();
  }
  function endRound() {
    const k = check; if (!k || k.waiting || !k.ctrl) return;
    clearInterval(k.timer);
    try { if (k.ctrl.seg) k.ctrl.cut(); } catch (e) {} // count the stretch still going
    // Sound level: how loud each round's talking was (your typical level, their loudest moments), to place the line
    const lv = k.ctrl.collect; if (lv && lv.length >= 30) k.lv[k.round] = st.pct(lv, k.round === 0 ? 0.5 : 0.95);
    k.ctrl.stop(); k.ctrl = null; if (gateTap && !session) gateTap = null;
    if (k.round === 1) { endCheck(false); return; }
    k.waiting = true; // between the rounds: time to hand over, or start a video
    $('recTitle').textContent = 'Round 2 of 2: someone else talks';
    $('recPassage').textContent = "Now stay quiet while someone else talks for about 20 seconds: a person, or a TV or another phone playing a video. Tap Start when they're ready.";
    $('recProg').style.transform = 'scaleX(0)';
    $('recHint').textContent = `Round 1: Samt caught you ${k.tally[0].ok} of ${k.tally[0].n} times.`;
    $('recDone').textContent = 'Start'; $('recDone').disabled = false;
  }
  function endCheck(cancel) {
    const k = check; if (!k) return; check = null;
    clearInterval(k.timer); if (k.ctrl) { try { k.ctrl.stop(); } catch (e) {} }
    if (gateTap && !session) gateTap = null;
    rec = null; closePanel(); releaseMic();
    if (!cancel) {
      wiz.check = { who: k.who, you: [k.tally[0].ok, k.tally[0].n], oth: [k.tally[1].ok, k.tally[1].n], strict: settings.strict, line: lineNow(), at: Date.now() };
      if (k.who === 'level' && k.lv[0] != null && k.lv[1] != null) wiz.check.lv = { you: Math.round(k.lv[0] * 10) / 10, oth: Math.round(k.lv[1] * 10) / 10 };
      delete wiz.skip.check; saveWiz();
    }
    setBusy(null);
  }
  /* What the numbers mean, and the one thing most likely to help. */
  function checkAdvice(c) {
    const again = { label: 'Check again', run: startCheck }, next = { label: 'Next', run: () => wizGo(wizAt + 1) }, who = c.who || 'voice';
    const NAME = { voice: 'Your voice', level: 'Sound level' };
    if (who !== settings.who) return { status: `This check was of ${NAME[who]}. Check again to see how ${NAME[settings.who]} does.`, main: again, next: true };
    if (c.stale || (who === 'level' ? c.line !== lineNow() : c.strict !== settings.strict))
      return { status: who === 'level' ? 'The line or the muted sounds changed since this check. Check again to see where it stands.' : 'Samt has changed since this check: it learned more, or Matching changed. Check again to see where it stands.', main: again, next: true };
    const [yo, yn] = c.you, [oo, on] = c.oth;
    if (yn < 3 || on < 2) return { status: yn < 3 ? 'Not enough of your talking to judge. Talk a little longer next time.' : 'Not enough of the other voice to judge. Let them talk a little longer next time.', main: again, next: true };
    const youOk = yo / yn >= 0.8, othOk = oo / on >= 0.9, tip = MODE === 'light' ? ' Samt Neural tells voices apart better.' : '';
    if (youOk && othOk) return { status: who === 'level' ? 'Your voice goes over the line and theirs stays under.' : 'Samt can tell you apart.', good: true, main: next, alt: again };
    if (who === 'level') { // a line halfway between your typical level and their loudest, if they're 4 dB or more apart
      const L = c.lv, mid = L && L.you - L.oth >= 4 ? clampLine(2 * Math.round((L.you + L.oth) / 4)) : null;
      if (mid != null && mid !== lineNow()) return { status: youOk ? 'Their voices went over the line sometimes. Yours is louder, so a line between you should work.' : "Your voice stayed under the line sometimes. It's louder than theirs, so a line between you should work.",
        main: { label: 'Put the line between you and check again', run: () => { setLine(mid); startCheck(); } }, alt: again, next: true };
      if (youOk || othOk) return { status: "Their voices reach the mic almost as loud as yours. Wear the mic closer to your mouth, or move a little away from them." + (youOk ? ' Or raise the line.' : ' Or lower the line.'),
        main: { label: youOk ? 'Raise the line and check again' : 'Lower the line and check again', run: () => { setLine(lineNow() + (youOk ? 2 : -2)); startCheck(); } }, alt: again, next: true };
      return { status: "Their voices reach the mic about as loud as yours, so a line can't split them. Wear the mic closer to your mouth, or move away from them.", main: again, next: true };
    }
    if (youOk) return settings.strict < 1
      ? { status: 'It took them for you sometimes. Stricter matching should help.', main: { label: 'Make it stricter and check again', run: () => setStrict(settings.strict + 1) }, alt: again, next: true }
      : { status: 'It still took them for you sometimes. More of other voices should help.' + tip, main: { label: 'Add other voices', run: () => teachVoice('oth') }, alt: again, next: true };
    if (othOk) return settings.strict > -1
      ? { status: 'It missed you sometimes. Looser matching should help.', main: { label: 'Make it looser and check again', run: () => setStrict(settings.strict - 1) }, alt: again, next: true }
      : { status: 'It still missed you sometimes. Reading more of your voice should help.', main: { label: 'Read more of your voice', run: () => teachVoice('me') }, alt: again, next: true };
    return { status: 'It mixed you up both ways. Teaching it more of both should help.' + tip, main: { label: 'Read more of your voice', run: () => teachVoice('me') }, alt: { label: 'Add other voices', run: () => teachVoice('oth') }, next: true };
  }
  function setStrict(v) { // from the check: change Matching, then check again in the same tap
    settings.strict = Math.max(-1, Math.min(1, v)); saveSettings(); if (voice) voice.strict = strictValue();
    if (strictCtl) strictCtl.set(settings.strict); settingsValues();
    startCheck();
  }

  /* ---------- setup, step by step: the first open starts it, Settings opens it again ---------- */
  const WSTEPS = [
    { id: 'voice', title: 'Your voice' },
    { id: 'echo', title: 'Hear the echo', skip: true },
    { id: 'others', title: 'Other voices', skip: true },
    { id: 'check', title: 'Check it', skip: true }
  ];
  const WKEY = 'samt.' + MODE + '.setup';
  const freshWiz = () => ({ skip: {}, echoOk: false, check: null, done: false });
  let wiz = Object.assign(freshWiz(), (() => { try { return JSON.parse(localStorage.getItem(WKEY) || '{}'); } catch (e) { return {}; } })());
  if (!wiz.skip || typeof wiz.skip !== 'object') wiz.skip = {};
  function saveWiz() { try { localStorage.setItem(WKEY, JSON.stringify(wiz)); } catch (e) {} }
  let wizAt = 0, wizFrom = 'home', wizMain = null, wizAlt = null;
  const othersTaught = () => profile.othSegs.length > 0 || !!(MODE === 'neural' && voice && voice.N && voice.N.length);
  function stepState(id) {
    const done = id === 'voice' ? !!(voice && voice.ready) : id === 'echo' ? !!wiz.echoOk : id === 'others' ? othersTaught() : !!wiz.check;
    return done ? 'done' : wiz.skip[id] ? 'skipped' : 'todo';
  }
  const wizSettled = () => WSTEPS.every(s => stepState(s.id) !== 'todo');
  function wizStatusText() { return wiz.done && wizSettled() ? 'Done' : `${WSTEPS.filter(s => stepState(s.id) === 'done').length} of ${WSTEPS.length}`; }
  function openWizard(from) {
    if (busy) return;
    wizFrom = from; $('wzBack').textContent = from === 'settings' ? 'Settings' : 'Samt';
    const first = WSTEPS.findIndex(s => stepState(s.id) === 'todo');
    wizAt = !(voice && voice.ready) ? 0 : first < 0 ? WSTEPS.length : first;
    goView('wizard', 'push'); renderWizard();
  }
  function wizGo(i) {
    wizAt = Math.max(0, Math.min(WSTEPS.length, i)); renderWizard(); window.scrollTo(0, 0);
    const h = $(wizAt < WSTEPS.length ? 'wzStepTitle' : 'wzSumTitle'); h.tabIndex = -1; h.focus({ preventScroll: true });
  }
  /* Your voice: add more, start over, or hear the echo test (Settings and the first step share these). */
  function voiceChoices() {
    const inWiz = view === 'wizard';
    if (!voice || !voice.ready) { wantEchoTest = !inWiz; teachVoice('me'); return; }
    ask({ title: 'Your voice', msg: `Samt knows ${Math.round(frames(profile.meSegs) / 100)} seconds of your voice. If you start over, the old voice keeps working until the new one is saved.`,
      actions: [{ label: 'Add more of your voice', run: () => teachVoice('me') }, { label: 'Start over', run: () => { wantEchoTest = !inWiz; teachVoice('me', { fresh: true }); } }, { label: 'Hear the echo test', run: openEchoTest }] });
  }
  function stepView(id, st) {
    const v = { body: '', status: '', good: false, main: null, alt: null, next: false, skip: false, res: null };
    const next = { label: 'Next', run: () => wizGo(wizAt + 1) }, modelOk = MODE !== 'neural' || !!ortSession, secs = segs => Math.round(frames(segs) / 100);
    const todo = (main) => { v.main = main; if (st === 'skipped') { v.status = 'Skipped.'; v.next = true; } else v.skip = !!WSTEPS[wizAt].skip; };
    if (id === 'voice') {
      v.body = "Read a short passage out loud in your normal voice, about 45 seconds, wearing the headphones you'll use.";
      if (st === 'done') { v.status = `Done. Samt knows ${secs(profile.meSegs)} seconds of your voice.`; v.main = next; v.alt = { label: 'Read more', run: voiceChoices }; }
      else { v.main = { label: 'Start reading', run: () => teachVoice('me'), off: !modelOk }; if (!modelOk) v.status = 'Getting the voice model ready. The first time takes a moment.'; }
      return v;
    }
    if (!(voice && voice.ready)) { v.body = 'This step needs your voice first.'; v.main = { label: 'Go to step 1', run: () => wizGo(0) }; return v; }
    if (id === 'echo') {
      v.body = 'Put your headphones on, then say anything for a few seconds, like counting to ten. You should hear yourself a moment late.';
      if (st === 'done') { v.status = 'Done. Samt knew your voice and turned the echo on.'; v.main = next; v.alt = { label: 'Hear it again', run: openEchoTest }; }
      else todo({ label: 'Start the echo test', run: openEchoTest, off: !modelOk });
    } else if (id === 'others') {
      v.body = "Let someone else talk near you for about 30 seconds while you stay quiet: a person, or a TV or another phone playing a video. Men's voices are the hardest test, so use one if you can.";
      if (st === 'done') { const s = secs(profile.othSegs); v.status = s ? `Done. Samt knows ${s} seconds of other voices.` : 'Done.'; v.main = next; v.alt = { label: 'Add more', run: () => teachVoice('oth') }; }
      else todo({ label: 'Start', run: () => teachVoice('oth'), off: !modelOk });
    } else {
      const lv = settings.who === 'level';
      v.body = 'Two rounds of about 20 seconds: first you talk, then someone else talks while you stay quiet. No echo plays. '
        + (lv ? 'Samt counts how often your voice went over the line and theirs stayed under (Sound level).' : 'Samt counts how often it got each right (Your voice).');
      if (st === 'done') { v.res = wiz.check; Object.assign(v, checkAdvice(wiz.check)); }
      else todo({ label: 'Start the check', run: startCheck, off: !lv && !modelOk });
    }
    return v;
  }
  function sumValue(id, st) {
    if (st !== 'done') return st === 'skipped' ? 'Skipped' : 'Not done';
    if (id === 'voice') return `${Math.round(frames(profile.meSegs) / 100)} s`;
    if (id === 'others') { const s = Math.round(frames(profile.othSegs) / 100); return s ? `${s} s` : 'Done'; }
    if (id === 'check') { const c = wiz.check; return `You ${c.you[0]}/${c.you[1]} · Others ${c.oth[0]}/${c.oth[1]}`; }
    return 'Done';
  }
  function renderWizard() {
    if (view !== 'wizard') return;
    const states = WSTEPS.map(s => stepState(s.id)), sum = wizAt >= WSTEPS.length, idle = !busy;
    $('wzBar').querySelectorAll('i').forEach((el, i) => { el.dataset.s = i === wizAt ? 'now' : states[i]; });
    $('wzCard').hidden = sum; $('wzSum').hidden = !sum; $('wzFinish').hidden = !sum; $('wzFinish').disabled = !idle;
    $('wzPrev').hidden = wizAt === 0; $('wzPrev').disabled = !idle;
    if (sum) {
      $('wzSumTitle').textContent = wizSettled() ? 'All set' : 'Your setup';
      const box = $('wzSumList'); box.textContent = '';
      WSTEPS.forEach((s, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'row'; b.disabled = !idle;
        const t = document.createElement('span'); t.className = 'rt'; t.textContent = s.title;
        const val = document.createElement('span'); val.className = 'rv'; val.textContent = sumValue(s.id, states[i]);
        b.append(t, val, chevron()); b.onclick = () => wizGo(i); box.appendChild(b);
      });
      $('wzNext').hidden = true; return;
    }
    const s = WSTEPS[wizAt], v = stepView(s.id, states[wizAt]);
    const put = (id, t) => { const el = $(id); if (el.textContent !== t) el.textContent = t; }; // the card is a live region: say only what changed
    put('wzCount', `Step ${wizAt + 1} of ${WSTEPS.length}` + (s.optional ? ', optional' : ''));
    put('wzStepTitle', s.title); put('wzBody', v.body);
    $('wzStatus').hidden = !v.status; put('wzStatus', v.status); $('wzStatus').classList.toggle('good', !!v.good);
    const r = v.res; $('wzRes').hidden = !r;
    if (r) {
      const pc = (a, b) => b ? Math.round(100 * a / b) : 0;
      put('wzYou', `${r.you[0]} of ${r.you[1]} times`); $('wzYouBar').style.width = pc(r.you[0], r.you[1]) + '%';
      put('wzOth', `${r.oth[0]} of ${r.oth[1]} times`); $('wzOthBar').style.width = pc(r.oth[0], r.oth[1]) + '%';
    }
    wizMain = v.main; $('wzMain').hidden = !v.main; if (v.main) { put('wzMain', v.main.label); $('wzMain').disabled = !idle || !!v.main.off; }
    wizAlt = v.alt; $('wzAlt').hidden = !v.alt; if (v.alt) { put('wzAlt', v.alt.label); $('wzAlt').disabled = !idle; }
    const nx = $('wzNext'); nx.hidden = !(v.skip || v.next); put('wzNext', v.skip ? 'Skip' : 'Next'); nx.disabled = !idle;
  }

  /* ---------- rendering ---------- */
  function setBusy(b) { busy = b; render(); }
  function refreshReadout() { if (!session) setReadout($('readout'), plannedMs() / 1000); }
  function render() {
    const taught = !!(voice && voice.ready), modelOk = MODE !== 'neural' || !!ortSession, idle = !busy;
    $('voiceStatus').textContent = taught ? `${Math.round(frames(profile.meSegs) / 100)} s` + (profile.adaptSegs.length || (voice.adapted && voice.adapted.length) ? ', learning' : '') : 'Not taught';
    const othN = MODE === 'neural' && voice && voice.N ? voice.N.length : 0;
    $('othStatus').textContent = profile.othSegs.length ? `${Math.round(frames(profile.othSegs) / 100)} s` : othN ? 'Taught' : 'Recommended';
    if (MODE === 'neural') { $('modelRow').hidden = false; if (ortSession) $('modelStatus').textContent = `Ready, ${Math.round(modelMs)} ms a check`; }
    $('teachVoice').disabled = !idle || !modelOk; $('teachOthers').disabled = !idle || !taught || !modelOk;
    $('resetAll').disabled = !idle; $('restoreBtn').disabled = !idle; $('backupBtn').disabled = !idle || !taught;
    const paused = !!(session && session.paused), test = !!(session && session.mode === 'test');
    // Home: teach your voice first, or start a session (Sound level doesn't wait for the voice model)
    $('setupCard').hidden = taught; $('readyCard').hidden = !taught;
    $('setupStart').disabled = !idle; // the first step waits for the voice model itself
    $('setupModel').hidden = modelOk; if (!modelOk) $('setupModel').textContent = 'Getting the voice model ready: ' + $('modelStatus').textContent.toLowerCase();
    $('go').disabled = $('test').disabled = !idle || !taught || (settings.who === 'voice' && !modelOk);
    $('go').textContent = settings.kind === 'conversation' ? 'Start conversation' : 'Start silence';
    $('kindSeg').querySelectorAll('button').forEach(b => { b.disabled = !idle; });
    $('whoSeg').querySelectorAll('button').forEach((b, i) => { b.disabled = !idle || (i === 0 && !voiceUsable()); });
    settingsValues();
    $('convLine').hidden = settings.kind !== 'conversation'; $('convLine').textContent = convText(); $('convStatus').textContent = `${settings.limit} s turns`;
    $('toProgress').hidden = !history.length;
    $('endTeachOthers').disabled = !idle;
    $('muteStatus').textContent = shared.mutes.length ? String(shared.mutes.length) : 'None';
    // the session view
    $('resume').hidden = !paused; $('pass').hidden = paused || test; $('stop').hidden = paused; $('endSession').hidden = !paused;
    $('sRec').hidden = test; $('sRec').classList.toggle('on', !!tape);
    $('sRec').disabled = tapeWait || !!tapeEnd || !!(session && (session.stopping || (paused && !session.holdPause && !tape)));
    if (tape) $('sRec').setAttribute('aria-label', 'Stop recording'); else { $('sRec').removeAttribute('aria-label'); $('sRecText').textContent = 'Record'; }
    $('stopText').textContent = test ? 'Stop test' : 'Hold to pause'; $('stop').classList.toggle('hold', !test); $('stop').querySelector('.ring').style.display = test ? 'none' : '';
    $('sWhoSeg').querySelectorAll('button').forEach((b, i) => { b.disabled = paused || (i === 0 && !voiceUsable()); });
    // setup, step by step
    $('wizStatus').textContent = wizStatusText(); $('toWizard').disabled = !idle;
    renderWizard();
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('go').onclick = () => startSession('silence');
    $('test').onclick = () => startSession('test');
    $('resume').onclick = resumeAudio;
    wireHoldStop();
    $('setupStart').onclick = () => openWizard('home');
    $('toWizard').onclick = () => openWizard('settings');
    $('teachVoice').onclick = voiceChoices;
    // the step-by-step setup's buttons (each step decides what its main and second button do)
    $('wzMain').onclick = () => { if (wizMain && !wizMain.off) wizMain.run(); };
    $('wzAlt').onclick = () => { if (wizAlt) wizAlt.run(); };
    $('wzNext').onclick = () => { const s = WSTEPS[wizAt]; if (s && s.skip && stepState(s.id) === 'todo') { wiz.skip[s.id] = true; saveWiz(); } wizGo(wizAt + 1); };
    $('wzPrev').onclick = () => wizGo(wizAt - 1);
    $('wzFinish').onclick = () => { wiz.done = true; saveWiz(); render(); goBack(); };
    $('recResume').onclick = async () => {
      if (!rec || !rec.paused) return;
      mic.prime(); // inside the tap
      try {
        if (!mic.trackLive()) { mic.stop(); await ensureMic(); }
        else if (!(await mic.resume())) throw Object.assign(new Error('x'), { name: 'AudioNotRunning' });
        listener.reset(); rec.paused = false; $('recResume').hidden = true; $('recHint').textContent = 'Listening again.';
      } catch (e) { note(micError(e)); }
    };
    // pages, sheets and the session's own tools
    $('toProgress').onclick = () => goView('progress', 'push');
    $('toSettings').onclick = () => goView('settings', 'push');
    $('toMute').onclick = $('dMute').onclick = openMutes;
    $('muteClose').onclick = () => closers.mute();
    $('muteGo').onclick = muteSound;
    $('lineDown').onclick = () => setLine(lineNow() - 2); $('lineUp').onclick = () => setLine(lineNow() + 2);
    document.addEventListener('click', e => { if (e.target.closest('[data-back]')) { e.preventDefault(); goBack(); } });
    $('readout').onclick = () => openSheet('timer');
    $('timerClose').onclick = $('timerDone').onclick = () => closeSheet('timer');
    $('convLine').onclick = $('toConv').onclick = () => openSheet('conv');
    $('convClose').onclick = $('convDone').onclick = () => closeSheet('conv');
    for (const k of ['echo', 'match', 'data', 'about']) { $('to' + k[0].toUpperCase() + k.slice(1)).onclick = () => openSheet(k); $(k + 'Close').onclick = $(k + 'Done').onclick = () => closeSheet(k); }
    $('detailsBtn').onclick = () => { renderCounts(); renderLast(); openSheet('details'); };
    $('detailsClose').onclick = () => closeSheet('details');
    $('sCard').onclick = () => $('openCards').click();
    $('sSign').onclick = () => $('openSign').click();
    $('testStart').onclick = startEchoTest;
    $('testDone').onclick = () => closeSheet('test');
    $('testSkip').onclick = () => endEchoTest('skip');
    $('testMore').onclick = () => { closeSheet('test'); wantEchoTest = true; teachVoice('me'); };
    $('endTeachOthers').onclick = () => { closeEnd(); teachVoice('oth'); };
    $('teachOthers').onclick = () => teachVoice('oth');
    $('recDone').onclick = () => rec && rec.finish(false);
    $('recCancel').onclick = () => rec && rec.finish(true);
    $('wasMe').onclick = () => correct(true); $('notMe').onclick = () => correct(false);
    $('actCancel').onclick = closeAsk; $('actScrim').onclick = closeAsk;
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (actOpen) closeAsk();
      else if (openSheets.includes('txt')) endText(false);
      else if (showCtx) hideShow();
      else if (openSheets.length) { const top = openSheets[openSheets.length - 1]; (closers[top] || (() => closeSheet(top)))(); }
      else if (rec) rec.finish(true);
    });
    // the kind of session, talking freely, and the conversation rules
    seg($('kindSeg'), [{ v: 'silence', label: 'Silence' }, { v: 'conversation', label: 'Conversation' }], settings.kind, v => { settings.kind = v; saveSettings(); render(); renderCounts(); });
    // what turns the echo on: Your voice (the voice check) or Sound level (the line); on Home, and mid-session
    const WHO = [{ v: 'voice', label: 'Your voice' }, { v: 'level', label: 'Sound level' }];
    whoCtl = seg($('whoSeg'), WHO, settings.who, setWho); sWhoCtl = seg($('sWhoSeg'), WHO, settings.who, setWho);
    $('pass').onclick = () => { if (tape || (session && session.echoOff)) setEchoOff(!(session && session.echoOff)); else talkFreely(); }; // while recording: the echo switch
    $('sRec').onclick = () => { if (tape) endTape(''); else startTape(); };
    $('endSession').onclick = () => { if (session && session.paused) stopSession(false); };
    const applyConv = () => { if (ctrl && session && session.kind === 'conversation') Object.assign(ctrl.p, convParams()); render(); };
    const sw = (id, key) => { const el = $(id), sync = () => el.setAttribute('aria-checked', String(!!settings[key])); el.onclick = () => { settings[key] = !settings[key]; saveSettings(); sync(); applyConv(); }; sync(); };
    sw('swInterrupt', 'noInterrupt'); sw('swNudge', 'nudge');
    // the daily budget
    $('budgetDown').onclick = () => { shared.budget = Math.max(5, shared.budget - (shared.budget > 60 ? 15 : 5)); saveShared(); renderToday(); };
    $('budgetUp').onclick = () => { shared.budget = Math.min(240, shared.budget + (shared.budget >= 60 ? 15 : 5)); saveShared(); renderToday(); };
    // without your voice
    $('openCards').onclick = () => { cardsEditing = false; renderCards(); openSheet('cards'); };
    $('cardsClose').onclick = () => closeSheet('cards');
    $('cardsEdit').onclick = () => { cardsEditing = !cardsEditing; renderCards(); };
    const typed = () => $('cardText').value.trim();
    $('cardShowTyped').onclick = () => { const v = typed(); if (v) show(v); else $('cardText').focus(); };
    $('cardSpeakTyped').onclick = () => { const v = typed(); if (v) speak(v); else $('cardText').focus(); };
    $('cardSaveTyped').onclick = () => {
      const v = typed(); if (!v) { $('cardText').focus(); return; }
      if (!CARDS.includes(v) && !shared.cards.includes(v)) { shared.cards = shared.cards.concat([v.slice(0, 120)]).slice(-24); saveShared(); }
      $('cardText').value = ''; renderCards(); toast('Saved as a card.');
    };
    $('cardForm').addEventListener('submit', e => { e.preventDefault(); $('cardShowTyped').click(); });
    $('openSign').onclick = openSign;
    $('showClose').onclick = hideShow;
    $('showSpeak').onclick = () => { if (showCtx) speak(showCtx.text + (showCtx.sign && showCtx.sub ? '. ' + showCtx.sub : '')); };
    $('showTurn').onclick = () => $('showView').classList.toggle('turned');
    $('showWords').onclick = changeSignWords;
    $('openRemind').onclick = () => { renderRemList(); openSheet('rem'); };
    $('remClose').onclick = () => closeSheet('rem');
    $('swRemind').onclick = () => { shared.remind = !shared.remind; saveShared(); $('swRemind').setAttribute('aria-checked', String(shared.remind)); };
    // a session's end
    moodCtl = seg($('moodSeg'), [{ v: 'easy', label: 'Easy' }, { v: 'okay', label: 'Okay' }, { v: 'hard', label: 'Hard' }], null, v => { endMood = v; });
    $('endDone').onclick = closeEnd; $('endClose').onclick = closeEnd; $('askClaude').onclick = askClaude;
    $('endDelete').onclick = () => {
      const r = endRec; if (!r) return;
      const clips = Array.isArray(r.clips) ? r.clips : [];
      ask({ title: 'Delete this session?', msg: clips.length ? 'It leaves the list and the totals, and its recordings are deleted.' : 'It leaves the list and the totals.', actions: [{ label: 'Delete', danger: true, run: async () => {
        if (endRec === r) { endRec = null; stopPlayers(); closeSheet('end'); }
        await dropRecord(r.id); for (const c of clips) await blobs.del(c.id).catch(() => {});
        renderHistory(); renderToday();
      } }] });
    };
    // a line of text
    $('txtSave').onclick = () => endText(true); $('txtClose').onclick = () => endText(false);
    $('txtForm').addEventListener('submit', e => { e.preventDefault(); endText(true); });
    const presets = seg($('presets'), [{ v: 30, label: '30 min' }, { v: 60, label: '1 hr' }, { v: 120, label: '2 hr' }, { v: 480, label: '8 hr' }, { v: 960, label: '16 hr' }], settings.mins, v => { settings.mins = v; $('until').value = ''; saveSettings(); syncTimer(); });
    const syncTimer = () => { $('minsOut').textContent = lenText(settings.mins); presets.set($('until').value ? null : settings.mins); $('clearUntil').hidden = !$('until').value; refreshReadout(); };
    // − / +: 5 minutes under an hour, 15 up to 4 hours, then an hour at a time, up to 16 hours
    const stepMins = d => { settings.mins = Math.max(5, Math.min(MAX_MINS, settings.mins + d)); $('until').value = ''; saveSettings(); syncTimer(); };
    $('minsDown').onclick = () => stepMins(settings.mins > 240 ? -60 : settings.mins > 60 ? -15 : -5); $('minsUp').onclick = () => stepMins(settings.mins >= 240 ? 60 : settings.mins >= 60 ? 15 : 5);
    $('until').oninput = () => { syncTimer(); if (untilMs() > MAX_MINS * 60000) toast('Sessions run up to 16 hours.'); }; $('clearUntil').onclick = () => { $('until').value = ''; syncTimer(); };
    const stepper = (key, down, up, out, step, lo, hi, fmtFn, apply) => {
      const show = () => { $(out).textContent = fmtFn(settings[key]); };
      $(down).onclick = () => { settings[key] = Math.max(lo, settings[key] - step); saveSettings(); show(); apply(); };
      $(up).onclick = () => { settings[key] = Math.min(hi, settings[key] + step); saveSettings(); show(); apply(); };
      show();
    };
    stepper('delay', 'delayDown', 'delayUp', 'delayOut', 20, 60, 400, v => v + ' ms', () => { mic.setDelay(settings.delay / 1000); if (gateTap) gateTap.p.hold = holdFrames(); settingsValues(); });
    const volApply = () => { mic.setVolume(settings.vol / 100); $('volOut').textContent = $('dVolOut').textContent = settings.vol + '%'; settingsValues(); };
    stepper('vol', 'volDown', 'volUp', 'volOut', 10, 10, 100, v => v + '%', volApply);
    stepper('vol', 'dVolDown', 'dVolUp', 'dVolOut', 10, 10, 100, v => v + '%', volApply); // the same volume, inside a session
    stepper('limit', 'limitDown', 'limitUp', 'limitOut', 5, 5, 60, v => v + ' s', () => { if (ctrl && session && session.kind === 'conversation') Object.assign(ctrl.p, convParams()); render(); });
    const LSB = [{ v: -1, label: 'Looser' }, { v: 0, label: 'Balanced' }, { v: 1, label: 'Stricter' }];
    strictCtl = seg($('strictSeg'), LSB, settings.strict, v => { settings.strict = v; saveSettings(); if (voice) voice.strict = strictValue(); settingsValues(); renderWizard(); });
    seg($('themeSeg'), [{ v: 'auto', label: 'Auto' }, { v: 'day', label: 'Day' }, { v: 'night', label: 'Night' }], themePref(), v => { try { localStorage.setItem('samt.theme', v); } catch (e) {} applyTheme(); });
    $('backupBtn').onclick = backup;
    $('restoreBtn').onclick = () => $('restoreFile').click();
    $('restoreFile').onchange = () => { const f = $('restoreFile').files[0]; $('restoreFile').value = ''; if (f) restore(f); };
    $('resetAll').onclick = () => ask({
      title: "Erase Samt's setup?", msg: 'Your voice and the other voices on this device will be deleted. A backup file is not affected.',
      actions: [{ label: 'Erase everything', danger: true, run: async () => {
        await Promise.all(['profile', 'voice', 'phrases'].map(k => store.del(K(k)))); // 'phrases': left by older versions
        profile = { meSegs: [], othSegs: [], adaptSegs: [] }; voice = null; lastRec = null;
        wiz = freshWiz(); saveWiz(); // setup starts again from step 1
        renderLast(); live('off', 'Teach Samt your voice to begin'); render(); toast('Erased on this device.');
      } }]
    });
    syncTimer();
  }

  async function boot() {
    applyTheme(); wire();
    if (MODE === 'neural') { $('modelRow').hidden = false; loadModel().catch(() => {}); }
    await loadAll();
    if (!(await store.available())) $('storeWarn').hidden = false;
    syncWho(); renderLine(); live('off', 'Ready'); render(); renderCounts();
    try { window.history.replaceState({ samt: 'home' }, ''); } catch (e) {}
    goView('home', 'none');
    try { await loadHistory(); } catch (e) {}
    renderHistory(); renderToday(); render();
    setTimeout(sweepTapes, 5000);
    setInterval(() => { if (!session) renderToday(true); }, 60000); // a new day starts at midnight
    document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && !session) { try { await loadHistory(); } catch (e) {} renderHistory(); renderToday(); } });
    // fetch the Amiri fonts once the page has settled, so a session's first reminder doesn't flash in another font
    setTimeout(() => { try { for (const f of ['"Amiri Quran"', 'Amiri', '"Samt Arabic"']) document.fonts.load('26px ' + f, 'ق').catch(() => {}); } catch (e) {} }, 2000);
    debug.history = () => history; debug.shared = shared; debug.view = () => view; debug.trouble = onTrouble;
    debug.wiz = () => ({ at: wizAt, states: WSTEPS.map(s => stepState(s.id)), check: wiz.check, done: wiz.done, strict: settings.strict, who: settings.who });
    debug.session = () => session; debug.tick = () => tickSession(); debug.tape = () => tape; debug.blobs = blobs; debug.sweep = sweepTapes; debug.roll = (sec, bytes) => { ROLL_SEC = sec; if (bytes) ROLL_BYTES = bytes; }; // the tests move a pause's start back to reach its end
    debug.line = () => lineNow(); debug.setLine = setLine; debug.mutes = () => shared.mutes; debug.gate = () => gateTap;
    if (FAKE) { debug.feed = async (name, url) => { const b = await (await fetch(url)).arrayBuffer(); return mic.play(name, new Float32Array(b)); }; debug.ensureEngine = ensureMic; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
