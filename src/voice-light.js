/* Samt Light voice model: MFCC GMMs (you vs. others) plus pitch and loudness evidence. */
(function (G) {
  'use strict';
  const S = G.Samt || (G.Samt = {});
  const { st, GMM, logistic, logisticFrom } = S.models;
  const D = 26;

  function concat(segs, cap) {
    let N = 0; for (const s of segs) N += s.n;
    const X = new Float32Array(N * D); let o = 0;
    for (const s of segs) { X.set(s.vec.subarray(0, s.n * D), o * D); o += s.n; }
    if (cap && N > cap) { // keep an even spread when over capacity
      const Y = new Float32Array(cap * D);
      for (let i = 0; i < cap; i++) { const src = Math.floor(i * N / cap); Y.set(X.subarray(src * D, src * D + D), i * D); }
      return { X: Y, N: cap };
    }
    return { X, N };
  }
  function windowsOf(segs, W) {
    const out = [];
    for (const seg of segs) {
      if (seg.n < W) { if (seg.n >= W / 2) out.push({ seg, s: 0, n: seg.n }); continue; }
      for (let s = 0; s + W <= seg.n; s += Math.floor(W / 2)) out.push({ seg, s, n: W });
    }
    return out;
  }
  function lp(x, m, sd) { const z = (x - m) / sd; return -0.5 * z * z - Math.log(sd); }

  class LightVoice {
    constructor() { this.kind = 'light'; this.W = 40; this.minFrames = 40; this.recheck = 50; this.strict = 0; this.ready = false; }

    _raw(gMe, gOth, seg, s, n) {
      let llr = 0;
      for (let f = s; f < s + n; f++) llr += gMe.ll(seg.vec, f * D) - gOth.ll(seg.vec, f * D);
      llr /= n;
      const f0 = [], lv = [];
      for (let f = s; f < s + n; f++) { if (seg.f0[f] > 0) f0.push(Math.log(seg.f0[f])); lv.push(seg.eDb[f]); }
      return { llr, lf0: f0.length >= 4 ? st.median(f0) : NaN, lvl: st.median(lv) };
    }
    _feat(r) {
      const p = this.pitch, l = this.level;
      const pr = isNaN(r.lf0) ? 0 : Math.max(-6, Math.min(6, lp(r.lf0, p.me[0], p.me[1]) - lp(r.lf0, p.oth[0], p.oth[1])));
      const lr = Math.max(-4, Math.min(4, lp(r.lvl, l.me[0], l.me[1]) - lp(r.lvl, l.oth[0], l.oth[1])));
      return [r.llr, pr, lr];
    }
    _z(f) { return this.lr ? this.lr.score(f) : f[0] + 0.3 * f[1] + 0.15 * f[2]; }

    /* meSegs / othSegs: [{n, vec: Float32Array(n*26), f0: Float32Array(n), eDb: Float32Array(n)}] */
    train(meSegs, othSegs) {
      othSegs = othSegs || [];
      const W = this.W, hasOth = othSegs.reduce((a, s) => a + s.n, 0) > 300;
      const all = concat(meSegs, 12000);
      if (all.N < 600) throw new Error('Need at least 6 seconds of your speech');
      // cross-validated positive scores (folds by segment)
      const folds = 4, posRaw = [];
      const gOthAll = hasOth ? (() => { const o = concat(othSegs, 15000); return GMM.train(o.X, o.N, D, 8, { seed: 11 }); })() : null;
      for (let k = 0; k < folds; k++) {
        const tr = meSegs.filter((_, i) => i % folds !== k), te = meSegs.filter((_, i) => i % folds === k);
        if (!tr.length || !te.length) continue;
        const t = concat(tr, 9000), gMe = GMM.train(t.X, t.N, D, 16, { seed: 5 + k });
        const gOth = gOthAll || GMM.broad(t.X, t.N, D, 4);
        for (const w of windowsOf(te, W)) posRaw.push(this._raw(gMe, gOth, w.seg, w.s, w.n));
      }
      this.gMe = GMM.train(all.X, all.N, D, 16, { seed: 5 });
      this.gOth = gOthAll || GMM.broad(all.X, all.N, D, 4);
      const negRaw = [];
      if (hasOth) {
        for (let k = 0; k < 2; k++) {
          const tr = othSegs.filter((_, i) => i % 2 !== k), te = othSegs.filter((_, i) => i % 2 === k);
          if (!tr.length || !te.length) continue;
          const t = concat(tr, 15000), g = GMM.train(t.X, t.N, D, 8, { seed: 13 + k });
          for (const w of windowsOf(te, W)) negRaw.push(this._raw(this.gMe, g, w.seg, w.s, w.n));
        }
      }
      const pf = posRaw.map(r => r.lf0).filter(x => !isNaN(x)), nf = negRaw.map(r => r.lf0).filter(x => !isNaN(x));
      this.pitch = { me: [st.median(pf) || Math.log(120), Math.max(0.06, st.std(pf) || 0.15)], oth: nf.length > 5 ? [st.median(nf), Math.max(0.08, st.std(nf))] : [Math.log(160), 0.4] };
      const pl = posRaw.map(r => r.lvl), nl = negRaw.map(r => r.lvl);
      this.level = { me: [st.median(pl), Math.max(3, st.std(pl))], oth: nl.length > 5 ? [st.median(nl), Math.max(4, st.std(nl))] : [st.median(pl) - 8, 9] };
      const pos = posRaw.map(r => this._feat(r)), neg = negRaw.map(r => this._feat(r));
      this.lr = null;
      if (neg.length >= 10) this.lr = logistic(pos.concat(neg), pos.map(() => 1).concat(neg.map(() => 0)));
      const pz = pos.map(f => this._z(f)), nz = neg.map(f => this._z(f));
      let thr = st.pct(pz, 0.05);
      if (nz.length) { const far = nz.filter(z => z >= thr).length / nz.length; if (far > 0.2) thr = st.eer(pz, nz).thr; }
      this.thr = thr; this.spread = Math.max(0.05, st.std(pz));
      this.calib = { pos: pz.length, neg: nz.length, frr: pz.filter(z => z < thr).length / Math.max(1, pz.length), far: nz.length ? nz.filter(z => z >= thr).length / nz.length : null };
      this.ready = true;
      return this.calib;
    }
    threshold() { return this.thr + this.strict * 0.5 * this.spread; }
    /* Score frames [s, s+n) of a segment-like object. Returns {score, isMe}. */
    score(seg, s, n) {
      const z = this._z(this._feat(this._raw(this.gMe, this.gOth, seg, s, n)));
      return { score: z, isMe: z >= this.threshold(), margin: (z - this.threshold()) / this.spread };
    }
    toJSON() { return { kind: 'light', gMe: this.gMe.toJSON(), gOth: this.gOth.toJSON(), pitch: this.pitch, level: this.level, lr: this.lr && { w: this.lr.w, b: this.lr.b, mu: this.lr.mu, sd: this.lr.sd, D: this.lr.D }, thr: this.thr, spread: this.spread, calib: this.calib }; }
    static fromJSON(o) {
      const v = new LightVoice(); v.gMe = GMM.fromJSON(o.gMe); v.gOth = GMM.fromJSON(o.gOth); v.pitch = o.pitch; v.level = o.level;
      v.lr = o.lr ? logisticFrom(o.lr) : null; v.thr = o.thr; v.spread = o.spread; v.calib = o.calib; v.ready = true; return v;
    }
  }
  S.LightVoice = LightVoice;
})(typeof globalThis !== 'undefined' ? globalThis : self);
