/* Samt DSP: resampling, framing, log-mel / MFCC, Kaldi-compatible fbank, pitch (YIN), speech detection. */
(function (G) {
  'use strict';
  const S = G.Samt || (G.Samt = {});
  const TAU = Math.PI * 2;
  const FLT_EPS = 1.1920928955078125e-7;

  /* Streaming windowed-sinc resampler (any input rate -> 16 kHz). Self-contained so it can be
     stringified into the AudioWorklet. */
  function makeResamplerClass() {
    return class Resampler {
      constructor(inRate, outRate) {
        this.ratio = inRate / outRate;
        const cutoff = Math.min(0.5, 7600 / inRate);
        const taps = 97; this.half = 48;
        this.h = new Float32Array(taps);
        let sum = 0;
        for (let i = 0; i < taps; i++) {
          const m = i - this.half;
          const x = m === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * m) / (Math.PI * m);
          const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
          this.h[i] = x * w; sum += this.h[i];
        }
        for (let i = 0; i < taps; i++) this.h[i] /= sum;
        this.buf = new Float32Array(16384); this.len = 0; this.pos = this.half;
        this.passthrough = Math.abs(this.ratio - 1) < 1e-9;
      }
      process(input) {
        if (this.passthrough) return Float32Array.from(input);
        if (this.len + input.length > this.buf.length) {
          const nb = new Float32Array((this.len + input.length) * 2); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
        }
        this.buf.set(input, this.len); this.len += input.length;
        const h = this.h, half = this.half, taps = h.length, buf = this.buf;
        const out = new Float32Array(Math.ceil(input.length / this.ratio) + 4);
        let n = 0;
        while (Math.floor(this.pos) + 1 + half < this.len && n < out.length) {
          const i0 = Math.floor(this.pos), frac = this.pos - i0, base = i0 - half;
          let a = 0, b = 0;
          for (let k = 0; k < taps; k++) { a += h[k] * buf[base + k]; b += h[k] * buf[base + k + 1]; }
          out[n++] = a + (b - a) * frac;
          this.pos += this.ratio;
        }
        const drop = Math.floor(this.pos) - half;
        if (drop > 0) { buf.copyWithin(0, drop, this.len); this.len -= drop; this.pos -= drop; }
        return out.subarray(0, n);
      }
    };
  }
  const Resampler = makeResamplerClass();

  class FFT {
    constructor(n) {
      this.n = n; let lv = 0; while ((1 << lv) < n) lv++;
      if ((1 << lv) !== n) throw new Error('FFT size must be a power of 2');
      this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2);
      for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(TAU * i / n); this.sin[i] = Math.sin(TAU * i / n); }
      this.rev = new Uint32Array(n);
      for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < lv; b++) { r = (r << 1) | (x & 1); x >>= 1; } this.rev[i] = r; }
      this.re = new Float64Array(n); this.im = new Float64Array(n);
    }
    power(input, len, out) {
      const n = this.n, re = this.re, im = this.im, rev = this.rev, C = this.cos, Sn = this.sin;
      for (let i = 0; i < n; i++) { const j = rev[i]; re[j] = i < len ? input[i] : 0; im[j] = 0; }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const xr = re[j + half], xi = im[j + half];
            const tr = xr * C[k] + xi * Sn[k], ti = xi * C[k] - xr * Sn[k];
            re[j + half] = re[j] - tr; im[j + half] = im[j] - ti; re[j] += tr; im[j] += ti;
          }
        }
      }
      for (let i = 0; i <= n / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
      return out;
    }
  }

  function makeWindow(type, n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = Math.cos(TAU * i / (n - 1));
      if (type === 'hamming') w[i] = 0.54 - 0.46 * c;
      else if (type === 'hann' || type === 'hanning') w[i] = 0.5 - 0.5 * c;
      else w[i] = Math.pow(0.5 - 0.5 * c, 0.85); // povey (Kaldi default)
    }
    return w;
  }

  /* Kaldi-style triangular mel banks. highFreq <= 0 means offset from Nyquist. */
  function melBanks(numBins, nfft, sr, lowFreq, highFreq) {
    const nyq = sr / 2; if (highFreq <= 0) highFreq += nyq;
    const mel = f => 1127 * Math.log(1 + f / 700);
    const binW = sr / nfft, nb = nfft / 2;
    const lo = mel(lowFreq), hi = mel(highFreq), d = (hi - lo) / (numBins + 1);
    const banks = [];
    for (let b = 0; b < numBins; b++) {
      const left = lo + b * d, center = left + d, right = center + d;
      let first = -1; const ws = [];
      for (let i = 0; i < nb; i++) {
        const m = mel(binW * i);
        if (m > left && m < right) {
          if (first < 0) first = i;
          ws.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center));
        }
      }
      banks.push({ first: Math.max(first, 0), w: Float32Array.from(ws) });
    }
    return banks;
  }

  /* One Kaldi-compatible framer: dc removal, pre-emphasis, window, power spectrum, log mel. */
  class LogMel {
    constructor({ numBins = 80, sr = 16000, frameLen = 400, nfft = 512, lowFreq = 20, highFreq = 0, window = 'povey', preemph = 0.97, scale = 1 } = {}) {
      this.numBins = numBins; this.frameLen = frameLen; this.preemph = preemph; this.scale = scale;
      this.win = makeWindow(window, frameLen); this.fft = new FFT(nfft);
      this.banks = melBanks(numBins, nfft, sr, lowFreq, highFreq);
      this.buf = new Float64Array(frameLen); this.pow = new Float64Array(nfft / 2 + 1);
    }
    compute(src, off, out) {
      const n = this.frameLen, b = this.buf, sc = this.scale;
      let mean = 0;
      for (let i = 0; i < n; i++) { b[i] = src[off + i] * sc; mean += b[i]; }
      mean /= n;
      for (let i = 0; i < n; i++) b[i] -= mean;
      if (this.preemph) { for (let i = n - 1; i > 0; i--) b[i] -= this.preemph * b[i - 1]; b[0] -= this.preemph * b[0]; }
      for (let i = 0; i < n; i++) b[i] *= this.win[i];
      this.fft.power(b, n, this.pow);
      for (let m = 0; m < this.numBins; m++) {
        const bk = this.banks[m]; let e = 0;
        for (let k = 0; k < bk.w.length; k++) e += bk.w[k] * this.pow[bk.first + k];
        out[m] = Math.log(Math.max(e, FLT_EPS));
      }
      return out;
    }
  }

  /* Batch fbank for the neural model: returns {T, data: Float32Array(T*bins)}, mean-normalised over time. */
  function fbank(samples, opts = {}) {
    const lm = new LogMel(Object.assign({ numBins: 80 }, opts));
    const shift = 160, len = 400, bins = lm.numBins;
    const T = samples.length >= len ? 1 + Math.floor((samples.length - len) / shift) : 0;
    const data = new Float32Array(T * bins), row = new Float64Array(bins);
    for (let t = 0; t < T; t++) { lm.compute(samples, t * shift, row); for (let m = 0; m < bins; m++) data[t * bins + m] = row[m]; }
    if (opts.cmn !== false && T > 0) {
      for (let m = 0; m < bins; m++) { let s = 0; for (let t = 0; t < T; t++) s += data[t * bins + m]; s /= T; for (let t = 0; t < T; t++) data[t * bins + m] -= s; }
    }
    return { T, bins, data };
  }

  function dctMatrix(nIn, nOut, skipC0) {
    const M = [];
    for (let k = skipC0 ? 1 : 0, r = 0; r < nOut; k++, r++) {
      const row = new Float32Array(nIn), a = Math.sqrt(2 / nIn);
      for (let n = 0; n < nIn; n++) row[n] = a * Math.cos(Math.PI * k * (n + 0.5) / nIn);
      M.push(row);
    }
    return M;
  }

  /* YIN pitch on 8 kHz decimated audio. Returns Hz or 0 when unvoiced. */
  function yin(x8, off, win, tmin, tmax, thr, d, cm) {
    for (let t = 1; t <= tmax; t++) {
      let s = 0;
      for (let j = 0; j < win; j++) { const v = x8[off + j] - x8[off + j + t]; s += v * v; }
      d[t] = s;
    }
    let run = 0; cm[0] = 1;
    for (let t = 1; t <= tmax; t++) { run += d[t]; cm[t] = run > 0 ? d[t] * t / run : 1; }
    for (let t = tmin; t <= tmax; t++) {
      if (cm[t] < thr) {
        while (t + 1 <= tmax && cm[t + 1] < cm[t]) t++;
        let tt = t;
        if (t > 1 && t < tmax) { const a = cm[t - 1], b = cm[t], c = cm[t + 1], den = a - 2 * b + c; if (den > 0) tt = t + 0.5 * (a - c) / den; }
        return 8000 / tt;
      }
    }
    return 0;
  }

  /* Streaming feature extractor over 16 kHz audio: one frame every 10 ms (25 ms window).
     Keeps ring buffers of samples and per-frame features for the last `keepSeconds`. */
  class FeatureStream {
    constructor({ keepSeconds = 14, mels = 40, ceps = 13, pitch = true } = {}) {
      this.sr = 16000; this.hop = 160; this.len = 400; this.ceps = ceps; this.mels = mels; this.withPitch = pitch;
      this.lm = new LogMel({ numBins: mels, lowFreq: 100, highFreq: 7600, window: 'povey' });
      this.dct = dctMatrix(mels, ceps, true);
      this.cap = Math.ceil(keepSeconds * 100);
      this.sCap = this.cap * this.hop + 2048;
      this.samples = new Float32Array(this.sCap); this.sTotal = 0;
      this.mfcc = new Float32Array(this.cap * ceps); this.eDb = new Float32Array(this.cap); this.f0 = new Float32Array(this.cap);
      this.nFrames = 0; this.melRow = new Float64Array(mels); this.tmp = new Float32Array(this.len);
      this.p8 = new Float32Array(1024); this.pd = new Float64Array(140); this.pcm = new Float64Array(140);
      this.listeners = [];
    }
    onFrame(fn) { this.listeners.push(fn); }
    sampleAt(abs) { return this.samples[abs % this.sCap]; }
    getSamples(from, to) {
      from = Math.max(from, this.sTotal - this.sCap + 1); const out = new Float32Array(Math.max(0, to - from));
      for (let i = from, k = 0; i < to; i++, k++) out[k] = this.samples[i % this.sCap];
      return out;
    }
    push(chunk) {
      for (let i = 0; i < chunk.length; i++) this.samples[(this.sTotal + i) % this.sCap] = chunk[i];
      this.sTotal += chunk.length;
      const need = this.withPitch ? 720 : this.len;
      while (this.nFrames * this.hop + need <= this.sTotal) this._frame();
    }
    _frame() {
      const f = this.nFrames, start = f * this.hop, n = this.len, tmp = this.tmp;
      let e = 0;
      for (let i = 0; i < n; i++) { const v = this.samples[(start + i) % this.sCap]; tmp[i] = v; e += v * v; }
      const r = f % this.cap;
      this.eDb[r] = 10 * Math.log10(e / n + 1e-12);
      this.lm.compute(tmp, 0, this.melRow);
      for (let k = 0; k < this.ceps; k++) { const row = this.dct[k]; let s = 0; for (let m = 0; m < this.mels; m++) s += row[m] * this.melRow[m]; this.mfcc[r * this.ceps + k] = s; }
      let hz = 0;
      if (this.withPitch && this.eDb[r] > -55) {
        const p8 = this.p8; // 90 ms of audio at 8 kHz, 3-tap triangular low-pass before decimation
        for (let j = 0; j < 360; j++) {
          const a = start + 2 * j;
          p8[j] = 0.25 * this.samples[(a + this.sCap - 1) % this.sCap] + 0.5 * this.samples[a % this.sCap] + 0.25 * this.samples[(a + 1) % this.sCap];
        }
        hz = yin(p8, 0, 200, 20, 134, 0.15, this.pd, this.pcm);
        if (hz < 60 || hz > 400) hz = 0;
      }
      this.f0[r] = hz;
      this.nFrames++;
      for (const fn of this.listeners) fn(f);
    }
    has(f) { return f >= 0 && f < this.nFrames && f > this.nFrames - this.cap; }
    /* Static + delta MFCC for frame f into out (2*ceps). Needs frames f-2..f+2. */
    vec(f, out, off = 0) {
      const C = this.ceps, cap = this.cap, last = this.nFrames - 1, first = Math.max(0, this.nFrames - cap);
      const at = (g, k) => { g = Math.min(last, Math.max(first, g)); return this.mfcc[(g % cap) * C + k]; };
      for (let k = 0; k < C; k++) {
        out[off + k] = at(f, k);
        out[off + C + k] = ((at(f + 1, k) - at(f - 1, k)) + 2 * (at(f + 2, k) - at(f - 2, k))) / 10;
      }
      return out;
    }
    energy(f) { return this.eDb[f % this.cap]; }
    pitch(f) { return this.f0[f % this.cap]; }
  }

  /* Speech detector with an adaptive noise floor (10th percentile of the last 6 s). */
  class VAD {
    constructor({ thrDb = 11, minDb = -58, onset = 3, hang = 30 } = {}) {
      this.thr = thrDb; this.minDb = minDb; this.onsetN = onset; this.hang = hang;
      this.hist = new Float32Array(600); this.hn = 0; this.floor = -75; this.sorted = null;
      this.active = false; this.run = 0; this.runStart = -1; this.silence = 0; this.lastSpeech = -1; this.segStart = -1;
    }
    setThreshold(db) { this.thr = db; }
    push(f, eDb) {
      this.hist[this.hn % this.hist.length] = eDb; this.hn++;
      if (this.hn % 10 === 0 || this.hn < 40) {
        const n = Math.min(this.hn, this.hist.length), a = Array.from(this.hist.subarray(0, n)).sort((x, y) => x - y);
        this.floor = Math.max(-90, a[Math.floor(n * 0.1)]);
      }
      const sp = eDb > this.floor + this.thr && eDb > this.minDb;
      let ev = null;
      if (!this.active) {
        if (sp) { if (this.run === 0) this.runStart = f; this.run++; } else this.run = 0;
        if (this.run >= this.onsetN) { this.active = true; this.segStart = this.runStart; this.lastSpeech = f; this.silence = 0; ev = { type: 'onset', frame: this.segStart }; }
      } else {
        if (sp) { this.lastSpeech = f; this.silence = 0; }
        else if (++this.silence >= this.hang) { this.active = false; this.run = 0; ev = { type: 'offset', frame: this.lastSpeech, start: this.segStart }; }
      }
      return { speech: sp, active: this.active, event: ev };
    }
  }

  /* One pitch cut out (RBJ cookbook notch, the same formula as Web Audio's BiquadFilterNode 'notch', so the echo's
     filters and the level's filters match). Q = f0 / width. Returns a per-sample function with its own state. */
  function notch(f0, q, fs) {
    const w = TAU * f0 / fs, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    const b0 = 1 / a0, b1 = -2 * c / a0, a2 = (1 - al) / a0;
    let z1 = 0, z2 = 0;
    return x => { const y = b0 * x + z1; z1 = b1 * x - b1 * y + z2; z2 = b0 * x - a2 * y; return y; };
  }
  /* x through a list of notches ([{f, q}]), as a new array. */
  function applyNotches(x, tones, fs = 16000) {
    const F = (tones || []).map(t => notch(t.f, t.q, fs)), y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) { let v = x[i]; for (let j = 0; j < F.length; j++) v = F[j](v); y[i] = v; }
    return y;
  }
  /* Mean power of x in dB (like a frame's energy), skipping the first `skip` samples (filters settling). */
  function levelDb(x, skip = 0) { let e = 0; for (let i = skip; i < x.length; i++) e += x[i] * x[i]; return 10 * Math.log10(e / Math.max(1, x.length - skip) + 1e-12); }
  /* The steady pitches of a sound, like a machine's hum or whine: the strongest narrow peaks of its averaged spectrum,
     at least `prom` dB over their surroundings, 50 Hz to 7 kHz. Returns up to `max` of [{f, q}], strongest first; the
     width of each (where the peak is 10 dB down) sets its notch's Q, kept between 4 and 30. A sound spread over every
     pitch (wind, a roar) has no such peaks and returns []. */
  function findTones(x, { fs = 16000, n = 4096, max = 6, prom = 10 } = {}) {
    const fft = new FFT(n), win = makeWindow('hann', n), buf = new Float32Array(n), half = n / 2, P = new Float64Array(half + 1), tmp = new Float64Array(half + 1);
    let frames = 0;
    for (let s = 0; s + n <= x.length; s += half) {
      for (let i = 0; i < n; i++) buf[i] = x[s + i] * win[i];
      fft.power(buf, n, tmp); for (let k = 0; k <= half; k++) P[k] += tmp[k]; frames++;
    }
    if (!frames) return [];
    const res = fs / n, D = Array.from(P, p => 10 * Math.log10(p / frames + 1e-20));
    const lo = Math.max(2, Math.ceil(50 / res)), hi = Math.min(half - 3, Math.floor(7000 / res)), found = [];
    for (let k = lo; k <= hi; k++) {
      if (!(D[k] > D[k - 1] && D[k] >= D[k + 1] && D[k] >= D[k - 2] && D[k] >= D[k + 2])) continue;
      const w = Math.max(12, Math.round(k * 0.08)), around = D.slice(Math.max(0, k - w), Math.min(D.length, k + w + 1)).sort((a, b) => a - b);
      if (D[k] - around[around.length >> 1] < prom) continue;
      const den = D[k - 1] - 2 * D[k] + D[k + 1], d = den < 0 ? 0.5 * (D[k - 1] - D[k + 1]) / den : 0; // the centre, between bins
      let a = k, b = k; while (a > lo && D[a - 1] > D[k] - 10) a--; while (b < hi && D[b + 1] > D[k] - 10) b++;
      const f = (k + d) * res, width = Math.max(12, (b - a + 1) * res);
      found.push({ f, q: Math.max(4, Math.min(30, f / width)), db: D[k] });
    }
    found.sort((p, q) => q.db - p.db);
    const pick = [];
    for (const c of found) { if (pick.length >= max) break; if (pick.every(p => Math.abs(p.f - c.f) > Math.max(20, 0.05 * c.f))) pick.push(c); }
    return pick.map(({ f, q }) => ({ f: Math.round(f * 10) / 10, q: Math.round(q * 10) / 10 }));
  }

  S.dsp = { makeResamplerClass, Resampler, FFT, LogMel, fbank, melBanks, makeWindow, FeatureStream, VAD, yin, notch, applyNotches, levelDb, findTones };
})(typeof globalThis !== 'undefined' ? globalThis : self);
