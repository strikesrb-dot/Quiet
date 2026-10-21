/* Samt app (Quiet Glass UI): setup flows, live session, timer, settings, backup. MODE is 'light' or 'neural'. */
(function () {
  'use strict';
  const S = window.Samt, MODE = window.SAMT_MODE, CFG = window.SAMT_CONFIG || {};
  const { Listener, PhraseBook, Teacher, Controller } = S.pipeline;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const FAKE = params.has('fakemic');
  const store = S.mic.openStore('samt');
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
  const DEF = { mins: 30, delay: 200, vol: 100, strict: 0, psens: 0 };
  const settings = Object.assign({}, DEF, (() => { try { return JSON.parse(localStorage.getItem('samt.' + MODE + '.settings') || '{}'); } catch (e) { return {}; } })());
  settings.vol = Math.min(100, settings.vol); settings.strict = Math.max(-1, Math.min(1, Math.round(settings.strict))); settings.psens = Math.max(-1, Math.min(1, Math.round(settings.psens)));
  const saveSettings = () => { try { localStorage.setItem('samt.' + MODE + '.settings', JSON.stringify(settings)); } catch (e) {} };
  const strictValue = () => settings.strict * 1.6;          // threshold moves by 0.8 of your score spread per step
  const phraseSens = () => 1 - settings.psens * 0.1;        // looser = 1.1, stricter = 0.9

  /* ---------- state ---------- */
  const listener = new Listener(), teacher = new Teacher(listener);
  let voice = null, book = new PhraseBook(), ctrl = null, busy = null;
  let profile = { meSegs: [], othSegs: [], adaptSegs: [] };
  let ortSession = null, modelP = null, modelMs = 0;
  let session = null; // {mode, endAt, startedAt, timer, paused}
  let wakeLock = null, lastRec = null, toastTimer = 0, pendingFixes = [], howl = 0, echoHoldUntil = 0, starting = null;
  const mic = FAKE ? new S.mic.FakeMic({ onChunk: onAudio }) : new S.mic.MicEngine({ onChunk: onAudio, onTrouble });
  if (FAKE) mic.speed = +(params.get('speed') || 1);
  const debug = window.SamtDebug = { listener, mic, get ctrl() { return ctrl; }, get voice() { return voice; }, get book() { return book; }, get engine() { return mic; }, profile: () => profile, events: [] };

  const feats = s => ({ n: s.n, vec: s.vec, f0: s.f0, eDb: s.eDb });
  const frames = segs => segs.reduce((a, s) => a + s.n, 0);
  const capSegs = (segs, max) => { while (segs.length > 1 && frames(segs) > max) segs.shift(); return segs; };
  const tick = () => new Promise(r => setTimeout(r, 30));

  function onAudio(c) {
    listener.push(c);
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
    starting = mic.start().then(() => { starting = null; mic.setDelay(settings.delay / 1000); mic.setVolume(settings.vol / 100); startMeter(); return mic; }, e => { starting = null; throw e; });
    return starting;
  }
  function releaseMic() { mic.stop(); $('level').style.transform = 'scaleX(0)'; }
  let meterOn = false;
  function startMeter() {
    if (meterOn) return; meterOn = true;
    const loop = () => {
      if (!mic.live) { meterOn = false; return; }
      const x = Math.max(0, Math.min(1, (listener.level + 70) / 55));
      $('level').style.transform = `scaleX(${x.toFixed(3)})`;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  function onTrouble(kind) {
    if (kind === 'device') { if (session) { holdEcho(2000); toast('Audio output changed. Keep your headphones on so the echo cannot feed back.'); } return; }
    if (kind === 'unmuted') return;
    // interrupted (call, Siri, lock, app switch), muted, or ended: stop the echo at once and ask for a tap
    mic.setEcho(false);
    if (session && !session.paused) { session.paused = true; if (ctrl) ctrl.cut(); live('paused', 'Paused. Tap Resume.'); render(); }
    else if (rec) { rec.finish(true); note('The mic stopped. Try again.'); }
  }
  async function resumeAudio() {
    if (!session) return;
    requestWake(); mic.prime();
    try {
      if (!mic.trackLive()) { mic.stop(); await ensureMic(); }
      else if (!(await mic.resume())) throw Object.assign(new Error('x'), { name: 'AudioNotRunning' });
      listener.reset(); session.paused = false; note(''); live('on', session.mode === 'test' ? 'Testing. Listening' : 'Listening'); render();
    } catch (e) { note(micError(e)); }
  }

  /* ---------- storage ---------- */
  async function saveAll() {
    const ok = await store.set(K('profile'), profile);
    if (voice && voice.ready) await store.set(K('voice'), voice.toJSON());
    await store.set(K('phrases'), book.toJSON());
    if (!ok) toast("Couldn't save the setup on this device.");
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  }
  async function loadAll() {
    const [p, v, b] = await Promise.all([store.get(K('profile')), store.get(K('voice')), store.get(K('phrases'))]);
    if (p) profile = Object.assign({ meSegs: [], othSegs: [], adaptSegs: [] }, p);
    if (b) { try { book = PhraseBook.fromJSON(b); } catch (e) {} }
    if (v) { try { voice = MODE === 'light' ? S.LightVoice.fromJSON(v) : S.NeuralVoice.fromJSON(v); } catch (e) { voice = null; } }
    if (voice && MODE === 'neural' && ortSession) voice.attach(window.ort, ortSession);
  }
  function backup() {
    const data = { app: 'samt', mode: MODE, version: 2, saved: new Date().toISOString(), settings, profile: S.mic.pack(profile), voice: voice && voice.ready ? S.mic.pack(voice.toJSON()) : null, phrases: S.mic.pack(book.toJSON()) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `samt-${MODE}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function restore(file) {
    try {
      const d = JSON.parse(await file.text());
      if (!d || d.app !== 'samt') throw new Error("This isn't a Samt backup file.");
      if (d.mode !== MODE) throw new Error(`This backup is from Samt ${d.mode === 'neural' ? 'Neural' : 'Light'}. Open that version to restore it.`);
      profile = Object.assign({ meSegs: [], othSegs: [], adaptSegs: [] }, S.mic.unpack(d.profile));
      book = PhraseBook.fromJSON(S.mic.unpack(d.phrases));
      voice = d.voice ? (MODE === 'light' ? S.LightVoice.fromJSON(S.mic.unpack(d.voice)) : S.NeuralVoice.fromJSON(S.mic.unpack(d.voice))) : null;
      if (voice && MODE === 'neural' && ortSession) voice.attach(window.ort, ortSession);
      await saveAll(); render(); toast('Setup restored.');
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
  function openPanel({ title, passage, hint, showSkip, rtl }) {
    const t = $('recTitle'); t.textContent = title; t.className = rtl ? 'ar' : ''; t.dir = rtl ? 'rtl' : 'auto';
    const p = $('recPassage'); p.hidden = !passage; p.textContent = passage || '';
    $('recHint').textContent = hint || ''; $('recProg').style.transform = 'scaleX(0)';
    $('recDone').disabled = true; $('recSkip').hidden = !showSkip;
    if ($('recPanel').hidden) {
      $('recScrim').hidden = false; $('recPanel').hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => { $('recScrim').classList.add('show'); $('recPanel').classList.add('show'); }));
    }
  }
  function closePanel() {
    $('recScrim').classList.remove('show'); $('recPanel').classList.remove('show');
    setTimeout(() => { if (!rec) { $('recScrim').hidden = true; $('recPanel').hidden = true; } }, 520);
  }
  function teachVoice(kind) {
    if (busy) return;
    if (MODE === 'neural' && !ortSession) { note('The voice model is still loading.'); return; }
    const started = ensureMic(); // first, inside the tap
    note(''); setBusy(kind === 'me' ? 'voice' : 'others');
    const target = kind === 'me' ? 45 : 30, min = kind === 'me' ? 20 : 10;
    openPanel(kind === 'me'
      ? { title: voice && voice.ready ? 'Read this out loud again' : 'Read this out loud in your normal voice', passage: PASSAGE.join(' '), hint: 'Starting the mic' }
      : { title: 'Let other voices talk', passage: 'Play a video or podcast, put a call on speaker, or ask someone to talk near the iPad for about 30 seconds. Stay quiet yourself.', hint: 'Starting the mic' });
    rec = { kind };
    const finish = async (cancel) => {
      if (!rec || rec.kind !== kind) return; rec = null;
      const segs = teacher.end(); closePanel(); releaseMic();
      if (cancel || !segs.length) { setBusy(null); return; }
      await learn(kind, segs);
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
  async function learn(kind, segs) {
    setBusy('learning');
    live('busy', kind === 'me' ? 'Learning your voice' : 'Learning other voices');
    await tick();
    try {
      const f = segs.map(feats);
      if (kind === 'me') profile.meSegs = capSegs(profile.meSegs.concat(f), 18000);
      else profile.othSegs = capSegs(profile.othSegs.concat(f), 9000);
      if (MODE === 'light') {
        const v = voice || new S.LightVoice();
        v.train(profile.meSegs.concat(profile.adaptSegs), profile.othSegs); voice = v;
      } else {
        const prog = p => live('busy', `${kind === 'me' ? 'Learning your voice' : 'Learning other voices'} ${Math.round(p * 100)}%`);
        if (kind === 'me' && (!voice || !voice.ready)) { const v = new S.NeuralVoice(); v.attach(window.ort, ortSession); await v.train(segs, [], prog); voice = v; }
        else if (kind === 'me') await voice.addPositive(segs, prog);
        else await voice.addNegative(segs, prog);
      }
      book.setStats(profile.meSegs); book.calibrate(profile.meSegs);
      await saveAll();
      toast(kind === 'me' ? 'Learned your voice.' : 'Learned what other voices sound like.');
    } catch (e) { note(e.message || String(e)); }
    live('off', 'Ready'); setBusy(null);
  }
  function recordPhrases(ids) {
    if (busy || !ids.length) return;
    const started = ensureMic();
    note(''); setBusy('phrase');
    let qi = 0, got = [];
    const NEED = 3;
    const show = (msg) => {
      const p = book.get(ids[qi]);
      openPanel({ title: p.label, rtl: !!p.rtl, hint: msg || `Say it now. Take ${got.length + 1} of ${NEED}` + (ids.length > 1 ? `, phrase ${qi + 1} of ${ids.length}` : ''), showSkip: ids.length > 1 });
      $('recProg').style.transform = `scaleX(${(got.length / NEED).toFixed(3)})`;
      $('recDone').disabled = got.length < 2;
    };
    const next = async (keep) => {
      if (keep && got.length >= 2) book.get(ids[qi]).takes = got;
      got = []; qi++;
      if (qi >= ids.length) { await endRec(false); return; }
      show();
    };
    const endRec = async (cancel) => {
      if (!rec) return; rec = null; teacher.end(); closePanel(); releaseMic();
      setBusy('learning'); live('busy', 'Learning your phrases'); await tick();
      book.calibrate(profile.meSegs); await saveAll();
      live('off', 'Ready'); setBusy(null); if (!cancel) toast('Phrases saved.');
    };
    rec = { kind: 'phrase', finish: (cancel) => cancel ? endRec(true) : next(true), skip: () => next(false) };
    show('Starting the mic');
    started.then(() => {
      if (!rec || rec.kind !== 'phrase') return;
      listener.reset();
      teacher.begin({
        mode: 'take',
        onTake: (seg, why) => {
          if (!rec) return;
          if (!seg) { show(why === 'short' ? 'That was too short. Say it again.' : 'That was too long. Say only the phrase.'); return; }
          got.push(feats(seg));
          if (got.length >= NEED) next(true); else show();
        }
      });
      show();
    }, e => { rec = null; closePanel(); setBusy(null); note(micError(e)); });
  }

  /* ---------- session ---------- */
  function plannedMs() {
    const until = $('until').value;
    if (until) { const [h, m] = until.split(':').map(Number), t = new Date(); t.setHours(h, m, 0, 0); if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1); return t.getTime() - Date.now(); }
    return Math.max(1, Math.min(720, settings.mins)) * 60000;
  }
  function stateText(e) {
    const test = session && session.mode === 'test';
    if (e.state === 'echo') return ['echo', test ? 'You. The echo would be on' : 'You. Echo on'];
    if (e.state === 'other') return ['other', 'Someone else. Ignored'];
    if (e.state === 'holding') return ['hold', 'Hearing speech'];
    return ['on', test ? 'Testing. Listening' : 'Listening'];
  }
  let phraseShowUntil = 0;
  function onEvent(e) {
    if (debug.events.length < 4000) debug.events.push(Object.assign({ t: +(listener.fs.nFrames / 100).toFixed(2) }, e));
    if (session && session.paused) return;
    if (e.type === 'state') { if (performance.now() < phraseShowUntil && e.state !== 'echo') return; const [s, t] = stateText(e); live(s, t); }
    else if (e.type === 'phrase') { const p = book.get(e.phrase); live('pass', 'Passed: ' + (p ? p.label : 'a phrase')); phraseShowUntil = performance.now() + 1500; renderCounts(); }
    else if (e.type === 'segment') { lastRec = e.rec; renderCounts(); renderLast(); }
  }
  function renderCounts() {
    const c = ctrl ? ctrl.counts : { talk: 0, talkSec: 0, pass: 0, short: 0, other: 0 };
    $('cTalk').textContent = c.talk; $('cTalkSec').textContent = c.talkSec >= 60 ? `${(c.talkSec / 60).toFixed(1)} min` : `${Math.round(c.talkSec)} s`;
    $('cPass').textContent = c.pass; $('cShort').textContent = c.short; $('cOther').textContent = c.other;
  }
  function renderLast() {
    const r = lastRec;
    if (!r) { $('last').hidden = true; return; }
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
  function startSession(mode) {
    if (busy) return;
    if (!voice || !voice.ready) { note('Teach Samt your voice first: Teach Samt, Your voice.'); return; }
    if (MODE === 'neural' && !ortSession) { note('The voice model is still loading.'); return; }
    requestWake();                 // inside the tap, before anything waits
    const started = ensureMic();
    note(''); setBusy(mode);
    started.then(() => {
      listener.reset();
      voice.strict = strictValue(); book.sens = phraseSens();
      ctrl = new Controller({ listener, voice, book, onEcho: setEcho, onEvent });
      ctrl.start(mode === 'test' ? 'test' : 'silence');
      session = { mode, startedAt: Date.now(), endAt: mode === 'test' ? null : Date.now() + plannedMs(), paused: false };
      lastRec = null; renderLast(); renderCounts(); render();
      session.timer = setInterval(tickSession, 250); tickSession();
    }, e => { setBusy(null); releaseWake(); note(micError(e)); });
  }
  function tickSession() {
    if (!session) return;
    if (session.endAt) { const left = (session.endAt - Date.now()) / 1000; $('readout').textContent = fmt(left); if (left <= 0) stopSession(true); }
    else $('readout').textContent = fmt((Date.now() - session.startedAt) / 1000);
  }
  async function stopSession(finished) {
    if (!session) return;
    clearInterval(session.timer); session = null;
    if (ctrl) ctrl.stop();
    releaseMic(); releaseWake();
    const c = ctrl ? ctrl.counts : { talk: 0 };
    refreshReadout(); setBusy(null);
    live(finished ? 'done' : 'off', finished ? `Done. You talked ${c.talk} time${c.talk === 1 ? '' : 's'}.` : 'Stopped');
    // keep learning: speech that was confidently you, plus any That was me / Not me from this session
    const q = ctrl ? ctrl.adaptQueue.slice() : [], fixes = pendingFixes.splice(0);
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
  async function requestWake() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) { wakeLock = null; } }
  function releaseWake() { try { if (wakeLock) wakeLock.release(); } catch (e) {} wakeLock = null; }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !mic.live) return;
    if (!mic.running || !mic.trackLive()) onTrouble('interrupted');
  });

  /* ---------- rendering ---------- */
  function setBusy(b) { busy = b; render(); }
  function refreshReadout() { if (!session) $('readout').textContent = fmt(plannedMs() / 1000); }
  function render() {
    const taught = !!(voice && voice.ready), modelOk = MODE !== 'neural' || !!ortSession, idle = !busy;
    $('voiceStatus').textContent = taught ? `${Math.round(frames(profile.meSegs) / 100)} s` + (profile.adaptSegs.length || (voice.adapted && voice.adapted.length) ? ', learning' : '') : 'Not taught';
    const othN = MODE === 'neural' && voice && voice.N ? voice.N.length : 0;
    $('othStatus').textContent = profile.othSegs.length ? `${Math.round(frames(profile.othSegs) / 100)} s` : othN ? 'Taught' : 'Recommended';
    if (MODE === 'neural') { $('modelRow').hidden = false; if (ortSession) $('modelStatus').textContent = `Ready, ${Math.round(modelMs)} ms a check`; }
    const ready = book.phrases.filter(p => p.takes.length >= 2).length;
    $('phrStatus').textContent = `${ready} of ${book.phrases.length} recorded.`;
    $('teachVoice').disabled = !idle || !modelOk; $('teachOthers').disabled = !idle || !taught || !modelOk;
    $('recordAll').disabled = !idle; $('resetAll').disabled = !idle; $('restoreBtn').disabled = !idle; $('backupBtn').disabled = !idle || !taught;
    const inS = busy === 'silence', inT = busy === 'test', paused = !!(session && session.paused);
    $('go').disabled = !(idle || inS || (inT && paused)) || !taught || !modelOk;
    $('test').disabled = !(idle || inT) || !taught || !modelOk;
    $('go').textContent = paused ? 'Resume' : inS ? 'Stop' : 'Start silence';
    $('test').textContent = inT ? 'Stop test' : 'Test without echo';
    if (idle && $('live').dataset.state === 'off') live('off', !modelOk ? 'Loading the voice model' : taught ? 'Ready' : 'Teach Samt your voice to begin');
    renderPhrases();
  }
  function renderPhrases() {
    const box = $('phraseList'), groups = [];
    for (const p of book.phrases) { let g = groups.find(x => x.name === p.group); if (!g) groups.push(g = { name: p.group, items: [] }); g.items.push(p); }
    box.textContent = '';
    groups.forEach((g, gi) => {
      const cap = document.createElement('h3'); cap.className = 'cap'; cap.textContent = g.name; if (gi === 0) cap.hidden = true;
      const grp = document.createElement('div'); grp.className = 'group';
      for (const p of g.items) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'row'; b.disabled = !!busy;
        const lab = document.createElement('span'); lab.className = 'rt' + (p.rtl ? ' ar' : ''); lab.textContent = p.label; if (p.rtl) { lab.lang = 'ar'; lab.dir = 'rtl'; lab.style.textAlign = 'left'; }
        const val = document.createElement('span'); val.className = 'rv'; val.textContent = p.takes.length >= 2 ? `${p.takes.length} takes` : p.takes.length ? '1 take' : 'Not recorded';
        const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); chev.setAttribute('class', 'ic chev'); const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#i-chev'); chev.appendChild(use);
        b.append(lab, val, chev);
        b.onclick = () => {
          if (!p.takes.length && !p.custom) { recordPhrases([p.id]); return; }
          const actions = [{ label: p.takes.length ? 'Record again' : 'Record', run: () => recordPhrases([p.id]) }];
          if (p.takes.length) actions.push({ label: 'Clear the takes', danger: true, run: async () => { p.takes = []; p.thr = null; await saveAll(); render(); } });
          if (p.custom) actions.push({ label: 'Delete this phrase', danger: true, run: async () => { book.remove(p.id); await saveAll(); render(); } });
          ask({ title: p.label, actions });
        };
        grp.appendChild(b);
      }
      if (gi > 0) box.appendChild(cap);
      box.appendChild(grp);
    });
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('go').onclick = () => { if (session && session.paused) resumeAudio(); else if (busy === 'silence') stopSession(false); else startSession('silence'); };
    $('test').onclick = () => busy === 'test' ? stopSession(false) : startSession('test');
    $('teachVoice').onclick = () => teachVoice('me');
    $('teachOthers').onclick = () => teachVoice('oth');
    $('recordAll').onclick = () => { const ids = book.phrases.filter(p => p.takes.length < 2).map(p => p.id); recordPhrases(ids.length ? ids : book.phrases.map(p => p.id)); };
    $('recDone').onclick = () => rec && rec.finish(false);
    $('recCancel').onclick = () => rec && rec.finish(true);
    $('recSkip').onclick = () => rec && rec.skip && rec.skip();
    $('wasMe').onclick = () => correct(true); $('notMe').onclick = () => correct(false);
    $('actCancel').onclick = closeAsk; $('actScrim').onclick = closeAsk;
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (actOpen) closeAsk(); else if (rec) rec.finish(true); } });
    $('addPhrase').addEventListener('submit', async e => { e.preventDefault(); const v = $('newPhrase').value.trim(); if (!v) return; book.add(v.slice(0, 60)); $('newPhrase').value = ''; await saveAll(); render(); });
    const presets = seg($('presets'), [{ v: 15, label: '15 min' }, { v: 30, label: '30 min' }, { v: 60, label: '1 hr' }, { v: 120, label: '2 hr' }, { v: 240, label: '4 hr' }], settings.mins, v => { settings.mins = v; $('until').value = ''; saveSettings(); syncTimer(); });
    const syncTimer = () => { $('minsOut').textContent = settings.mins; presets.set($('until').value ? null : settings.mins); $('clearUntil').hidden = !$('until').value; refreshReadout(); };
    const stepMins = d => { settings.mins = Math.max(5, Math.min(720, settings.mins + d)); $('until').value = ''; saveSettings(); syncTimer(); };
    $('minsDown').onclick = () => stepMins(settings.mins > 60 ? -15 : -5); $('minsUp').onclick = () => stepMins(settings.mins >= 60 ? 15 : 5);
    $('until').oninput = syncTimer; $('clearUntil').onclick = () => { $('until').value = ''; syncTimer(); };
    const stepper = (key, down, up, out, step, lo, hi, fmtFn, apply) => {
      const show = () => { $(out).textContent = fmtFn(settings[key]); };
      $(down).onclick = () => { settings[key] = Math.max(lo, settings[key] - step); saveSettings(); show(); apply(); };
      $(up).onclick = () => { settings[key] = Math.min(hi, settings[key] + step); saveSettings(); show(); apply(); };
      show();
    };
    stepper('delay', 'delayDown', 'delayUp', 'delayOut', 20, 60, 400, v => v + ' ms', () => mic.setDelay(settings.delay / 1000));
    stepper('vol', 'volDown', 'volUp', 'volOut', 10, 10, 100, v => v + '%', () => mic.setVolume(settings.vol / 100));
    const LSB = [{ v: -1, label: 'Looser' }, { v: 0, label: 'Balanced' }, { v: 1, label: 'Stricter' }];
    seg($('strictSeg'), LSB, settings.strict, v => { settings.strict = v; saveSettings(); if (voice) voice.strict = strictValue(); });
    seg($('psensSeg'), LSB, settings.psens, v => { settings.psens = v; saveSettings(); book.sens = phraseSens(); });
    seg($('themeSeg'), [{ v: 'auto', label: 'Auto' }, { v: 'day', label: 'Day' }, { v: 'night', label: 'Night' }], themePref(), v => { try { localStorage.setItem('samt.theme', v); } catch (e) {} applyTheme(); });
    $('backupBtn').onclick = backup;
    $('restoreBtn').onclick = () => $('restoreFile').click();
    $('restoreFile').onchange = () => { const f = $('restoreFile').files[0]; $('restoreFile').value = ''; if (f) restore(f); };
    $('resetAll').onclick = () => ask({
      title: "Erase Samt's setup?", msg: 'Your voice, the other voices and your phrases on this device will be deleted. A backup file is not affected.',
      actions: [{ label: 'Erase everything', danger: true, run: async () => {
        await Promise.all(['profile', 'voice', 'phrases'].map(k => store.del(K(k))));
        profile = { meSegs: [], othSegs: [], adaptSegs: [] }; voice = null; book = new PhraseBook(); lastRec = null;
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
    live('off', 'Ready'); render(); renderCounts();
    if (FAKE) { debug.feed = async (name, url) => { const b = await (await fetch(url)).arrayBuffer(); return mic.play(name, new Float32Array(b)); }; debug.ensureEngine = ensureMic; }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
