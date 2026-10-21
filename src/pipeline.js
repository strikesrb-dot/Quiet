/* Samt pipeline: Listener (features + speech detection), PhraseBook (allowed phrases),
   Teacher (setup recordings) and Controller (live echo decisions). */
(function (G) {
  'use strict';
  const S = G.Samt || (G.Samt = {});
  const { FeatureStream, VAD } = S.dsp;
  const { st, Spotter } = S.models;
  const D = 26;

  class Listener {
    constructor() { this.consumer = null; this.tmp = new Float32Array(D); this.reset(); }
    reset() { this.fs = new FeatureStream({ keepSeconds: 16 }); this.vad = new VAD(); this.sp = new Uint8Array(this.fs.cap); this.level = -90; this.speech = false; }
    isSpeech(f) { return this.sp[f % this.fs.cap] === 1; }
    push(chunk) {
      const fs = this.fs, before = fs.nFrames;
      fs.push(chunk);
      for (let f = before; f < fs.nFrames; f++) {
        const e = fs.energy(f), r = this.vad.push(f, e);
        this.sp[f % fs.cap] = r.speech ? 1 : 0; this.level = e; this.speech = r.active;
        if (r.event && this.consumer) this.consumer.onVad(r.event);
        if (f >= 2 && this.consumer) this.consumer.onReady(f - 2);
      }
    }
    /* Copy frames [a, b] (inclusive) into a segment object. */
    segment(a, b, withSamples) {
      const fs = this.fs; a = Math.max(a, fs.nFrames - fs.cap + 3); const n = Math.max(0, b - a + 1);
      const seg = { n, vec: new Float32Array(n * D), f0: new Float32Array(n), eDb: new Float32Array(n), start: a, end: b };
      for (let i = 0; i < n; i++) { fs.vec(a + i, seg.vec, i * D); seg.f0[i] = fs.pitch(a + i); seg.eDb[i] = fs.energy(a + i); }
      if (withSamples) seg.samples = fs.getSamples(a * 160, b * 160 + 400);
      return seg;
    }
    samples(a, b) { return this.fs.getSamples(a * 160, b * 160 + 400); }
  }

  const DEFAULT_PHRASES = [
    { id: 'hi', label: 'Hi', group: 'Greetings' }, { id: 'hello', label: 'Hello', group: 'Greetings' },
    { id: 'how_are_you', label: 'How are you?', group: 'Greetings' }, { id: 'im_good', label: "I'm good, thanks", group: 'Greetings' },
    { id: 'salam', label: 'السلام عليكم', group: 'Greetings', rtl: true },
    { id: 'salam_reply', label: 'وعليكم السلام', group: 'Greetings', rtl: true },
    { id: 'thank_you', label: 'Thank you', group: 'Thanks' },
    { id: 'jazak', label: 'جزاك الله خيرًا', group: 'Thanks', rtl: true },
    { id: 'welcome', label: "You're welcome", group: 'Thanks' },
    { id: 'yes', label: 'Yes', group: 'Short answers' }, { id: 'no', label: 'No', group: 'Short answers' }, { id: 'okay', label: 'Okay', group: 'Short answers' }
  ];

  class PhraseBook {
    constructor() { this.phrases = DEFAULT_PHRASES.map(p => Object.assign({ takes: [], thr: null }, p)); this.mean = null; this.sd = null; this.sens = 1; }
    setStats(segs) {
      let N = 0; const m = new Float64Array(D), v = new Float64Array(D);
      for (const s of segs) for (let i = 0; i < s.n; i++) for (let d = 0; d < D; d++) { m[d] += s.vec[i * D + d]; N++; }
      if (!N) return; N /= D;
      for (let d = 0; d < D; d++) m[d] /= N;
      for (const s of segs) for (let i = 0; i < s.n; i++) for (let d = 0; d < D; d++) { const t = s.vec[i * D + d] - m[d]; v[d] += t * t; }
      this.mean = Float32Array.from(m); this.sd = Float32Array.from(v, x => Math.sqrt(x / N) || 1);
    }
    norm(v, out) {
      out = out || new Float32Array(D);
      for (let d = 0; d < D; d++) out[d] = this.mean ? (v[d] - this.mean[d]) / this.sd[d] : v[d];
      return out;
    }
    normSeg(seg, maxN) {
      const n = Math.min(seg.n, maxN || seg.n), o = new Float32Array(n * D), tmp = new Float32Array(D);
      for (let i = 0; i < n; i++) { for (let d = 0; d < D; d++) tmp[d] = seg.vec[i * D + d]; o.set(this.norm(tmp), i * D); }
      return { n, data: o };
    }
    get(id) { return this.phrases.find(p => p.id === id); }
    add(label) { const id = 'p' + Date.now().toString(36); this.phrases.push({ id, label, group: 'Your phrases', takes: [], thr: null, custom: true, rtl: /[؀-ۿ]/.test(label) }); return id; }
    remove(id) { this.phrases = this.phrases.filter(p => p.id !== id); }
    _bestEnd(obs, tpls) {
      const sp = new Spotter(tpls.map(t => ({ id: 0, phrase: '', L: t.n, data: t.data, thr: 1 })), D); sp.slack = 0;
      for (let i = 0; i < obs.n; i++) sp.push(obs.data.subarray(i * D, i * D + D));
      let b = Infinity; for (const s of sp.st) if (s.bestEnd < b) b = s.bestEnd; return b;
    }
    /* Pick a match threshold for each phrase from its own takes (should match) and from ordinary
       speech plus other phrases (should not). */
    calibrate(normalSegs) {
      const ready = this.phrases.filter(p => p.takes.length >= 2);
      const T = new Map(ready.map(p => [p.id, p.takes.map(t => this.normSeg(t))]));
      for (const p of ready) {
        const tp = T.get(p.id), maxL = Math.max(...tp.map(t => t.n)), intra = [], imp = [];
        for (let a = 0; a < tp.length; a++) for (let b = 0; b < tp.length; b++) if (a !== b) intra.push(this._bestEnd(tp[a], [tp[b]]));
        for (const s of normalSegs || []) imp.push(this._bestEnd(this.normSeg(s, Math.ceil(maxL * 1.6) + 10), tp));
        for (const q of ready) if (q.id !== p.id && q.group !== p.group) for (const t of T.get(q.id)) imp.push(this._bestEnd(t, tp));
        const hi = Math.max(...intra.filter(isFinite));
        const lo = imp.filter(isFinite).length ? st.pct(imp.filter(isFinite), 0.05) : Infinity;
        let thr = !isFinite(lo) ? hi * 1.25 : hi < lo ? hi + 0.5 * (lo - hi) : 0.5 * (st.mean(intra) + lo);
        p.thr = Math.max(thr, 0.2); p.calib = { intra: +hi.toFixed(3), imp5: isFinite(lo) ? +lo.toFixed(3) : null };
      }
    }
    templates() {
      const out = [];
      for (const p of this.phrases) {
        if (p.takes.length < 2 || !p.thr) continue;
        p.takes.forEach((t, k) => { const nt = this.normSeg(t); out.push({ id: p.id + ':' + k, phrase: p.id, label: p.label, L: nt.n, data: nt.data, thr: p.thr * this.sens }); });
      }
      return out;
    }
    toJSON() {
      return { mean: this.mean && Array.from(this.mean), sd: this.sd && Array.from(this.sd), sens: this.sens,
        phrases: this.phrases.map(p => ({ id: p.id, label: p.label, hint: p.hint, group: p.group, rtl: p.rtl, custom: p.custom, thr: p.thr, calib: p.calib, takes: p.takes.map(t => ({ n: t.n, vec: t.vec })) })) };
    }
    static fromJSON(o) {
      const b = new PhraseBook(); b.mean = o.mean ? Float32Array.from(o.mean) : null; b.sd = o.sd ? Float32Array.from(o.sd) : null; b.sens = o.sens || 1;
      b.phrases = o.phrases.map(p => Object.assign({}, p, { takes: p.takes.map(t => ({ n: t.n, vec: t.vec instanceof Float32Array ? t.vec : Float32Array.from(t.vec) })) }));
      return b;
    }
  }

  /* Collects speech for setup. 'collect' mode keeps every segment; 'take' mode joins speech separated
     by short pauses into one take (a phrase like "I'm good, thanks") and reports it after 0.45 s of quiet. */
  class Teacher {
    constructor(listener) { this.L = listener; this.segs = []; this.on = false; }
    begin({ mode = 'collect', onSegment, onTake, withSamples }) {
      this.mode = mode; this.segs = []; this.on = true; this.cb = onSegment; this.onTake = onTake; this.withSamples = withSamples;
      this.take = null; this.L.consumer = this;
    }
    end() { this.on = false; this.take = null; return this.segs; }
    onReady(fr) {
      const t = this.take;
      if (!this.on || !t || t.waitUntil == null || fr < t.waitUntil) return;
      this.take = null;
      const n = t.end - t.start + 1;
      if (n < 15 || n > 600) { if (this.onTake) this.onTake(null, n < 15 ? 'short' : 'long'); return; }
      const seg = this.L.segment(t.start, t.end, this.withSamples);
      this.segs.push(seg); if (this.onTake) this.onTake(seg);
    }
    onVad(ev) {
      if (!this.on) return;
      if (this.mode === 'take') {
        if (ev.type === 'onset') { if (!this.take) this.take = { start: ev.frame, end: null, waitUntil: null }; else this.take.waitUntil = null; }
        else if (this.take) { this.take.end = ev.frame; this.take.waitUntil = ev.frame + 30 + 15; }
        return;
      }
      if (ev.type !== 'offset') return;
      const n = ev.frame - ev.start + 1;
      if (n < 15) return;
      const seg = this.L.segment(Math.max(ev.start, ev.frame - 1500), ev.frame, this.withSamples);
      this.segs.push(seg); if (this.cb) this.cb(seg, this.segs);
    }
  }

  class Controller {
    constructor({ listener, voice, book, onEcho, onEvent, params }) {
      this.L = listener; this.voice = voice; this.book = book; this.onEcho = onEcho || (() => {}); this.onEvent = onEvent || (() => {});
      this.p = Object.assign({ minTalk: 50, contGap: 120, recheckWin: voice.kind === 'neural' ? 100 : 60 }, params || {});
      this.tmp = new Float32Array(D);
    }
    start(mode) {
      this.mode = mode; this.seg = null; this.lastEnd = -1e9; this.lastEcho = false; this.segId = 0; this.history = [];
      this.counts = { talk: 0, talkSec: 0, pass: 0, short: 0, other: 0 };
      this.spotter = new Spotter(this.book ? this.book.templates() : [], D);
      this.adaptQueue = []; this.L.consumer = this; this.on = true; this._state('listening');
    }
    stop() { if (this.seg && this.seg.echo) this._echo(false); this.on = false; this.seg = null; }
    /* The mic went away mid-speech: end the current segment now. */
    cut() { const seg = this.seg; if (!seg) return; seg.end = Math.max(seg.start, seg.next - 1); this._finish(); }
    _state(state, extra) { this.onEvent(Object.assign({ type: 'state', state }, extra || {})); }
    _echo(open) { if (this.mode === 'silence') this.onEcho(open); }
    onVad(ev) {
      if (!this.on) return;
      if (ev.type === 'onset') this._onset(ev.frame);
      else if (this.seg) { this.seg.end = ev.frame; this._finish(); }
    }
    onReady(fr) {
      const seg = this.seg; if (!this.on || !seg) return;
      while (this.seg === seg && seg.next <= fr && (seg.end == null || seg.next <= seg.end)) this._step(seg.next++);
    }
    _onset(s) {
      const seg = this.seg = { id: ++this.segId, start: s, next: s, end: null, speaker: 'unknown', tentative: false, pending: false, lastCheck: s, echo: false, uncovered: false,
        cursor: s, obs: [], passes: [], scores: [], margins: [], embs: [], neg: 0, pos: 0 };
      this.spotter.reset();
      if (this.lastEcho && s - this.lastEnd <= this.p.contGap) { seg.speaker = 'me'; seg.tentative = true; seg.uncovered = true; this._open(s); }
      else this._state('holding');
    }
    _step(f) {
      const seg = this.seg, v = this.voice;
      if (!seg.echo && seg.speaker !== 'other') {
        if (this.spotter.T.length && !seg.obs.length && !this.L.isSpeech(f)) seg.cursor = f + 1; // skip pauses before the next phrase
        else if (this.spotter.T.length) {
          const o = this.book.norm(this.L.fs.vec(f, this.tmp));
          seg.obs.push(o); this._phrase(this.spotter.push(o), f);
        } else if (f - seg.cursor + 1 >= this.p.minTalk) seg.uncovered = true;
      }
      const len = f - seg.start + 1;
      if (!seg.pending) {
        if ((seg.speaker === 'unknown' || seg.tentative) && len >= v.minFrames) this._verdict(seg, seg.start, f);
        else if (seg.speaker !== 'unknown' && !seg.tentative && f - seg.lastCheck >= v.recheck) this._verdict(seg, Math.max(seg.start, f - this.p.recheckWin + 1), f);
      }
      if (!seg.echo && seg.speaker === 'me' && seg.uncovered) this._open(f);
    }
    _phrase(r, f) {
      const seg = this.seg;
      for (let guard = 0; guard < 6; guard++) {
        if (r.complete && !r.inProgress && seg.passes.length < 3) {
          const c = r.complete, rest = seg.obs.slice(c.end + 1);
          seg.passes.push(c.phrase); this.counts.pass++;
          this.onEvent({ type: 'phrase', phrase: c.phrase, ratio: c.ratio });
          seg.cursor += c.end + 1; seg.obs = []; seg.free = 0; seg.uncovered = false; this.spotter.reset();
          if (!rest.length) return;
          for (const o of rest) { seg.obs.push(o); r = this.spotter.push(o); }
          continue;
        }
        break;
      }
      // talk that no phrase explains for a few frames in a row, after the minimum talk time, opens the echo
      if ((!r.inProgress && !r.complete) || seg.passes.length >= 3) seg.free = (seg.free || 0) + 1; else seg.free = 0;
      seg.uncovered = seg.free >= 5 && f - seg.cursor + 1 >= this.p.minTalk;
    }
    _open(f) {
      const seg = this.seg; seg.echo = true; seg.echoAt = f; this.counts.talk++;
      this._echo(true); this._state('echo');
    }
    _close() { const seg = this.seg; if (!seg || !seg.echo) return; seg.echo = false; this.counts.talk--; this._echo(false); }
    _verdict(seg, a, b) {
      seg.pending = true; seg.lastCheck = b;
      const v = this.voice;
      if (v.kind === 'light') { const sub = this.L.segment(a, b); this._onVerdict(seg, v.score(sub, 0, sub.n)); }
      else { const smp = this.L.samples(a, b); this.pendingP = v.scoreSamples(smp).then(r => { this.pendingP = null; this._onVerdict(seg, r); }, () => { this.pendingP = null; seg.pending = false; }); }
    }
    _onVerdict(seg, r) {
      seg.pending = false; if (!r) return;
      seg.scores.push(r.score); seg.margins.push(r.margin); if (r.emb) seg.embs.push(r.emb);
      this.onEvent({ type: 'verdict', isMe: r.isMe, score: r.score, margin: r.margin });
      if (seg !== this.seg) return; // segment already ended
      if (seg.speaker === 'unknown' || seg.tentative) {
        seg.tentative = false; seg.speaker = r.isMe ? 'me' : 'other';
        if (!r.isMe) { if (seg.echo) this._close(); this._state('other'); }
      } else if (r.isMe) { seg.neg = 0; if (seg.speaker === 'other' && ++seg.pos >= 2) { seg.speaker = 'me'; seg.uncovered = true; } }
      else { seg.pos = 0; if (seg.speaker === 'me' && ++seg.neg >= 2) { seg.speaker = 'other'; if (seg.echo) this._close(); this._state('other'); } }
    }
    _finish() {
      const seg = this.seg, e = seg.end;
      while (seg.next <= e) this._step(seg.next++);
      const n = e - seg.start + 1;
      if (seg.speaker === 'unknown' && n >= 25 && this.voice.kind === 'light') { const sub = this.L.segment(seg.start, e); const r = this.voice.score(sub, 0, sub.n); seg.speaker = r.isMe ? 'me' : 'other'; seg.scores.push(r.score); seg.margins.push(r.margin); }
      const wasEcho = seg.echo;
      if (wasEcho) { this.counts.talkSec += (e - seg.echoAt + 1) / 100; this._echo(false); }
      else if (seg.speaker === 'other') this.counts.other++;
      else if (!seg.passes.length && n >= 15) this.counts.short++;
      const rec = { id: seg.id, start: seg.start, end: e, speaker: seg.speaker, echo: wasEcho, passes: seg.passes.slice(), scores: seg.scores.slice(), margins: seg.margins.slice(), embs: seg.embs };
      if (this.voice.kind === 'light' && n >= 30) rec.data = this.L.segment(Math.max(seg.start, e - 600), e);
      if (this.voice.kind === 'neural' && n >= 40) rec.samples = this.L.samples(Math.max(seg.start, e - 600), e);
      for (const h of this.history) { h.samples = null; } // audio is kept only for the newest record (for That was me / Not me)
      this.history.push(rec); if (this.history.length > 30) this.history.shift();
      if (seg.speaker === 'me' && seg.margins.length && Math.min(...seg.margins) >= 1) { this.adaptQueue.push(rec); if (this.adaptQueue.length > 40) this.adaptQueue.shift(); }
      this.lastEcho = wasEcho && seg.speaker === 'me'; this.lastEnd = e; this.seg = null;
      this.onEvent({ type: 'segment', rec, counts: this.counts });
      this._state('listening');
    }
  }

  S.pipeline = { Listener, PhraseBook, Teacher, Controller, DEFAULT_PHRASES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
