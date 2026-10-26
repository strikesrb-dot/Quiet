// Run from the repo root after tests/setup-flow.js has run for the same engine and version (it restores that run's
// backup from tests/out/): node tests/recording.js [webkit|chromium] [light|neural]. Ends ALL PASS or N FAILED.
// Recording a session. WebKit here has no MediaRecorder, so it records WAV from the fake mic's chunks (the way any
// browser without MediaRecorder does); Chromium records with MediaRecorder from a real stream (a tone), the way iPhone
// does. Covers: Record in the session row, the echo switch while recording (no echo at all, then back), a too-short
// recording, recording through a held pause, a call cutting one off, the session ending by its timer mid-recording,
// a short session kept for its recording, the recordings in the session's sheet (play, save, delete), a reload, past
// sessions, deleting a session, the clean-up of parts nothing lists, and the layout at 390 px.
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require('/opt/node-tools/node_modules/playwright-core'); } })(); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path');
const [engine = 'webkit', mode = 'light', speed = '4'] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(__dirname, 'out'), sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8970 + Math.floor(Math.random() * 100);
let fails = 0; const ok = (c, s) => { console.log(`[${engine} ${mode}] ${c ? 'PASS' : 'FAIL'} ${s}`); if (!c) fails++; };
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' }); await sleep(800);
  const PX = process.env.HTTPS_PROXY;
  const browser = engine === 'webkit'
    ? await pw.webkit.launch({ proxy: PX ? { server: PX, bypass: '127.0.0.1,localhost' } : undefined })
    : await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: PX ? [`--proxy-server=${PX}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 1366 }, acceptDownloads: true });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  const out = s => console.log(`[${engine} ${mode}] ${s}`);
  const shot = n => page.screenshot({ path: path.join(OUT, `r_${engine}_${mode}_${n}.png`), fullPage: false });
  const view = () => page.evaluate(() => SamtDebug.view());
  const hold = async sel => { const b = await page.locator(sel).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(2200); await page.mouse.up(); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const ready = async () => {
    if (mode === 'neural') await page.waitForFunction(() => document.querySelector('#modelStatus').textContent.startsWith('Ready'), null, { timeout: 180000 });
    await page.waitForFunction(() => window.SamtDebug && SamtDebug.feed && SamtDebug.history, null, { timeout: 20000 });
  };
  const feed = n => page.evaluate(x => SamtDebug.feed(x, '/tests/audio/' + x + '.f32'), n);
  const sess = () => page.evaluate(() => { const s = SamtDebug.session(); return s && { paused: s.paused, echoOff: !!s.echoOff, clips: (s.clips || []).map(c => Object.assign({}, c)), recId: s.recId }; });
  const tapeOn = () => page.evaluate(() => !!SamtDebug.tape());
  const parts = id => page.evaluate(i => SamtDebug.blobs.count(i), id);
  const recordFor = async (ms, clip) => { // Record, some audio, stop
    await page.click('#sRec'); await page.waitForFunction(() => !!SamtDebug.tape(), null, { timeout: 5000 });
    if (clip) await feed(clip); else await sleep(ms);
  };
  const stopRec = async () => { await page.click('#sRec'); await page.waitForFunction(() => !SamtDebug.tape(), null, { timeout: 8000 }); await sleep(300); };
  const endSheetRecs = () => page.$$eval('#endRecs > .row:not(.btns):not(.player)', rs => rs.map(r => r.textContent));
  try {
    await page.goto(`http://127.0.0.1:${PORT}/site/${mode}/?fakemic=1&speed=${speed}`);
    await ready();
    const mr = await page.evaluate(() => typeof MediaRecorder !== 'undefined');
    out(`MediaRecorder in this engine: ${mr} (records ${mr ? 'with MediaRecorder from a stream' : 'WAV from the mic chunks'})`);
    await page.setInputFiles('#restoreFile', path.join(OUT, `backup_${engine}_${mode}.json`));
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('restored'), null, { timeout: 30000 });
    const h0 = (await page.evaluate(() => SamtDebug.history())).length;

    // a 16-hour session: the time fits; Record sits with Card and Sign
    await page.click('#readout'); await page.waitForSelector('#timerPanel.show'); await page.click('#presets button:nth-of-type(5)'); await page.click('#timerDone');
    await page.waitForSelector('#timerPanel', { state: 'hidden' });
    await page.click('#go'); await page.waitForSelector('#vSession:not([hidden])'); await sleep(400);
    const row = await page.$$eval('.s-row > button:not([hidden])', bs => bs.map(b => b.id));
    ok(row.join(',') === 'sCard,sSign,sRec,stop' && (await page.textContent('#sRec')).trim() === 'Record' && /^Talk freely/.test(await page.textContent('#pass')),
      `session row: ${row.join(', ')}; "${(await page.textContent('#sRec')).trim()}"; "${await page.textContent('#pass')}"`);
    const sr = await page.evaluate(() => { const r = document.querySelector('#sReadout'); return { t: r.textContent, long: r.classList.contains('long') }; });
    ok(/^1[56]:\d\d:\d\d$/.test(sr.t) && sr.long, `a 16-hour session counts down from ${sr.t} (smaller size: ${sr.long})`);

    // 1. Record; the button becomes the echo switch; echo off means no echo at all, and on brings it back
    await page.click('#sRec'); await page.waitForFunction(() => !!SamtDebug.tape(), null, { timeout: 5000 }); await sleep(300);
    let s = await sess();
    ok(s.clips.length === 1 && await page.evaluate(() => document.querySelector('#sRec').classList.contains('on')) && /^0:0\d$/.test((await page.textContent('#sRecText')).trim())
      && (await page.textContent('#pass')) === 'Turn the echo off', `recording: clip ${s.clips[0] && s.clips[0].id} (${s.clips[0] && s.clips[0].mime}), button "${(await page.textContent('#sRecText')).trim()}", "${await page.textContent('#pass')}"`);
    await page.waitForFunction(id => SamtDebug.history().some(r => r.id === id && r.clips && r.clips.length === 1), s.recId, { timeout: 5000 }).catch(() => {});
    ok(await page.evaluate(id => SamtDebug.history().some(r => r.id === id && r.clips && r.clips.length === 1), s.recId), 'the session is listed with its recording at once (in case the tab closes)');
    await page.click('#pass'); await sleep(200);
    const off = await page.evaluate(() => ({ s: SamtDebug.session().echoOff, left: SamtDebug.ctrl.passLeft(), pill: document.querySelector('#liveText').textContent, btn: document.querySelector('#pass').textContent, log: SamtDebug.engine.echoLog.length }));
    ok(off.s && off.left > 3600 && off.pill === 'Echo off' && off.btn === 'Turn the echo back on', `echo off: pill "${off.pill}", button "${off.btn}", no echo for ${Math.round(off.left / 3600)} h unless turned back on`);
    const pMe = feed('enroll2_me'); await sleep(Math.round(42500 / +speed * 0.45));
    const during = await page.evaluate(n => SamtDebug.engine.echoLog.slice(n).filter(x => x[1] === true || x[1] === 'chime').length, off.log);
    ok(during === 0, `talking with the echo off: ${during} echoes or chimes`);
    await page.click('#pass'); await sleep(200);
    const on = await page.evaluate(() => ({ s: SamtDebug.session().echoOff, left: SamtDebug.ctrl.passLeft(), btn: document.querySelector('#pass').textContent, log: SamtDebug.engine.echoLog.length }));
    await pMe;
    const after = await page.evaluate(n => SamtDebug.engine.echoLog.slice(n).filter(x => x[1] === true).length, on.log);
    ok(!on.s && on.left === 0 && on.btn === 'Turn the echo off' && after > 0, `echo back on: button "${on.btn}", echoed again ${after} time(s) as the talk went on`);
    // off again, then stopping the recording brings the echo back and Talk freely with it
    await page.click('#pass'); await sleep(150);
    const rec1 = await page.evaluate(() => SamtDebug.tape().r.sec());
    await stopRec();
    s = await sess();
    const c1 = s.clips[0];
    ok(!s.echoOff && /^Talk freely/.test(await page.textContent('#pass')) && (await page.evaluate(() => SamtDebug.ctrl.passLeft())) === 0 && /Recording saved/.test(await page.textContent('#toast')),
      `stopped: echo back on, "${await page.textContent('#pass')}", "${await page.textContent('#toast')}"`);
    ok(c1.done && c1.parts >= 1 && c1.bytes > 0 && Math.abs(c1.dur - rec1) <= 1.5 && (await parts(c1.id)) === c1.parts,
      `clip 1 kept: ${c1.dur} s, ${c1.parts} part(s), ${c1.bytes} bytes, ${c1.mime}${mr ? '' : ` (16-bit at 16 kHz: ${(c1.bytes / 32000).toFixed(1)} s)`}`);

    // 2. too short to keep
    await page.click('#sRec'); await page.waitForFunction(() => !!SamtDebug.tape(), null, { timeout: 5000 }); await sleep(150); await stopRec();
    s = await sess();
    ok(s.clips.length === 1 && /Too short/.test(await page.textContent('#toast')), `a recording under a second isn't kept: ${s.clips.length} clip(s), "${await page.textContent('#toast')}"`);

    // 3. a held pause doesn't stop a recording (the mic stays on); Record still works from the pause
    const p3 = recordFor(0, 'phr_hello'); await sleep(Math.round(9400 / +speed * 0.4));
    await hold('#stop'); await sleep(200);
    const pz = await page.evaluate(() => ({ paused: SamtDebug.session().paused, tape: !!SamtDebug.tape(), vis: !document.querySelector('#sRec').hidden && !document.querySelector('#sRec').disabled, pass: document.querySelector('#pass').hidden }));
    ok(pz.paused && pz.tape && pz.vis && pz.pass, 'a held pause keeps the recording going; Record (to stop it) stays on screen');
    await page.click('#resume'); await sleep(300); await p3; await sleep(400); await stopRec();
    s = await sess(); const c3 = s.clips[1];
    ok(s.clips.length === 2 && c3 && c3.id.endsWith('.3') && c3.done && c3.dur >= 1, `clip after the pause kept: ${c3 && c3.id}, ${c3 && c3.dur} s (the too-short one's number isn't used again)`);

    // 4. a call cuts the mic: the recording stops and keeps what it got; Resume carries on
    const p4 = recordFor(0, 'phr_okay'); await sleep(Math.round(9500 / +speed * 0.6) + (mr ? 600 : 0));
    await page.evaluate(() => SamtDebug.trouble('interrupted'));
    await page.waitForFunction(() => !SamtDebug.tape(), null, { timeout: 8000 }); await sleep(400);
    s = await sess(); const c4 = s.clips[2];
    ok(s.paused && s.clips.length === 3 && c4 && c4.done && c4.dur >= 1 && /mic stopped/.test(await page.textContent('#toast')) && await page.isDisabled('#sRec'),
      `a call: recording stopped and kept (${c4 && c4.dur} s), "${await page.textContent('#toast')}", Record waits for Resume`);
    await page.click('#resume'); await sleep(400); await p4;
    ok(!(await sess()).paused && !(await page.isDisabled('#sRec')), 'Resume: the session and Record carry on');

    // a phone: the row fits, even with a long recording time
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(300);
    await page.click('#sRec'); await page.waitForFunction(() => !!SamtDebug.tape(), null, { timeout: 5000 });
    const fit = await page.evaluate(() => { // the longest the recording time gets, measured before the next tick redraws it
      const b = document.querySelector('#sRec'), r = document.querySelector('#sReadout'); document.querySelector('#sRecText').textContent = '15:59:59';
      return { rec: b.scrollWidth <= b.clientWidth + 1, clock: r.scrollWidth <= r.clientWidth + 1, h: document.documentElement.scrollHeight, ih: innerHeight }; });
    await shot('session_rec_390');
    ok(fit.rec && fit.clock && (await overflow()) <= 0 && fit.h <= fit.ih + 1, `390px while recording: Record fits ${fit.rec}, clock fits ${fit.clock}, overflow ${await overflow()}px, page ${fit.h}px of ${fit.ih}`);
    await feed('phr_hi'); await stopRec();
    await page.setViewportSize({ width: 1024, height: 1366 }); await sleep(300);
    s = await sess();
    const ids = s.clips.map(c => c.id), recId = s.recId;
    out('clips: ' + s.clips.map(c => `${c.id} ${c.dur}s ${c.bytes}B`).join(' · '));

    // end the session: its sheet lists the recordings
    await hold('#stop'); await sleep(200); await page.click('#endSession');
    await page.waitForSelector('#endPanel.show', { timeout: 8000 }); await sleep(300);
    let er = await endSheetRecs();
    ok(er.length === 4 && await page.isVisible('#capRecs') && await page.isVisible('#recsHint') && /^Recording 1/.test(er[0]), 'end sheet, Recordings: ' + er.join(' | '));
    await shot('end_recs_1024');
    // play: the audio is put together from its parts and has the length recorded
    await page.click('#endRecs .row.btns >> nth=0 >> text=Play');
    await page.waitForSelector('#endRecs audio', { timeout: 5000 });
    const pl = await page.evaluate(async () => {
      const a = document.querySelector('#endRecs audio');
      if (!(a.readyState >= 1)) await new Promise(r => { a.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 5000); });
      const buf = await (await fetch(a.src)).arrayBuffer(), bytes = buf.byteLength; // (decoding empties the buffer in Chromium)
      let decoded = null; try { const ac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 16000); decoded = (await ac.decodeAudioData(buf)).duration; } catch (e) { decoded = 'error ' + e.message; }
      return { src: a.src.slice(0, 5), el: a.duration, bytes, decoded };
    });
    ok(pl.src === 'blob:' && typeof pl.decoded === 'number' && Math.abs(pl.decoded - c1.dur) <= 1.5 && pl.bytes === c1.bytes + (mr ? 0 : 44),
      `play: ${pl.bytes} bytes, decodes to ${typeof pl.decoded === 'number' ? pl.decoded.toFixed(2) + ' s' : pl.decoded} (recorded ${c1.dur} s), player says ${pl.el}`);
    // save: a file named for the day and time
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#endRecs .row.btns >> nth=1 >> text=Save')]);
    if (dl) {
      const p = path.join(OUT, `r_${engine}_${mode}_${dl.suggestedFilename()}`); await dl.saveAs(p);
      const size = fs.statSync(p).size, c2 = s.clips[1];
      ok(/^samt-\d{4}-\d\d-\d\d-\d{4}\.(wav|m4a|webm)$/.test(dl.suggestedFilename()) && size === c2.bytes + (mr ? 0 : 44) && (mr || fs.readFileSync(p).slice(0, 4).toString() === 'RIFF'),
        `save: ${dl.suggestedFilename()}, ${size} bytes`);
    } else ok(false, 'save: no download');
    // delete one
    await page.click('#endRecs .row.btns >> nth=3 >> text=Delete'); await page.waitForSelector('#actSheet.show');
    await page.click('#actRows .row.danger'); await sleep(700);
    er = await endSheetRecs();
    const hrec = await page.evaluate(id => SamtDebug.history().find(r => r.id === id), recId);
    ok(er.length === 3 && hrec && hrec.clips.length === 3 && (await parts(ids[3])) === 0 && /deleted/.test(await page.textContent('#toast')), `deleted the 4th: ${er.length} left, its parts gone`);
    await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' });

    // 5. the timer ends a session mid-recording: the recording is kept first; a short session is kept for it
    await page.click('#go'); await page.waitForSelector('#vSession:not([hidden])'); await sleep(300);
    await page.click('#sRec'); await page.waitForFunction(() => !!SamtDebug.tape(), null, { timeout: 5000 });
    await feed('phr_hello'); await sleep(mr ? 800 : 100);
    const short = await page.evaluate(() => SamtDebug.session().recId);
    await page.evaluate(() => { const s = SamtDebug.session(); s.endAt = Date.now() + 200; });
    await page.waitForSelector('#endPanel.show', { timeout: 10000 }); await sleep(300);
    const hs = await page.evaluate(id => SamtDebug.history().find(r => r.id === id), short);
    ok(hs && hs.dur < 30 && hs.clips && hs.clips.length === 1 && hs.clips[0].done && (await endSheetRecs()).length === 1 && /^Session done/.test(await page.textContent('#endTitle')),
      `timer ended it while recording: a ${hs && hs.dur} s session kept with its ${hs && hs.clips && hs.clips[0].dur} s recording`);
    await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' });

    // past sessions mark the recorded ones; after a reload the recordings are still there and play
    await page.reload(); await ready(); await sleep(600);
    const h1 = await page.evaluate(() => SamtDebug.history());
    ok(h1.length === h0 + 2 && h1.filter(r => r.clips && r.clips.length).length === 2, `after a reload: ${h1.length} sessions, ${h1.filter(r => r.clips && r.clips.length).length} with recordings`);
    await page.click('#toProgress'); await page.waitForSelector('#vProgress:not([hidden])'); await sleep(300);
    const rows = await page.$$eval('#histList .row:not(.danger)', rs => rs.map(r => r.textContent));
    ok(rows.length >= 2 && /Recorded/.test(rows[0]) && /Recorded/.test(rows[1]), 'past sessions: ' + rows.slice(0, 2).join(' | '));
    await page.click('#histList .row:not(.danger) >> nth=1'); await page.waitForSelector('#endPanel.show'); await sleep(300);
    er = await endSheetRecs();
    await page.click('#endRecs .row.btns >> nth=0 >> text=Play'); await page.waitForSelector('#endRecs audio', { timeout: 5000 });
    const pl2 = await page.evaluate(async () => { const a = document.querySelector('#endRecs audio'); return (await (await fetch(a.src)).arrayBuffer()).byteLength; });
    ok(er.length === 3 && pl2 === c1.bytes + (mr ? 0 : 44), `review after the reload: ${er.length} recordings, the first plays (${pl2} bytes)`);
    await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' });

    // deleting a session deletes its recordings
    await page.click('#histList .row:not(.danger) >> nth=1'); await page.waitForSelector('#endPanel.show');
    await page.click('#endDelete'); await page.waitForSelector('#actSheet.show');
    const msg = await page.textContent('#actMsg');
    await page.click('#actRows .row.danger'); await sleep(800);
    const left = await Promise.all(ids.slice(0, 3).map(parts));
    ok(/recordings are deleted/.test(msg) && left.every(n => n === 0) && !(await page.evaluate(id => SamtDebug.history().some(r => r.id === id), recId)), `delete the session: "${msg}"; parts left ${left.join(', ')}`);

    // parts no session lists: gone after a day, kept before
    const sw = await page.evaluate(async () => {
      const B = SamtDebug.blobs, old = 's' + (Date.now() - 3 * 864e5).toString(36) + '.1', fresh = 's' + Date.now().toString(36) + '.1';
      await B.put(old + ':00000', new ArrayBuffer(8)); await B.put(fresh + ':00000', new ArrayBuffer(8));
      const listed = SamtDebug.history().find(r => r.clips && r.clips.length).clips[0].id;
      await SamtDebug.sweep();
      return { old: await B.count(old), fresh: await B.count(fresh), listed: await B.count(listed) };
    });
    ok(sw.old === 0 && sw.fresh === 1 && sw.listed >= 1, `clean-up: an unlisted 3-day-old recording removed (${sw.old}), a new one kept (${sw.fresh}), a listed one kept (${sw.listed})`);
  } catch (e) { ok(false, 'ERROR ' + (e.stack || e).toString().slice(0, 700)); }
  ok(!errs.length, 'page errors: ' + (errs.join(' | ') || 'none'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await browser.close(); srv.kill(); process.exit(fails ? 1 : 0);
})();
