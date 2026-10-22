// Run from the repo root: node tests/setup-flow.js [webkit|chromium] [light|neural]. Serves the built site/ with the fake
// microphone (?fakemic=1) and feeds it the recordings in tests/audio/. Writes screenshots and the backup file that
// tests/features.js restores to tests/out/.
// End-to-end run of the built page in a real browser engine (chromium | webkit) with the fake mic, through the four
// states: setup step by step (the reading with a pause mid-reading, the echo test, other voices, the check and its
// advice, the summary), the setup again from Settings, a test session, a real session (Details, a correction, hold to
// stop), the end sheet, backup and restore, erase, layout at five widths. All with Your voice; tests/sound-level.js
// covers Sound level.
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require('/opt/node-tools/node_modules/playwright-core'); } })(); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path');
const [engine = 'webkit', mode = 'light', speed = '25'] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(__dirname, 'out'), sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8770 + Math.floor(Math.random() * 100);
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' }); await sleep(800);
  const PX = process.env.HTTPS_PROXY;
  const browser = engine === 'webkit'
    ? await pw.webkit.launch({ proxy: PX ? { server: PX, bypass: '127.0.0.1,localhost' } : undefined })
    : await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: PX ? [`--proxy-server=${PX}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 1366 } });
  let page = await ctx.newPage(); const errs = [];
  const hook = pg => { pg.on('pageerror', e => errs.push('pageerror: ' + e.message)); pg.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); }); };
  hook(page);
  // This test build of WebKit crashes on any reload after a history step back (a plain page does it too), so "reload"
  // reopens Samt in a new tab of the same browser, which keeps its saved setup.
  const reopen = async () => { const old = page; page = await ctx.newPage(); hook(page); await page.goto(old.url()); await old.close(); };
  const out = s => console.log(`[${engine} ${mode}] ${s}`);
  const view = () => page.evaluate(() => SamtDebug.view());
  const hold = async sel => { const b = await page.locator(sel).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(2200); await page.mouse.up(); };
  const back = async () => { await page.click(`#v${(await view()).replace(/^./, c => c.toUpperCase())} [data-back]`); await sleep(200); };
  try {
    await page.goto(`http://127.0.0.1:${PORT}/site/${mode}/?fakemic=1&speed=${speed}`);
    if (mode === 'neural') { await page.waitForFunction(() => document.querySelector('#modelStatus').textContent.startsWith('Ready'), null, { timeout: 180000 }); out('model: ' + await page.textContent('#modelStatus')); }
    await page.waitForFunction(() => window.SamtDebug && SamtDebug.feed, null, { timeout: 20000 });
    const feed = n => page.evaluate(x => SamtDebug.feed(x, '/tests/audio/' + x + '.f32'), n);
    const idle = () => page.waitForFunction(() => !document.querySelector('#resetAll').disabled, null, { timeout: 300000 }); // enabled only when nothing is running
    out(`first open: setup card ${await page.isVisible('#setupCard')} ("${await page.textContent('#setupTitle')}"), Start shown ${await page.isVisible('#go')}, quick tools ${await page.isVisible('#openCards')}`);
    // 1. setup, step by step, from the first open's card: the reading (with a pause part-way), the echo test, other
    //    voices and the check (two rounds, then the advice), then the summary
    const step = async () => `${await page.textContent('#wzCount')}: ${await page.textContent('#wzStepTitle')}`;
    const wzIdle = () => page.waitForFunction(() => !document.querySelector('#wzMain').disabled && document.querySelector('#recPanel').hidden, null, { timeout: 300000 });
    const goNext = async () => { if (await page.isVisible('#wzMain') && (await page.textContent('#wzMain')) === 'Next') await page.click('#wzMain'); else await page.click('#wzNext'); await sleep(250); };
    await page.click('#setupStart'); await sleep(300);
    out(`wizard: view ${await view()} | ${await step()} | main "${await page.textContent('#wzMain')}" | Skip shown ${await page.isVisible('#wzNext')} | Previous shown ${await page.isVisible('#wzPrev')}`);
    let t0 = Date.now();
    await page.click('#wzMain'); await page.waitForSelector('#recPanel:not([hidden])'); await sleep(300);
    const half = page.evaluate(() => SamtDebug.feed('enroll_me', '/tests/audio/enroll_me.f32'));
    await page.waitForFunction(() => /[1-9]\d* of 45/.test(document.querySelector('#recHint').textContent), null, { timeout: 60000 });
    await page.evaluate(() => SamtDebug.trouble('interrupted'));
    out(`pause mid-reading: Resume shown ${await page.isVisible('#recResume')} | ${await page.textContent('#recHint')}`);
    await page.click('#recResume'); await sleep(200); out('after Resume: ' + await page.textContent('#recHint'));
    await half;
    await page.waitForSelector('#recDone:not([disabled])'); await page.click('#recDone');
    await page.waitForFunction(() => SamtDebug.wiz().states[0] === 'done' && !document.querySelector('#wzMain').disabled, null, { timeout: 300000 });
    out(`step 1 in ${Date.now() - t0} ms: ${await page.textContent('#wzStatus')} | main "${await page.textContent('#wzMain')}" | the echo test opened by itself: ${await page.isVisible('#testPanel')}`);
    await goNext(); out(`${await step()} | Skip shown ${await page.isVisible('#wzNext')}`);
    await page.click('#wzMain'); await page.waitForSelector('#testPanel.show');
    await page.click('#testStart'); await sleep(300); await feed('enroll2_me');
    await page.waitForFunction(() => !document.querySelector('#testDone').hidden || !document.querySelector('#testMore').hidden || document.querySelector('#testStart').textContent === 'Try again', null, { timeout: 60000 });
    out('echo test: ' + await page.textContent('#testText'));
    await page.click(await page.isVisible('#testDone') ? '#testDone' : '#testSkip'); await page.waitForSelector('#testPanel', { state: 'hidden' });
    out(`step 2: ${await page.isVisible('#wzStatus') ? await page.textContent('#wzStatus') : '(no status)'}`);
    await goNext(); out(await step());
    t0 = Date.now(); await page.click('#wzMain'); await sleep(300); await feed('enroll_oth');
    await page.waitForSelector('#recDone:not([disabled])'); await page.click('#recDone'); await wzIdle();
    out(`step 3 in ${Date.now() - t0} ms: ${await page.textContent('#wzStatus')}`);
    await goNext(); out(`${await step()} | main "${await page.textContent('#wzMain')}"`);
    // the check's voices come from the 5-minute test stream, so none of them was used to teach Samt: your talk, then
    // two men's talk (the hard case for Light)
    const clip = (roles, maxSec) => page.evaluate(async ([roles, maxSec]) => {
      const tl = await (await fetch('/tests/audio/test.json')).json(), x = new Float32Array(await (await fetch('/tests/audio/test.f32')).arrayBuffer());
      const parts = [], gap = new Float32Array(14400); let sec = 0;
      for (const c of tl.filter(c => roles.includes(c.role) && c.kind === 'test_talk')) { if (sec >= maxSec) break; parts.push(x.subarray(Math.round(c.start * 16000), Math.round(c.end * 16000)), gap); sec += c.end - c.start; }
      const y = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { y.set(p, o); o += p.length; }
      return SamtDebug.engine.play('check', y);
    }, [roles, maxSec]);
    const runCheck = async () => {
      await page.waitForSelector('#recPanel:not([hidden])'); await sleep(300);
      await clip(['me'], 19); await sleep(1500);
      if (await page.isEnabled('#recDone') && (await page.textContent('#recDone')) === 'Done') await page.click('#recDone');
      await page.waitForFunction(() => document.querySelector('#recDone').textContent === 'Start', null, { timeout: 60000 });
      out(`check, between the rounds: "${await page.textContent('#recTitle')}" | ${await page.textContent('#recHint')}`);
      await page.click('#recDone'); await sleep(300);
      await clip(['man_typ', 'man_hard'], 18); await sleep(1500);
      if (await page.isVisible('#recPanel') && await page.isEnabled('#recDone')) await page.click('#recDone');
      await page.waitForSelector('#recPanel', { state: 'hidden', timeout: 60000 }); await wzIdle();
      return `caught you ${await page.textContent('#wzYou')} | ignored others ${await page.textContent('#wzOth')} | "${await page.textContent('#wzStatus')}" | main "${await page.textContent('#wzMain')}"`;
    };
    await page.evaluate(v => { SamtDebug.engine.speed = v; }, mode === 'neural' ? 1 : 4); // the neural checks need real time
    const checkLog = async () => (await page.evaluate(() => SamtDebug.checkLog)).map(s => `${s.round ? 'O' : 'Y'}${s.sec}s:${s.echoed ? (s.echoAtEnd ? 'E' : 'e') : '-'}${s.speaker[0]}`).join(' ');
    t0 = Date.now(); await page.click('#wzMain'); let r = await runCheck(); out(`step 4 in ${Date.now() - t0} ms: ${r}`);
    out('  stretches (Y you, O others; E echo to the end, e echo then off, - none; speaker m/o/u): ' + await checkLog());
    if ((await page.textContent('#wzMain')).startsWith('Make it')) { // the one-tap fix: Matching changes, the check runs again
      t0 = Date.now(); await page.click('#wzMain'); r = await runCheck();
      out(`after the fix (Matching ${await page.textContent('#matchStatus')}) in ${Date.now() - t0} ms: ${r}`);
      out('  stretches: ' + await checkLog());
    }
    await page.evaluate(v => { SamtDebug.engine.speed = v; }, +speed);
    await goNext();
    out(`summary: ${await page.textContent('#wzSumTitle')} | ${(await page.$$eval('#wzSumList .row', rs => rs.map(r => r.querySelector('.rt').textContent + ': ' + r.querySelector('.rv').textContent))).join(' · ')}`);
    await page.click('#wzFinish'); await sleep(300);
    out(`Finish goes to: ${await view()} | ready card ${await page.isVisible('#readyCard')}, setup card ${await page.isVisible('#setupCard')}`);
    // 2. the setup again from Settings (it opens on the summary)
    await page.click('#toSettings'); await sleep(200);
    out(`Settings: step-by-step setup "${await page.textContent('#wizStatus')}" | voice ${await page.textContent('#voiceStatus')} | others ${await page.textContent('#othStatus')} | muted sounds ${await page.textContent('#muteStatus')} | phrases row gone ${!(await page.$('#toPhrases'))}`);
    await page.click('#toWizard'); await sleep(300); out(`setup from Settings opens on: ${await page.textContent('#wzSumTitle')} (Back says "${await page.textContent('#wzBack')}")`);
    await back(); out('Back from the setup goes to: ' + await view()); await back(); out('then to: ' + await view());
    await reopen();
    if (mode === 'neural') await page.waitForFunction(() => document.querySelector('#modelStatus').textContent.startsWith('Ready'), null, { timeout: 180000 });
    await page.waitForFunction(() => window.SamtDebug && SamtDebug.feed && document.querySelector('#voiceStatus').textContent !== 'Not taught', null, { timeout: 20000 });
    out(`after reload: voice ${await page.textContent('#voiceStatus')} | others ${await page.textContent('#othStatus')} | Home ready ${await page.isVisible('#readyCard')}`);
    // 3. a test session (a tap stops it)
    const TEST = process.env.TEST || 'test';
    if (process.env.TSPEED) await page.evaluate(v => { SamtDebug.engine.speed = v; }, +process.env.TSPEED);
    t0 = Date.now(); await page.click('#test'); await sleep(300);
    out(`test session: view ${await view()}, label "${await page.textContent('#sKind')}", Talk freely shown ${await page.isVisible('#pass')}, Stop says "${await page.textContent('#stopText')}"`);
    await feed(TEST); await sleep(1500); await page.click('#stop'); await sleep(300);
    const ev = await page.evaluate(() => ({ segs: SamtDebug.events.filter(e => e.type === 'segment').map(e => ({ start: e.rec.start, end: e.rec.end, echo: e.rec.echo, passes: e.rec.passes, speaker: e.rec.speaker })), echo: SamtDebug.events.filter(e => e.type === 'state' && e.state === 'echo').map(e => e.t) }));
    const tl = JSON.parse(fs.readFileSync(path.join(__dirname, 'audio', TEST + '.json')));
    const res = tl.map(c => { const s = ev.segs.filter(r => r.end / 100 >= c.start - 0.05 && r.start / 100 <= c.end + 0.05); const e = ev.echo.find(t => t >= c.start && t <= c.end + 0.5); return { ...c, echo: s.some(r => r.echo), passes: [].concat(...s.map(r => r.passes)), lat: e != null ? e - c.start : null }; });
    const pct = (a, f) => a.length ? Math.round(100 * a.filter(f).length / a.length) + '%' : '-';
    const me = res.filter(r => r.role === 'me'), oth = res.filter(r => r.role !== 'me'), talk = me.filter(r => r.kind === 'test_talk'), ph = me.filter(r => r.kind === 'test_phrase');
    const lats = talk.filter(r => r.lat != null).map(r => r.lat).sort((a, b) => a - b);
    out(`test pass ${Date.now() - t0} ms: your talk echoed ${pct(talk, r => r.echo)} (median ${lats.length ? lats[lats.length >> 1].toFixed(2) : '-'} s) | your short phrases let through ${pct(ph, r => !r.echo)} (no phrase list now) | others ignored ${pct(oth, r => !r.echo)} | back on ${await view()}`);
    // 4. a real session: Details, a correction, a tap that doesn't stop it, a hold that does
    await page.click('#go'); await sleep(300); await feed('enroll2_me'); await sleep(600);
    out('silence mode echo toggles: ' + (await page.evaluate(() => SamtDebug.engine.echoLog.length)));
    await page.click('#detailsBtn'); await page.waitForSelector('#detailsPanel.show');
    out(`Details: You ${await page.textContent('#tlMe')} · talk ${await page.textContent('#cTalkTime')} · echoed ${await page.textContent('#cTalk')} · volume ${await page.textContent('#dVolOut')}`);
    if (await page.isVisible('#last')) { const b = await page.$('#notMe:not([disabled])') || await page.$('#wasMe:not([disabled])'); if (b) { await b.click(); await sleep(200); out('correction: ' + await page.textContent('#lastText') + ' | ' + await page.textContent('#toast')); } }
    await page.click('#detailsClose'); await page.waitForSelector('#detailsPanel', { state: 'hidden' });
    await page.click('#stop'); await sleep(300); out(`a tap on Stop: still ${await view()}`);
    await hold('#stop');
    await page.waitForSelector('#endPanel.show', { timeout: 8000 }); out('end of session: ' + (await page.textContent('#endTitle')) + ` | under it: ${await view()}`);
    await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' }); await idle();
    // 5. backup, restore and the erase sheet, from Settings
    await page.click('#toSettings'); await sleep(200);
    out(`Settings index: ${(await page.evaluate(() => Math.round(document.documentElement.scrollHeight / innerHeight * 10) / 10))} screens tall at this size`);
    await page.click('#toData'); await page.waitForSelector('#dataPanel.show');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#backupBtn')]);
    if (dl) { const p = path.join(OUT, `backup_${engine}_${mode}.json`); await dl.saveAs(p); out(`backup file ${Math.round(fs.statSync(p).size / 1024)} KB`);
      await page.setInputFiles('#restoreFile', p); await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('restored') || !document.querySelector('#note').hidden, null, { timeout: 15000 }); out('restore: ' + (await page.textContent('#toast')) + ' ' + (await page.isVisible('#note') ? await page.textContent('#note') : '')); }
    await page.click('#resetAll'); await page.waitForSelector('#actSheet.show'); out('erase sheet: ' + (await page.textContent('#actTitle'))); await page.click('#actCancel'); await sleep(400);
    await page.click('#dataDone'); await page.waitForSelector('#dataPanel', { state: 'hidden' });
    await back();
    // 6. layout at the five widths, Home / Settings / Progress / the setup (its check step, with the result)
    for (const [w, h, theme] of [[390, 844, 'day'], [744, 1133, 'night'], [834, 1194, 'day'], [1024, 1366, 'night'], [1440, 900, 'day']]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(t => { localStorage.setItem('samt.theme', t); document.body.classList.toggle('theme-dark', t === 'night'); }, theme);
      const res = [];
      for (const v of ['home', 'settings', 'progress', 'wizard']) {
        if (v === 'wizard') { await page.click('#toSettings'); await sleep(200); await page.click('#toWizard'); await sleep(200); await page.click('#wzSumList .row:nth-child(4)'); }
        else if (v !== 'home') await page.click(v === 'settings' ? '#toSettings' : '#toProgress');
        await sleep(300);
        if (w === 390 || w === 1024) await page.screenshot({ path: path.join(OUT, `${engine}_${mode}_${v}_${w}_${theme}.png`), fullPage: true });
        const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        const tall = await page.evaluate(() => Math.round(document.documentElement.scrollHeight / innerHeight * 10) / 10);
        const content = await page.evaluate(() => Math.round(document.querySelector('.win').getBoundingClientRect().bottom + 32));
        res.push(`${v} overflow ${over}px, ${tall} screens (content ${content}px)`);
        if (v === 'wizard') await back();
        if (v !== 'home') await back();
      }
      out(`${w}px ${theme}: ${res.join(' | ')}`);
    }
  } catch (e) { out('ERROR ' + (e.stack || e).toString().slice(0, 700)); }
  out('page errors: ' + (errs.length ? errs.join(' | ') : 'none'));
  await browser.close(); srv.kill();
})();
