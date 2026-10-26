/* Samt mic: capture (AudioWorklet, ScriptProcessor fallback) resampled to 16 kHz, and the delayed echo path
   (mic -> delay -> muted pitches -> gate gain -> headphones). One AudioContext per page, created and resumed inside a tap (WebKit only
   starts audio from a user gesture). Watches for interruptions: calls, Siri, app switches, screen lock, route changes.
   Also: a test stand-in for the mic, and a small IndexedDB store that reconnects. Browser only. */
(function (G) {
  'use strict';
  const S = G.Samt || (G.Samt = {});

  const WORKLET_SRC = `
const Resampler = (${S.dsp.makeResamplerClass.toString()})();
class SamtTap extends AudioWorkletProcessor {
  constructor() { super(); this.rs = new Resampler(sampleRate, 16000); this.buf = new Float32Array(320); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      const y = this.rs.process(ch);
      for (let i = 0; i < y.length; i++) {
        this.buf[this.n++] = y[i];
        if (this.n === 320) { this.port.postMessage(this.buf); this.buf = new Float32Array(320); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('samt-tap', SamtTap);
`;
  const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);
  // Safari 17.5 distorts all audio once an AudioWorklet loads (fixed in 17.6): use the older path there.
  const BAD_WORKLET = /Version\/17\.5(\.\d+)? .*Safari/.test(G.navigator ? navigator.userAgent : '');

  class MicEngine {
    constructor({ onChunk, onTrouble } = {}) {
      this.onChunk = onChunk || (() => {}); this.onTrouble = onTrouble || (() => {});
      this.delaySec = 0.2; this.vol = 1; this.open = false; this.live = false; this.path = null; this.ctx = null; this.tones = []; this.notches = [];
    }
    /* Call FIRST and synchronously inside the tap handler, before any await. */
    prime() {
      if (!this.ctx) {
        const AC = G.AudioContext || G.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.ctx.onstatechange = () => { if (this.live && this.ctx.state !== 'running') this.onTrouble('interrupted'); };
      }
      try { this.resumeP = this.ctx.resume(); } catch (e) { this.resumeP = Promise.resolve(); }
      return this.resumeP;
    }
    async start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { const e = new Error('no mic'); e.name = 'NoMediaDevices'; throw e; }
      if (!this.ctx) this.prime();
      const ctx = this.ctx;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
      await withTimeout(ctx.resume().catch(() => {}), 1500);
      if (ctx.state !== 'running') { this._release(); const e = new Error('audio did not start'); e.name = 'AudioNotRunning'; throw e; }
      const track = this.stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => this.live && this.onTrouble('ended');
        track.onmute = () => this.live && this.onTrouble('muted');
        track.onunmute = () => this.live && this.onTrouble('unmuted');
      }
      this.src = ctx.createMediaStreamSource(this.stream);
      this.delay = ctx.createDelay(1.0); this.delay.delayTime.value = this.delaySec;
      this.gain = ctx.createGain(); this.gain.gain.value = 0;
      this.src.connect(this.delay); this.gain.connect(ctx.destination); this._chain(); // delay -> muted pitches -> gate
      this.sink = ctx.createGain(); this.sink.gain.value = 0; this.sink.connect(ctx.destination);
      let ok = false;
      if (!BAD_WORKLET && ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        try {
          if (!ctx.__samtTap) {
            const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
            try { await ctx.audioWorklet.addModule(url); ctx.__samtTap = true; } finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
          }
          this.tap = new AudioWorkletNode(ctx, 'samt-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
          this.tap.port.onmessage = e => this.onChunk(e.data);
          this.src.connect(this.tap); this.tap.connect(this.sink);
          ok = true; this.path = 'worklet';
        } catch (e) { this.tap = null; }
      }
      if (!ok) {
        const rs = new S.dsp.Resampler(ctx.sampleRate, 16000);
        this.sp = ctx.createScriptProcessor(2048, 1, 1);
        this.sp.onaudioprocess = e => { const y = rs.process(e.inputBuffer.getChannelData(0)); if (y.length) this.onChunk(Float32Array.from(y)); };
        this.src.connect(this.sp); this.sp.connect(this.sink);
        this.path = 'script';
      }
      this.rate = ctx.sampleRate; this.startedAt = Date.now(); this.live = true;
      this._dev = () => { if (this.live && Date.now() - this.startedAt > 2000) this.onTrouble('device'); };
      try { navigator.mediaDevices.addEventListener('devicechange', this._dev); } catch (e) {}
      return this;
    }
    trackLive() { const t = this.stream && this.stream.getAudioTracks()[0]; return !!(t && t.readyState === 'live' && !t.muted); }
    /* What a recording records: the mic's own stream, never the echo. */
    recStream() { return this.stream || null; }
    get running() { return !!(this.live && this.ctx && this.ctx.state === 'running'); }
    async resume() { if (!this.ctx) return false; await withTimeout(this.ctx.resume().catch(() => {}), 1000); return this.ctx.state === 'running'; }
    setEcho(open) {
      this.open = open; if (!this.gain || !this.ctx) return;
      const g = this.gain.gain, t = this.ctx.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      g.setTargetAtTime(open ? Math.min(1, this.vol) : 0, t, open ? 0.008 : 0.025);
    }
    /* The nudge: two soft notes, rising, in the headphones. */
    chime() {
      const ctx = this.ctx; if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime + 0.02, peak = 0.16 * Math.max(0.3, Math.min(1, this.vol));
      [[660, 0], [880, 0.17]].forEach(([f, at]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + at); g.gain.exponentialRampToValueAtTime(peak, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.15);
        o.connect(g); g.connect(ctx.destination); o.start(t + at); o.stop(t + at + 0.17);
        o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) {} };
      });
    }
    setDelay(sec) { this.delaySec = sec; if (this.delay) this.delay.delayTime.setTargetAtTime(sec, this.ctx.currentTime, 0.02); }
    /* Muted sounds: one notch per pitch ([{f, q}]) between the delay and the gate, so they never reach the echo. */
    setNotches(tones) { this.tones = (tones || []).slice(); if (this.delay && this.gain) this._chain(); }
    _chain() {
      try { this.delay.disconnect(); } catch (e) {}
      for (const n of this.notches) { try { n.disconnect(); } catch (e) {} }
      this.notches = this.tones.map(t => { const b = this.ctx.createBiquadFilter(); b.type = 'notch'; b.frequency.value = t.f; b.Q.value = t.q; return b; });
      let node = this.delay; for (const b of this.notches) { node.connect(b); node = b; }
      node.connect(this.gain);
    }
    setVolume(v) { this.vol = Math.min(1, v); if (this.open) this.setEcho(true); }
    _release() {
      try { if (this.stream) this.stream.getTracks().forEach(t => { t.onended = t.onmute = t.onunmute = null; t.stop(); }); } catch (e) {}
      this.stream = null;
    }
    /* Stops the mic and the echo. The AudioContext stays (suspended) for the next tap. */
    stop() {
      this.live = false; this.open = false;
      try { if (this.gain) this.gain.gain.value = 0; } catch (e) {}
      try { navigator.mediaDevices.removeEventListener('devicechange', this._dev); } catch (e) {}
      this._release();
      for (const n of [this.src, this.tap, this.sp, this.delay, this.gain, this.sink, ...this.notches]) { try { if (n) n.disconnect(); } catch (e) {} }
      if (this.tap) this.tap.port.onmessage = null;
      if (this.sp) this.sp.onaudioprocess = null;
      this.src = this.tap = this.sp = this.delay = this.gain = this.sink = null; this.notches = [];
      try { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); } catch (e) {}
    }
  }

  /* Test-only stand-in for the microphone (?fakemic=1): plays 16 kHz PCM given by the test page. */
  class FakeMic {
    constructor({ onChunk } = {}) { this.onChunk = onChunk; this.path = 'fake'; this.open = false; this.live = false; this.speed = 1; this.queue = []; this.echoLog = []; this.t = 0; }
    prime() { return Promise.resolve(); }
    async start() {
      this.live = true;
      const step = () => {
        if (!this.live) return;
        const job = this.queue[0];
        for (let k = 0; k < this.speed && job && this.queue[0] === job; k++) {
          const a = job.pos || 0, b = Math.min(job.x.length, a + 320);
          this.onChunk(job.x.subarray(a, b)); job.pos = b; this.t += (b - a) / 16000;
          if (b >= job.x.length) { this.queue.shift(); if (job.done) job.done(); }
        }
        this.timer = setTimeout(step, 20);
      };
      step(); return this;
    }
    play(name, x) { return new Promise(res => this.queue.push({ name, x, done: res })); }
    get running() { return this.live; }
    async resume() { return true; }
    trackLive() { return true; }
    setEcho(open) { this.open = open; this.echoLog.push([+this.t.toFixed(2), open]); }
    chime() { this.echoLog.push([+this.t.toFixed(2), 'chime']); }
    setDelay() {} setVolume() {}
    setNotches(tones) { this.tones = (tones || []).slice(); }
    stop() { /* the test keeps one fake mic for the whole run */ }
    /* Where the browser has MediaRecorder, a real stream to record (a quiet 220 Hz tone); elsewhere none, and a
       recording is WAV built from the fake chunks. Call inside the tap. */
    recStream() {
      if (!G.MediaRecorder) return null;
      if (!this.recDest) {
        const AC = G.AudioContext || G.webkitAudioContext, ctx = this.recCtx = new AC(), o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 220; g.gain.value = 0.05; this.recDest = ctx.createMediaStreamDestination(); o.connect(g); g.connect(this.recDest); o.start();
      }
      try { this.recCtx.resume(); } catch (e) {}
      return this.recDest.stream;
    }
  }

  /* IndexedDB key-value store. Reopens once if Safari dropped the connection; falls back to memory. */
  function openStore(name) {
    const mem = new Map();
    let dbp = null, opened = false;
    const open = () => {
      try {
        if (!G.indexedDB) return Promise.resolve(null);
        return new Promise((res) => {
          const r = G.indexedDB.open(name, 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => { const db = r.result; opened = true; db.onclose = () => { dbp = null; }; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
          r.onerror = () => res(null); r.onblocked = () => res(null);
        });
      } catch (e) { return Promise.resolve(null); }
    };
    const getDb = () => (dbp = dbp || open());
    const tx = async (mode, fn, retry = true) => {
      const db = await getDb(); if (!db) return { ok: false };
      try {
        return await new Promise((res, rej) => { const t = db.transaction('kv', mode), r = fn(t.objectStore('kv')); t.oncomplete = () => res({ ok: true, v: r && r.result }); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
      } catch (e) {
        if (retry) { dbp = null; return tx(mode, fn, false); }
        return { ok: false };
      }
    };
    return {
      async get(k) { const r = await tx('readonly', s => s.get(k)); if (r.ok && r.v !== undefined) return r.v; return mem.has(k) ? mem.get(k) : null; },
      async set(k, v) { mem.set(k, v); return (await tx('readwrite', s => s.put(v, k))).ok; },
      async del(k) { mem.delete(k); await tx('readwrite', s => s.delete(k)); },
      async available() { await getDb(); return opened; }
    };
  }

  /* ---------- recording a session ---------- */
  /* Records the mic only, never the echo. MediaRecorder on the mic's own stream where the browser has one (iPhone: AAC,
     saved as .m4a), else 16 kHz 16-bit WAV from the same chunks the listener gets (add()). A part comes out about every
     10 s through onPart (a Blob, or an ArrayBuffer of samples); onEnd: the browser stopped it (the mic was cut off). */
  const REC_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  class Recorder {
    constructor(stream, { onPart, onEnd } = {}) {
      this.onPart = onPart || (() => {}); this.onEnd = onEnd || (() => {});
      this.t0 = Date.now(); this.t1 = 0; this.samples = 0; this.asked = false; this.over = false;
      const MR = G.MediaRecorder;
      if (stream && MR) {
        const type = REC_TYPES.find(t => { try { return MR.isTypeSupported(t); } catch (e) { return false; } }) || '';
        let mr;
        try { mr = new MR(stream, Object.assign({ audioBitsPerSecond: 32000 }, type ? { mimeType: type } : {})); } catch (e) { mr = new MR(stream); }
        this.kind = 'mr'; this.mr = mr;
        this.mime = String(mr.mimeType || type || 'audio/mp4').split(';')[0].trim() || 'audio/mp4';
        this.done = new Promise(res => { mr.onstop = () => { this.confirmed = true; this._end(); res(); if (!this.asked) this.onEnd(); }; }); // confirmed: every part has come
        mr.ondataavailable = e => { if (e.data && e.data.size) this.onPart(e.data); };
        mr.onerror = () => { try { if (mr.state !== 'inactive') mr.stop(); } catch (e) {} };
        mr.start(10000);
      } else {
        this.kind = 'wav'; this.mime = 'audio/wav'; this.buf = new Int16Array(160000); this.n = 0; this.done = Promise.resolve(); this.confirmed = true;
      }
    }
    _end() { if (!this.over) { this.over = true; this.t1 = Date.now(); } }
    /* The WAV path: the mic's 16 kHz chunks. */
    add(x) {
      if (this.kind !== 'wav' || this.over) return;
      for (let i = 0; i < x.length; i++) { const v = x[i] < -1 ? -1 : x[i] > 1 ? 1 : x[i]; this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff; if (this.n === this.buf.length) this._flush(); }
      this.samples += x.length;
    }
    _flush() { if (this.n) { this.onPart(this.buf.slice(0, this.n).buffer); this.n = 0; } }
    /* Seconds recorded so far. */
    sec() { return this.kind === 'wav' ? this.samples / 16000 : ((this.over ? this.t1 : Date.now()) - this.t0) / 1000; }
    /* Stops it; resolves once the last part has been handed over (a browser that never says so: after 4 s). */
    stop() {
      this.asked = true;
      if (this.kind === 'wav') { if (!this.over) { this._flush(); this._end(); } return this.done; }
      try { if (this.mr.state !== 'inactive') this.mr.stop(); } catch (e) {}
      return Promise.race([this.done, new Promise(r => setTimeout(r, 4000))]).then(() => this._end());
    }
  }
  /* The 44 bytes in front of 16 kHz mono 16-bit samples that make them a .wav file. */
  function wavHeader(bytes, rate = 16000) {
    const h = new DataView(new ArrayBuffer(44)), w = (o, t) => { for (let i = 0; i < 4; i++) h.setUint8(o + i, t.charCodeAt(i)); };
    w(0, 'RIFF'); h.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
    h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, bytes, true);
    return h.buffer;
  }
  /* Recordings' parts, straight to IndexedDB (no copy kept in memory, unlike openStore). A part's key is
     `${clip}:${00000}`, so a clip's parts come back in order. */
  function openBlobs(name) {
    let dbp = null;
    const open = () => new Promise((res, rej) => {
      if (!G.indexedDB) { rej(new Error('no IndexedDB')); return; }
      const r = G.indexedDB.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('parts');
      r.onsuccess = () => { const db = r.result; db.onclose = () => { dbp = null; }; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
      r.onerror = () => rej(r.error || new Error('open failed')); r.onblocked = () => rej(new Error('blocked'));
    });
    const getDb = () => (dbp = dbp || open().catch(e => { dbp = null; throw e; }));
    const tx = async (mode, fn, retry = true) => {
      const db = await getDb();
      try {
        return await new Promise((res, rej) => {
          let t; try { t = db.transaction('parts', mode); } catch (e) { rej(e); return; }
          const r = fn(t.objectStore('parts')); t.oncomplete = () => res(r && r.result);
          t.onerror = ev => rej((ev && ev.target && ev.target.error) || t.error || new Error('IndexedDB error')); t.onabort = () => rej(t.error || new Error('aborted')); // a request's own error (QuotaExceededError): t.error is still null then
        });
      } catch (e) {
        if (retry && e && e.name === 'InvalidStateError') { dbp = null; return tx(mode, fn, false); } // Safari dropped the connection
        throw e;
      }
    };
    const range = id => G.IDBKeyRange.bound(id + ':', id + ':\uffff');
    return {
      put: (key, buf) => tx('readwrite', s => s.put(buf, key)),
      parts: id => tx('readonly', s => s.getAll(range(id))),
      count: id => tx('readonly', s => s.count(range(id))),
      keys: () => tx('readonly', s => s.getAllKeys()),
      del: id => tx('readwrite', s => s.delete(range(id)))
    };
  }

  /* Backup files: typed arrays become base64 inside plain JSON. */
  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  function pack(v) {
    if (v instanceof Float32Array) return { __f32: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
    if (Array.isArray(v)) return v.map(pack);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = pack(v[k]); return o; }
    return v;
  }
  function unpack(v) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.__f32 === 'string') { const u = unb64(v.__f32); return new Float32Array(u.buffer, 0, u.byteLength >> 2); }
    if (Array.isArray(v)) return v.map(unpack);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = unpack(v[k]); return o; }
    return v;
  }

  S.mic = { MicEngine, FakeMic, openStore, openBlobs, Recorder, wavHeader, pack, unpack };
})(typeof globalThis !== 'undefined' ? globalThis : self);
