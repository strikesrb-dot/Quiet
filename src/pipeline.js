/* Samt pipeline: Listener (features + speech detection), PhraseBook (allowed phrases; no longer offered in the app,
   so the Controller runs without one), Teacher (setup recordings), Controller (live echo decisions by voice) and
   LevelGate (live echo decisions by sound level). */
(function (G) {
  'use strict';
  const S = G.Samt || (G.Samt = {});
  const { FeatureStream, VAD } = S.dsp;
  const { st, Spotter } = S.models;
  const D = 26;
  /* A session's numbers. Both deciders add to the same object, so switching mid-session keeps them. */
  const newCounts = () => ({ talk: 0, talkSec: 0, pass: 0, short: 0, other: 0, interrupt: 0, nudge: 0, freePass: 0, meSec: 0, otherSec: 0, talkTime: 0 });

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
    /* params: limit = frames of talk allowed in one turn before the echo (0 = right away); interrupt = echo at once when
       you talk over someone; nudge = a soft tone first, then the echo nudgeGrace frames of talk later. */
    constructor({ listener, voice, book, onEcho, onEvent, onNudge, params }) {
      this.L = listener; this.voice = voice; this.book = book; this.onEcho = onEcho || (() => {}); this.onEvent = onEvent || (() => {}); this.onNudge = onNudge || (() => {});
      this.p = Object.assign({ minTalk: 50, contGap: 120, recheckWin: voice.kind === 'neural' ? 100 : 60, limit: 0, interrupt: false, nudge: false, nudgeGrace: 250, turnGap: 150 }, params || {});
      this.tmp = new Float32Array(D);
    }
    /* counts and lastMeEnd carry a session's numbers over when it switches between Your voice and Sound level. */
    start(mode, counts, lastMeEnd) {
      this.mode = mode; this.seg = null; this.lastEnd = -1e9; this.lastEcho = false; this.segId = 0; this.history = [];
      this.counts = counts || newCounts();
      this.turn = { talk: 0, lastMe: -1e9, otherAfter: false, nudged: false }; this.passUntil = -1; this.lastMeEnd = lastMeEnd != null ? lastMeEnd : this.L.fs.nFrames; this.lastOtherEnd = -1e9;
      this.spotter = new Spotter(this.book ? this.book.templates() : [], D);
      this.adaptQueue = []; this.L.consumer = this; this.on = true; this._state('listening');
    }
    stop() { if (this.seg && this.seg.echo) this._echo(false); this.on = false; this.seg = null; }
    /* The mic went away mid-speech: end the current segment now. */
    cut() { const seg = this.seg; if (!seg) return; seg.end = Math.max(seg.start, seg.next - 1); this._finish(); }
    /* After the Listener restarts its frame count (a resume): its frame numbers start again from 0, so the ones kept here
       start again too, keeping Talk freely's time left (`left`, read before the restart). */
    resync(left) {
      if (this.seg && this.seg.echo) this._echo(false);
      const now = this.L.fs.nFrames; this.seg = null; this.lastEnd = -1e9; this.lastEcho = false; this.lastMeEnd = now; this.lastOtherEnd = -1e9;
      this.passUntil = left > 0 ? now + Math.round(left * 100) : -1; this.turn = { talk: 0, lastMe: -1e9, otherAfter: false, nudged: false };
    }
    /* Talk freely for a while: no echo and no nudge until it runs out (quiet: carried over from a switch, not a tap). */
    pass(sec, quiet) {
      this.passUntil = this.L.fs.nFrames + Math.round(sec * 100); if (!quiet) this.counts.freePass++;
      if (this.seg && this.seg.echo) { this.seg.echo = false; this.counts.talk--; this.counts.talkSec += Math.max(0, this.L.fs.nFrames - this.seg.echoAt) / 100; this._echo(false); }
      this.lastEcho = false;
    }
    passLeft() { return Math.max(0, (this.passUntil - this.L.fs.nFrames) / 100); }
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
        cursor: s, obs: [], passes: [], scores: [], margins: [], embs: [], neg: 0, pos: 0, since: s, cred: { me: 0, other: 0 }, otherHits: 0, counted: false };
      this.spotter.reset();
      const t = this.turn;
      if (s - t.lastMe > this.p.turnGap || t.otherAfter) this._newTurn();
      if (this.lastEcho && s - this.lastEnd <= this.p.contGap && s >= this.passUntil) { seg.speaker = 'me'; seg.tentative = true; seg.uncovered = true; this._open(s); }
      else this._state('holding');
    }
    _step(f) {
      const seg = this.seg, v = this.voice;
      if (!seg.echo && seg.speaker !== 'other' && !seg.noSpot) {
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
      if (seg.speaker === 'me' && seg.uncovered) {
        // talk the phrases don't explain counts toward the turn's limit and the day's talk time (from where it began)
        const add = seg.counted ? 1 : Math.max(1, f - seg.cursor + 1); seg.counted = true;
        if (f >= this.passUntil) { this.turn.talk += add; seg.turnF = (seg.turnF || 0) + add; }
        this.counts.talkTime += add / 100; seg.talkF = (seg.talkF || 0) + add;
      }
      this._decide(f);
    }
    _newTurn() { this.turn = { talk: 0, lastMe: this.turn.lastMe, otherAfter: false, nudged: false }; }
    /* Someone else took over from you, or you took over from them, partway through one stretch of sound. */
    _flip(seg, to, at) {
      const from = seg.speaker;
      if (from === 'me' || from === 'other') seg.cred[from] += Math.max(0, at - seg.since);
      seg.since = Math.max(seg.since, at); seg.speaker = to;
    }
    /* When your talking turns on the echo: at once, after the turn's limit, or after a nudge. */
    _decide(f) {
      const seg = this.seg, t = this.turn, p = this.p;
      if (seg.echo || seg.speaker !== 'me' || !seg.uncovered || f < this.passUntil) return;
      if (seg.interrupt && p.interrupt) { this._open(f); return; }
      if (p.nudge) {
        const at = Math.max(0, p.limit - p.nudgeGrace);
        if (!t.nudged) { if (t.talk >= at) { t.nudged = true; this.counts.nudge++; this.onEvent({ type: 'nudge' }); if (this.mode === 'silence') this.onNudge(); } return; }
        if (t.talk >= Math.max(p.limit, at + p.nudgeGrace)) this._open(f);
        return;
      }
      if (t.talk >= p.limit) this._open(f);
    }
    _interrupted(seg) {
      if (seg.interrupt) return;
      seg.interrupt = true; this.counts.interrupt++; this.onEvent({ type: 'interrupt' });
    }
    _phrase(r, f) {
      const seg = this.seg;
      for (let guard = 0; guard < 6; guard++) {
        if (r.complete && !r.inProgress && seg.passes.length < 3) {
          const c = r.complete, rest = seg.obs.slice(c.end + 1);
          seg.passes.push(c.phrase); this.counts.pass++;
          this.onEvent({ type: 'phrase', phrase: c.phrase, ratio: c.ratio });
          seg.cursor += c.end + 1; seg.obs = []; seg.free = 0; seg.uncovered = false; seg.counted = false; this.spotter.reset();
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
      if (v.kind === 'light') { const sub = this.L.segment(a, b); this._onVerdict(seg, v.score(sub, 0, sub.n), a); }
      else { const smp = this.L.samples(a, b); this.pendingP = v.scoreSamples(smp).then(r => { this.pendingP = null; this._onVerdict(seg, r, a); }, () => { this.pendingP = null; seg.pending = false; }); }
    }
    _onVerdict(seg, r, a) {
      seg.pending = false; if (!r) return;
      seg.scores.push(r.score); seg.margins.push(r.margin); if (r.emb) seg.embs.push(r.emb);
      this.onEvent({ type: 'verdict', isMe: r.isMe, score: r.score, margin: r.margin });
      if (seg !== this.seg) return; // segment already ended
      if (seg.speaker === 'unknown' || seg.tentative) {
        seg.tentative = false; seg.speaker = r.isMe ? 'me' : 'other';
        if (!r.isMe) { seg.otherHits = r.margin <= -1 ? 1 : 0; seg.need = 2; if (seg.echo) this._close(); this._state('other'); } // only a clear 'someone else' counts
      } else if (r.isMe) {
        seg.neg = 0;
        if (seg.speaker === 'other') {
          if (++seg.pos === 1) seg.posFrom = a;
          // after a clear 'someone else', the light model needs a third check that it is you now (its checks are half as long)
          if (seg.pos >= (seg.otherHits >= 2 && this.voice.kind !== 'neural' ? 3 : 2)) {
            // someone else was clearly talking (two checks) and you came in over them: that is talking over someone
            const over = seg.otherHits >= (seg.need || 2);
            this._flip(seg, 'me', seg.posFrom); this._newTurn();
            seg.cursor = seg.since; seg.uncovered = true; seg.counted = false; seg.noSpot = true; // a second or more of you: not a short phrase
            if (over) this._interrupted(seg);
          }
        }
      } else {
        seg.pos = 0;
        if (seg.speaker === 'other') { if (r.margin <= -1) seg.otherHits++; }
        else if (seg.speaker === 'me') {
          if (++seg.neg === 1) seg.negFrom = a;
          // a stretch that began as you and turned into someone else: it takes 3 more clear checks of them before
          // coming back in counts as talking over them (a short wobble of the model is not)
          if (seg.neg >= 2) { this._flip(seg, 'other', seg.negFrom); seg.otherHits = 0; seg.need = 3; this.turn.otherAfter = true; if (seg.echo) this._close(); this._state('other'); }
        }
      }
    }
    _finish() {
      const seg = this.seg, e = seg.end;
      while (seg.next <= e) this._step(seg.next++);
      // the frames after the last word (the pause that ended the stretch) were counted as talk while it ran: take them back
      const over = Math.max(0, seg.next - 1 - e);
      if (over && seg.counted && seg.speaker === 'me') {
        const d = Math.min(over, seg.talkF || 0), dt = Math.min(over, seg.turnF || 0);
        this.counts.talkTime = Math.max(0, this.counts.talkTime - d / 100); this.turn.talk = Math.max(0, this.turn.talk - dt);
      }
      const n = e - seg.start + 1;
      if (seg.speaker === 'unknown' && n >= 25 && this.voice.kind === 'light') { const sub = this.L.segment(seg.start, e); const r = this.voice.score(sub, 0, sub.n); seg.speaker = r.isMe ? 'me' : 'other'; seg.scores.push(r.score); seg.margins.push(r.margin); }
      const wasEcho = seg.echo;
      if (seg.speaker === 'me' || seg.speaker === 'other') seg.cred[seg.speaker] += Math.max(0, e - seg.since + 1);
      this.counts.meSec += seg.cred.me / 100; this.counts.otherSec += seg.cred.other / 100;
      if (seg.speaker === 'me') { this.lastMeEnd = e; this.turn.lastMe = e; }
      else if (seg.cred.me) { this.lastMeEnd = seg.since; this.turn.lastMe = seg.since; }
      if (seg.speaker === 'other') { this.lastOtherEnd = e; this.turn.otherAfter = true; }
      else if (seg.cred.other) this.lastOtherEnd = seg.since;
      if (wasEcho) { this.counts.talkSec += (e - seg.echoAt + 1) / 100; this._echo(false); }
      else if (seg.speaker === 'other') this.counts.other++;
      else if (!seg.passes.length && n >= 15) this.counts.short++;
      const rec = { id: seg.id, start: seg.start, end: e, speaker: seg.speaker, echo: wasEcho, interrupt: !!seg.interrupt, passes: seg.passes.slice(), scores: seg.scores.slice(), margins: seg.margins.slice(), embs: seg.embs };
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

  /* Sound level: no voice check. Any sound over the line opens the echo at once and holds it through short dips (the
     hold outlasts the echo's delay, so a word's end is never cut); anything under the line is ignored. It measures the
     raw 16 kHz audio itself (push), after the muted pitches are cut, in 10 ms frames, so it answers within a few frames.
     It opens after 30 ms over the line, so a click doesn't; the level it holds on is the last 30 ms.
     The Listener's speech detection (onVad) only marks stretches, for the counts and the check. Same surface as the
     Controller, so the session, Details and the check use either one. */
  class LevelGate {
    constructor({ listener, onEcho, onEvent, onNudge, params }) {
      this.L = listener; this.onEcho = onEcho || (() => {}); this.onEvent = onEvent || (() => {}); this.onNudge = onNudge || (() => {});
      this.p = Object.assign({ line: -40, hold: 35, gap: 30, limit: 0, nudge: false, nudgeGrace: 250, turnGap: 150 }, params || {});
      this.kind = 'level'; this.level = -90; this.filters = []; this.ring = new Uint8Array(1600); this.collect = null;
    }
    setNotches(tones) { this.filters = (tones || []).map(t => S.dsp.notch(t.f, t.q, 16000)); }
    start(mode, counts, lastMeEnd) {
      this.mode = mode; this.on = true; this.f = Math.floor(this.L.fs.sTotal / 160); this.acc = 0; this.bn = 0; this.pw = [0, 0, 0];
      this.counts = counts || newCounts();
      this.isOpen = false; this.over = false; this.run = 0; this.lastOver = -1e9; this.st = null; this.seg = null; this.segId = 0;
      this.turn = { talk: 0, nudged: false }; this.otherAfter = false; this.passUntil = -1;
      this.lastMeEnd = lastMeEnd != null ? lastMeEnd : this.f; this.adaptQueue = []; this.history = [];
      this.ring.fill(0); this.L.consumer = this; this._state('listening');
    }
    stop() { if (this.isOpen) this._setOpen(false, this.f); this.on = false; this.seg = null; }
    /* The mic went away, or the session ends: close the stretch still going. */
    cut() { if (this.seg) this._endSeg(this.f - 1); }
    /* After the Listener restarts its frame count (a resume): count frames from there, keeping Talk freely's time left
       (`left`, read before the restart). */
    resync(left) {
      if (left == null) left = this.passLeft(); if (this.isOpen) this._setOpen(false, this.f);
      this.f = Math.floor(this.L.fs.sTotal / 160); this.acc = 0; this.bn = 0; this.pw = [0, 0, 0]; this.over = false; this.run = 0; this.under = 0;
      this.lastOver = -1e9; this.lastMeEnd = this.f; this.passUntil = left > 0 ? this.f + Math.round(left * 100) : -1; this.seg = null; this.st = null; this.ring.fill(0);
    }
    pass(sec, quiet) { this.passUntil = this.f + Math.round(sec * 100); if (!quiet) this.counts.freePass++; if (this.isOpen) { this.counts.talk--; this._setOpen(false, this.f); } }
    passLeft() { return Math.max(0, (this.passUntil - this.f) / 100); }
    frameNow() { return this.f; }
    talking() { return this.over; }
    push(chunk) {
      if (!this.on) return;
      const F = this.filters;
      for (let i = 0; i < chunk.length; i++) {
        let v = chunk[i]; for (let j = 0; j < F.length; j++) v = F[j](v);
        this.acc += v * v;
        if (++this.bn === 160) { this._frame(this.acc / 160); this.acc = 0; this.bn = 0; }
      }
    }
    _frame(power) {
      const f = this.f++, p = this.p, pw = this.pw;
      pw[f % 3] = power; const db = 10 * Math.log10((pw[0] + pw[1] + pw[2]) / 3 + 1e-12); this.level = db;
      // opening takes three 10 ms frames in a row over the line on their own (30 ms of sound), so a click can't; once
      // open, the 30 ms level keeps it open
      const above = db >= p.line; this.run = 10 * Math.log10(power + 1e-12) >= p.line ? this.run + 1 : 0;
      if (above && (this.over || this.run >= 3)) {
        if (!this.over && (f - this.lastOver > p.turnGap || this.otherAfter)) { this.turn = { talk: 0, nudged: false }; this.otherAfter = false; } // a new turn
        const add = f - this.lastOver <= p.gap ? f - this.lastOver : 1; // short dips between words count as talk
        this.counts.talkTime += add / 100; this.counts.meSec += add / 100;
        if (f >= this.passUntil) this.turn.talk += add;
        this.over = true; this.lastOver = f; this.lastMeEnd = f;
      } else if (this.over && f - this.lastOver > p.hold) this.over = false;
      // someone under the line talked after you (half a second of it, so the quiet end of your own words doesn't count)
      this.under = !above && !this.over && this.L.speech ? (this.under || 0) + 1 : 0;
      if (this.under >= 50) this.otherAfter = true;
      if (this.collect && this.L.speech && this.collect.length < 6000) this.collect.push(db);
      this._decide(f);
      this.ring[f % 1600] = (above ? 1 : 0) | (this.isOpen ? 2 : 0);
      const s = this.isOpen ? 'echo' : this.over ? 'hold' : this.L.speech ? 'other' : 'listening';
      if (s !== this.st) { this.st = s; this._state(s); }
    }
    /* Silence: the echo whenever it's over the line. Conversation: the turn's talk first, with a nudge before the end. */
    _decide(f) {
      const p = this.p, t = this.turn;
      let want = this.over && f >= this.passUntil;
      if (want && p.limit > 0) {
        if (p.nudge) {
          const at = Math.max(0, p.limit - p.nudgeGrace);
          if (!t.nudged) { if (t.talk >= at) { t.nudged = true; this.counts.nudge++; this.onEvent({ type: 'nudge' }); if (this.mode !== 'test') this.onNudge(); } want = false; }
          else want = t.talk >= Math.max(p.limit, at + p.nudgeGrace);
        } else want = t.talk >= p.limit;
      }
      if (want !== this.isOpen) this._setOpen(want, f);
    }
    _setOpen(open, f) {
      this.isOpen = open;
      if (open) { this.counts.talk++; this.echoAt = f; } else this.counts.talkSec += Math.max(0, f - this.echoAt) / 100;
      if (this.mode !== 'test') this.onEcho(open);
    }
    _state(state) { this.onEvent({ type: 'state', state }); }
    onReady() {}
    onVad(ev) {
      if (!this.on) return;
      if (ev.type === 'onset') this.seg = { id: ++this.segId, start: ev.frame, speaker: 'unknown' };
      else if (this.seg) this._endSeg(ev.frame);
    }
    /* A stretch of talk ended: it was you if a quarter of it was over the line; it echoed if the echo opened in it. */
    _endSeg(e) {
      const g = this.seg; this.seg = null;
      const s = Math.max(g.start, e - 1500); let n = 0, open = false;
      for (let f = s; f <= e; f++) { const r = this.ring[f % 1600]; if (r & 1) n++; if (r & 2) open = true; }
      const me = n >= Math.max(5, 0.25 * (e - s + 1));
      if (!me) { this.counts.other++; this.counts.otherSec += (e - g.start + 1) / 100; }
      const rec = { id: g.id, start: g.start, end: e, speaker: me ? 'me' : 'other', echo: open, interrupt: false, passes: [], scores: [], margins: [], embs: [] };
      this.history.push(rec); if (this.history.length > 30) this.history.shift();
      this.onEvent({ type: 'segment', rec, counts: this.counts });
    }
  }

  S.pipeline = { Listener, PhraseBook, Teacher, Controller, LevelGate, DEFAULT_PHRASES };
})(typeof globalThis !== 'undefined' ? globalThis : self);
