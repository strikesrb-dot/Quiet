/* Samt models: statistics helpers, diagonal GMM, logistic regression, DTW phrase spotter. */
(function (G) {
  'use strict';
  const S = G.Samt || (G.Samt = {});
  const LOG2PI = Math.log(2 * Math.PI);

  const st = {
    mean(a) { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; },
    std(a) { if (a.length < 2) return 0; const m = st.mean(a); let s = 0; for (const x of a) s += (x - m) * (x - m); return Math.sqrt(s / (a.length - 1)); },
    pct(a, p) { if (!a.length) return NaN; const b = Array.from(a).sort((x, y) => x - y); const i = Math.min(b.length - 1, Math.max(0, (b.length - 1) * p)); const lo = Math.floor(i), hi = Math.ceil(i); return b[lo] + (b[hi] - b[lo]) * (i - lo); },
    median(a) { return st.pct(a, 0.5); },
    rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; },
    logsumexp(a, n) { let m = -Infinity; for (let i = 0; i < n; i++) if (a[i] > m) m = a[i]; if (m === -Infinity) return m; let s = 0; for (let i = 0; i < n; i++) s += Math.exp(a[i] - m); return m + Math.log(s); },
    /* Equal-error-rate style threshold between positive and negative score lists. */
    eer(pos, neg) {
      const all = pos.map(s => [s, 1]).concat(neg.map(s => [s, 0])).sort((a, b) => a[0] - b[0]);
      let fr = 0, fa = neg.length, best = { gap: Infinity, thr: 0, eer: 1 };
      for (const [s, lab] of all) {
        const frr = fr / pos.length, far = fa / neg.length, gap = Math.abs(frr - far);
        if (gap < best.gap) best = { gap, thr: s, eer: (frr + far) / 2 };
        if (lab) fr++; else fa--;
      }
      return best;
    }
  };

  class GMM {
    constructor(K, D) { this.K = K; this.D = D; this.w = new Float64Array(K); this.mu = new Float64Array(K * D); this.v = new Float64Array(K * D); this._prep(); }
    _prep() {
      const { K, D } = this; this.c = new Float64Array(K); this.iv = new Float64Array(K * D);
      for (let k = 0; k < K; k++) { let s = 0; for (let d = 0; d < D; d++) { s += Math.log(this.v[k * D + d] || 1); this.iv[k * D + d] = 1 / (this.v[k * D + d] || 1); } this.c[k] = Math.log(this.w[k] || 1e-12) - 0.5 * (D * LOG2PI + s); }
      this.tmp = new Float64Array(K);
    }
    static train(X, N, D, K, { iters = 30, seed = 3, floorFrac = 0.02 } = {}) {
      K = Math.max(1, Math.min(K, Math.floor(N / (4 * D)) || 1));
      const g = new GMM(K, D), rnd = st.rng(seed);
      const gm = new Float64Array(D), gv = new Float64Array(D);
      for (let n = 0; n < N; n++) for (let d = 0; d < D; d++) gm[d] += X[n * D + d];
      for (let d = 0; d < D; d++) gm[d] /= N;
      for (let n = 0; n < N; n++) for (let d = 0; d < D; d++) { const t = X[n * D + d] - gm[d]; gv[d] += t * t; }
      for (let d = 0; d < D; d++) gv[d] = Math.max(gv[d] / N, 1e-6);
      const vfloor = Float64Array.from(gv, x => x * floorFrac);
      // k-means++ seeding
      const cent = [], dist = new Float64Array(N).fill(Infinity);
      cent.push(Math.floor(rnd() * N));
      while (cent.length < K) {
        const c = cent[cent.length - 1]; let tot = 0;
        for (let n = 0; n < N; n++) { let s = 0; for (let d = 0; d < D; d++) { const t = (X[n * D + d] - X[c * D + d]); s += t * t / gv[d]; } if (s < dist[n]) dist[n] = s; tot += dist[n]; }
        let r = rnd() * tot, pick = N - 1; for (let n = 0; n < N; n++) { r -= dist[n]; if (r <= 0) { pick = n; break; } }
        cent.push(pick);
      }
      for (let k = 0; k < K; k++) { g.w[k] = 1 / K; for (let d = 0; d < D; d++) { g.mu[k * D + d] = X[cent[k] * D + d]; g.v[k * D + d] = gv[d]; } }
      g._prep();
      const R = new Float64Array(K), Nk = new Float64Array(K), M1 = new Float64Array(K * D), M2 = new Float64Array(K * D);
      for (let it = 0; it < iters; it++) {
        Nk.fill(0); M1.fill(0); M2.fill(0);
        for (let n = 0; n < N; n++) {
          for (let k = 0; k < K; k++) { let s = g.c[k]; for (let d = 0; d < D; d++) { const t = X[n * D + d] - g.mu[k * D + d]; s -= 0.5 * t * t * g.iv[k * D + d]; } R[k] = s; }
          const l = st.logsumexp(R, K);
          for (let k = 0; k < K; k++) { const r = Math.exp(R[k] - l); if (r < 1e-8) continue; Nk[k] += r; for (let d = 0; d < D; d++) { const x = X[n * D + d]; M1[k * D + d] += r * x; M2[k * D + d] += r * x * x; } }
        }
        for (let k = 0; k < K; k++) {
          const nk = Math.max(Nk[k], 1e-6); g.w[k] = Math.max(nk / N, 1e-4);
          for (let d = 0; d < D; d++) { const m = M1[k * D + d] / nk; g.mu[k * D + d] = m; g.v[k * D + d] = Math.max(M2[k * D + d] / nk - m * m, vfloor[d]); }
        }
        let ws = 0; for (let k = 0; k < K; k++) ws += g.w[k]; for (let k = 0; k < K; k++) g.w[k] /= ws;
        g._prep();
      }
      return g;
    }
    static broad(X, N, D, scale) { // one wide Gaussian around the data
      const g = new GMM(1, D); g.w[0] = 1;
      for (let n = 0; n < N; n++) for (let d = 0; d < D; d++) g.mu[d] += X[n * D + d] / N;
      for (let n = 0; n < N; n++) for (let d = 0; d < D; d++) { const t = X[n * D + d] - g.mu[d]; g.v[d] += t * t / N; }
      for (let d = 0; d < D; d++) g.v[d] = Math.max(g.v[d], 1e-6) * scale;
      g._prep(); return g;
    }
    ll(X, off) {
      const { K, D } = this, R = this.tmp;
      for (let k = 0; k < K; k++) { let s = this.c[k]; for (let d = 0; d < D; d++) { const t = X[off + d] - this.mu[k * D + d]; s -= 0.5 * t * t * this.iv[k * D + d]; } R[k] = s; }
      return st.logsumexp(R, K);
    }
    toJSON() { return { K: this.K, D: this.D, w: Array.from(this.w), mu: Array.from(this.mu), v: Array.from(this.v) }; }
    static fromJSON(o) { const g = new GMM(o.K, o.D); g.w.set(o.w); g.mu.set(o.mu); g.v.set(o.v); g._prep(); return g; }
  }

  /* Tiny L2-regularised logistic regression (batch gradient descent). */
  function logistic(Xs, ys, { l2 = 0.01, iters = 400, lr = 0.5 } = {}) {
    const D = Xs[0].length, mu = new Array(D).fill(0), sd = new Array(D).fill(0);
    for (const x of Xs) for (let d = 0; d < D; d++) mu[d] += x[d] / Xs.length;
    for (const x of Xs) for (let d = 0; d < D; d++) sd[d] += (x[d] - mu[d]) ** 2 / Xs.length;
    for (let d = 0; d < D; d++) sd[d] = Math.sqrt(sd[d]) || 1;
    const w = new Array(D).fill(0); let b = 0;
    const np = ys.filter(y => y).length, nn = ys.length - np, wp = ys.length / (2 * Math.max(np, 1)), wn = ys.length / (2 * Math.max(nn, 1));
    for (let it = 0; it < iters; it++) {
      const gw = new Array(D).fill(0); let gb = 0;
      for (let i = 0; i < Xs.length; i++) {
        let z = b; for (let d = 0; d < D; d++) z += w[d] * (Xs[i][d] - mu[d]) / sd[d];
        const p = 1 / (1 + Math.exp(-z)), e = (p - ys[i]) * (ys[i] ? wp : wn);
        for (let d = 0; d < D; d++) gw[d] += e * (Xs[i][d] - mu[d]) / sd[d]; gb += e;
      }
      for (let d = 0; d < D; d++) w[d] -= lr * (gw[d] / Xs.length + l2 * w[d]); b -= lr * gb / Xs.length;
    }
    return { w, b, mu, sd, D, score(x) { let z = b; for (let d = 0; d < D; d++) z += w[d] * (x[d] - mu[d]) / sd[d]; return z; } };
  }
  function logisticFrom(o) { return Object.assign({}, o, { score(x) { let z = o.b; for (let d = 0; d < o.D; d++) z += o.w[d] * (x[d] - o.mu[d]) / o.sd[d]; return z; } }); }

  /* Incremental DTW over a set of phrase templates. Observed frames are pushed one at a time from a
     cursor; for each template we keep one DP row. Symmetric step pattern, normalised by path weight. */
  class Spotter {
    constructor(templates, D) {
      this.T = templates; this.D = D; // [{id, phrase, L, data: Float32Array(L*D), thr}]
      this.slack = 1.1; this.earlySlack = 1.25; this.prog = 0.6; this.cap = 1.3;
      this.reset();
    }
    reset() {
      this.i = -1;
      this.st = this.T.map(t => ({ prev: new Float64Array(t.L).fill(Infinity), cur: new Float64Array(t.L).fill(Infinity), dead: false, bestEnd: Infinity, endAt: -1 }));
    }
    _d(o, t, j) { const D = this.D, td = t.data; let s = 0; for (let k = 0; k < D; k++) { const x = o[k] - td[j * D + k]; s += x * x; } return Math.sqrt(s / D); }
    /* Returns {complete: best finished template under threshold (or null), inProgress: some template's
       prefix still matches well and is not finished, minPrefix: best prefix ratio}. */
    push(o) {
      const i = ++this.i;
      const out = { complete: null, inProgress: false, minPrefix: Infinity, prefix: Infinity, prefixFrac: 0 };
      for (let n = 0; n < this.T.length; n++) {
        const t = this.T[n], s = this.st[n]; if (s.dead) continue;
        const L = t.L, prev = s.prev, cur = s.cur;
        const jlo = Math.max(0, Math.floor(i / 2) - 4), jhi = Math.min(L - 1, 2 * i + 4);
        cur.fill(Infinity);
        let best = Infinity, bestJ = 0;
        for (let j = jlo; j <= jhi; j++) {
          const d = this._d(o, t, j);
          let v;
          if (i === 0) v = j === 0 ? 2 * d : cur[j - 1] + d;
          else {
            const dg = j > 0 ? prev[j - 1] + 2 * d : Infinity, up = prev[j] + d, lf = j > 0 ? cur[j - 1] + d : Infinity;
            v = Math.min(dg, up, lf);
          }
          cur[j] = v;
          const nv = v / (i + j + 2);
          if (nv < best) { best = nv; bestJ = j; }
        }
        s.prev = cur; s.cur = prev;
        if (jhi === L - 1 && s.prev[L - 1] < Infinity) {
          const c = s.prev[L - 1] / (i + L + 1);
          if (c < s.bestEnd) { s.bestEnd = c; s.endAt = i; }
        }
        const ratio = best / t.thr, frac = (bestJ + 1) / L;
        if (ratio < out.prefix) { out.prefix = ratio; out.prefixFrac = frac; out.prefixPhrase = t.phrase; }
        if (ratio < out.minPrefix) out.minPrefix = ratio;
        const done = s.bestEnd <= t.thr;
        if (done && (!out.complete || s.bestEnd / t.thr < out.complete.ratio)) out.complete = { phrase: t.phrase, id: t.id, ratio: s.bestEnd / t.thr, end: s.endAt, L };
        if (!done && ratio <= (i < 20 ? this.earlySlack : this.slack) && frac < 0.92 && bestJ >= this.prog * i - 3 && i <= this.cap * L + 5) out.inProgress = true;
        if (i > 10 && best > t.thr * 1.5) s.dead = true;
      }
      return out;
    }
  }

  /* Cost of aligning a whole observation against a whole template (both complete). */
  function dtwFull(a, La, b, Lb, D) {
    let prev = new Float64Array(Lb).fill(Infinity), cur = new Float64Array(Lb).fill(Infinity);
    const dist = (i, j) => { let s = 0; for (let k = 0; k < D; k++) { const x = a[i * D + k] - b[j * D + k]; s += x * x; } return Math.sqrt(s / D); };
    for (let i = 0; i < La; i++) {
      cur.fill(Infinity);
      const jlo = Math.max(0, Math.floor(i * Lb / La / 2) - 6), jhi = Math.min(Lb - 1, Math.ceil(i * Lb / La * 2) + 6);
      for (let j = jlo; j <= jhi; j++) {
        const d = dist(i, j);
        if (i === 0) cur[j] = j === 0 ? 2 * d : cur[j - 1] + d;
        else cur[j] = Math.min(j > 0 ? prev[j - 1] + 2 * d : Infinity, prev[j] + d, j > 0 ? cur[j - 1] + d : Infinity);
      }
      [prev, cur] = [cur, prev];
    }
    return prev[Lb - 1] / (La + Lb);
  }

  S.models = { st, GMM, logistic, logisticFrom, Spotter, dtwFull };
})(typeof globalThis !== 'undefined' ? globalThis : self);
