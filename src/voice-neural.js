/* Samt Neural voice model: on-device speaker embeddings (WeSpeaker ResNet34, 8-bit weights, via onnxruntime-web). */
(function (G) {
  'use strict';
  const S = G.Samt || (G.Samt = {});
  const { st } = S.models;
  const FB = { numBins: 80, window: 'hamming', lowFreq: 20, highFreq: 0, scale: 32768, cmn: true };

  function normalize(v) { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; s = Math.sqrt(s) || 1; const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / s; return o; }
  function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function meanVec(list) { const o = new Float32Array(list[0].length); for (const v of list) for (let i = 0; i < o.length; i++) o[i] += v[i]; return normalize(o); }
  function wins(seg, W, hop) {
    const out = [];
    if (seg.n < W) { if (seg.n >= Math.floor(W * 0.6)) out.push([0, seg.n]); return out; }
    for (let s = 0; s + W <= seg.n; s += hop) out.push([s, W]);
    return out;
  }
  function slice(seg, s, n) { return seg.samples.subarray(s * 160, Math.min(seg.samples.length, (s + n) * 160 + 240)); }

  class NeuralVoice {
    constructor() { this.kind = 'neural'; this.minFrames = 60; this.recheck = 100; this.strict = 0; this.ready = false; this.pool = []; this.adapted = []; }
    attach(ort, session) { this.ort = ort; this.sess = session; this.inName = session.inputNames[0]; this.outName = session.outputNames[0]; }
    async embed(samples) {
      const fb = S.dsp.fbank(samples, FB);
      if (fb.T < 20) return null;
      const out = await this.sess.run({ [this.inName]: new this.ort.Tensor('float32', fb.data, [1, fb.T, 80]) });
      return normalize(out[this.outName].data);
    }
    async train(meSegs, othSegs, onProgress) {
      othSegs = othSegs || [];
      const jobs = [];
      meSegs.forEach((seg, i) => { for (const [s, n] of wins(seg, 150, 150)) jobs.push({ k: 'c', i, seg, s, n }); for (const [s, n] of wins(seg, 60, 60)) jobs.push({ k: 'p', i, seg, s, n }); });
      othSegs.forEach((seg, i) => { for (const [s, n] of wins(seg, 60, 60)) jobs.push({ k: 'n', i, seg, s, n }); });
      const C = [], P = [], N = [];
      const thin = (k, max) => { const a = jobs.filter(b => b.k === k); if (a.length <= max) return a; return Array.from({ length: max }, (_, i) => a[Math.floor(i * a.length / max)]); };
      jobs.splice(0, jobs.length, ...thin('c', 40), ...thin('p', 48), ...thin('n', 40));
      for (let j = 0; j < jobs.length; j++) {
        const b = jobs[j], e = await this.embed(slice(b.seg, b.s, b.n));
        if (e) (b.k === 'c' ? C : b.k === 'p' ? P : N).push({ i: b.i, e });
        if (onProgress) onProgress(j / jobs.length);
        await new Promise(r => setTimeout(r, 0)); // let the page paint between checks
      }
      if (C.length < 4) throw new Error('Need more of your speech (about 30 seconds)');
      const folds = 4, pos = [];
      for (let k = 0; k < folds; k++) {
        const cs = C.filter(x => x.i % folds !== k).map(x => x.e); if (!cs.length) continue;
        const c = meanVec(cs);
        for (const x of P) if (x.i % folds === k) pos.push(dot(x.e, c));
      }
      this.pool = C.map(x => x.e);
      this.P = P.map(x => x.e); this.N = N.map(x => x.e); this.cvPos = pos;
      this.recalibrate(pos);
      this.ready = true;
      return this.calib;
    }
    /* Threshold from your windows (pos) and other voices (N): accept ~95% of you unless that lets
       too many others through. */
    recalibrate(pos) {
      this.c = meanVec(this.pool.concat(this.adapted));
      pos = pos || this.P.map(e => dot(e, this.c));
      const neg = this.N.map(e => dot(e, this.c));
      let thr = st.pct(pos, 0.05);
      if (neg.length) { const far = neg.filter(z => z >= thr).length / neg.length; if (far > 0.2) thr = st.eer(pos, neg).thr; }
      this.thr = thr; this.spread = Math.max(0.02, st.std(pos));
      this.calib = { pos: pos.length, neg: neg.length, frr: pos.filter(z => z < thr).length / Math.max(1, pos.length), far: neg.length ? neg.filter(z => z >= thr).length / neg.length : null, posMed: st.median(pos), negMed: neg.length ? st.median(neg) : null };
    }
    async _embedWins(segs, W, onProgress) {
      const out = []; let j = 0, total = 0;
      for (const seg of segs) total += wins(seg, W, W).length;
      for (const seg of segs) for (const [s, n] of wins(seg, W, W)) { const e = await this.embed(slice(seg, s, n)); if (e) out.push(e); if (onProgress) onProgress(++j / Math.max(1, total)); await new Promise(r => setTimeout(r, 0)); }
      return out;
    }
    /* More of your speech (needs samples). */
    async addPositive(segs, onProgress) {
      const c = await this._embedWins(segs, 150, p => onProgress && onProgress(p * 0.5)), p = await this._embedWins(segs, 60, q => onProgress && onProgress(0.5 + q * 0.5));
      this.pool = this.pool.concat(c).slice(-400); this.P = this.P.concat(p).slice(-400); this.recalibrate();
    }
    /* Other people's speech (needs samples). */
    async addNegative(segs, onProgress) { const n = await this._embedWins(segs, 60, onProgress); this.N = this.N.concat(n).slice(-400); this.recalibrate(); }
    addNegativeEmbs(embs) { this.N = this.N.concat(embs).slice(-400); this.recalibrate(); }
    threshold() { return this.thr + this.strict * 0.5 * this.spread; }
    async scoreSamples(samples) {
      const e = await this.embed(samples); if (!e) return null;
      const z = dot(e, this.c);
      return { score: z, isMe: z >= this.threshold(), margin: (z - this.threshold()) / this.spread, emb: e };
    }
    /* Learn from confident or corrected speech of yours. */
    adapt(embs) {
      for (const e of embs) { this.adapted.push(e); this.P.push(e); }
      if (this.adapted.length > 300) this.adapted.splice(0, this.adapted.length - 300);
      if (this.P.length > 400) this.P.splice(0, this.P.length - 400);
      this.recalibrate();
    }
    toJSON() { const A = l => l.map(e => Float32Array.from(e)); return { kind: 'neural', pool: A(this.pool), adapted: A(this.adapted), P: A(this.P), N: A(this.N) }; }
    static fromJSON(o) {
      const F = l => (l || []).map(a => Float32Array.from(a)), v = new NeuralVoice();
      v.pool = F(o.pool); v.adapted = F(o.adapted); v.P = F(o.P); v.N = F(o.N); v.recalibrate(); v.ready = v.pool.length > 0; return v;
    }
  }
  NeuralVoice.FB = FB;
  S.NeuralVoice = NeuralVoice;
})(typeof globalThis !== 'undefined' ? globalThis : self);
