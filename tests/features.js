// Run from the repo root after tests/setup-flow.js has run for the same engine and version (it restores that run's
// backup from tests/out/): node tests/features.js [webkit|chromium] [light|neural]. Ends ALL PASS or N FAILED.
// The features in a real engine with the fake mic, on the stage-based layout: Home (conversation options, quick tools),
// the session view (talk freely and its limit, Details, a short tap on the main button, hold to pause, Resume, End session, Back can't leave), the end sheet with a
// (mocked) Claude summary, Progress (today, budget, the week, past sessions), Settings (backup), layout at 390 and 1024.
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require('/opt/node-tools/node_modules/playwright-core'); } })(); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path');
const [engine = 'webkit', mode = 'light', speed = '10'] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(__dirname, 'out'), sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8870 + Math.floor(Math.random() * 100);
let fails = 0; const ok = (c, s) => { console.log(`[${engine} ${mode}] ${c ? 'PASS' : 'FAIL'} ${s}`); if (!c) fails++; };
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' }); await sleep(800);
  const PX = process.env.HTTPS_PROXY;
  const browser = engine === 'webkit'
    ? await pw.webkit.launch({ proxy: PX ? { server: PX, bypass: '127.0.0.1,localhost' } : undefined })
    : await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: PX ? [`--proxy-server=${PX}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 1366 } });
  const page = await ctx.newPage(); const errs = []; let sent = null; const fontHits = [];
  page.on('response', r => { if (/\/fonts\/.+\.woff2$/.test(r.url())) fontHits.push({ url: r.url(), status: r.status() }); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.route('**/api/summary', async route => { sent = JSON.parse(route.request().postData() || '{}'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary: 'You kept quiet well. Next time, try a shorter turn.' }) }); });
  const out = s => console.log(`[${engine} ${mode}] ${s}`);
  const shot = n => page.screenshot({ path: path.join(OUT, `f_${engine}_${mode}_${n}.png`), fullPage: false });
  const view = () => page.evaluate(() => SamtDebug.view());
  const cap = s => s.replace(/^./, c => c.toUpperCase());
  const back = async () => { await page.click(`#v${cap(await view())} [data-back]`); await sleep(250); };
  const toHome = async () => { for (let i = 0; i < 3 && (await view()) !== 'home'; i++) await back(); };
  const visit = async v => { await toHome(); if (v !== 'home') { await page.click('#to' + cap(v)); await page.waitForSelector(`#v${cap(v)}:not([hidden])`); await sleep(200); } };
  const hold = async sel => { const b = await page.locator(sel).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(2200); await page.mouse.up(); };
  const smallText = () => page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.offsetParent && e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.tagName + '.' + e.className + ':' + getComputedStyle(e).fontSize).slice(0, 8));
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const toSec = t => t.split(':').reduce((a, x) => a * 60 + +x, 0);
  try {
    await page.goto(`http://127.0.0.1:${PORT}/site/${mode}/?fakemic=1&speed=${speed}`);
    if (mode === 'neural') await page.waitForFunction(() => document.querySelector('#modelStatus').textContent.startsWith('Ready'), null, { timeout: 180000 });
    await page.waitForFunction(() => window.SamtDebug && SamtDebug.feed, null, { timeout: 20000 });
    const feed = n => page.evaluate(x => SamtDebug.feed(x, '/tests/audio/' + x + '.f32'), n);
    // the setup from the earlier run's backup file
    await page.setInputFiles('#restoreFile', path.join(OUT, `backup_${engine}_${mode}.json`));
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('restored'), null, { timeout: 30000 });
    ok(await page.isVisible('#readyCard') && await page.isHidden('#setupCard'), 'setup restored from backup: Home shows the start card');
    // no double-tap zoom: every element is touch-action manipulation, except hold-to-stop (none, for the hold)
    const ta = await page.evaluate(() => { const odd = [...document.querySelectorAll('body *')].filter(e => getComputedStyle(e).touchAction !== 'manipulation').map(e => e.id || e.className); return { odd, stop: getComputedStyle(document.querySelector('#stop')).touchAction }; });
    ok(ta.odd.length === 1 && ta.odd[0] === 'stop' && ta.stop === 'none', 'no double-tap zoom: every element manipulation, Stop none (' + JSON.stringify(ta.odd) + ')');
    const h0 = (await page.evaluate(() => SamtDebug.history())).length; // a restored backup may bring past sessions
    if (!h0) ok(await page.isHidden('#toProgress'), 'no sessions yet: no Progress row');
    else { await visit('progress'); ok((await page.$$('#histList .row:not(.danger)')).length === h0, `Progress lists the ${h0} restored sessions`); await toHome(); }
    // Conversation: its options open from the line under the picker
    await page.click('#kindSeg button:nth-of-type(2)');
    ok((await page.textContent('#go')) === 'Start conversation', 'kind seg: Start conversation');
    ok(await page.isVisible('#convLine'), 'conversation line: ' + await page.textContent('#convLine'));
    await page.click('#convLine'); await page.waitForSelector('#convPanel.show');
    await page.click('#limitDown'); await page.click('#limitDown');
    ok((await page.textContent('#limitOut')) === '5 s', 'talk limit 5 s');
    ok((await page.getAttribute('#swNudge', 'aria-checked')) === 'true' && (await page.getAttribute('#swInterrupt', 'aria-checked')) === 'true', 'switches on by default');
    await page.click('#convDone'); await page.waitForSelector('#convPanel', { state: 'hidden' });
    ok(/^5 s turns/.test(await page.textContent('#convLine')), 'line updated: ' + await page.textContent('#convLine'));
    // the session view
    await page.click('#go'); await page.waitForSelector('#vSession:not([hidden])'); await sleep(300);
    ok((await view()) === 'session' && await page.isHidden('#vHome'), 'session view replaces Home');
    ok(/Conversation/.test(await page.textContent('#sKind')), 'kind: ' + await page.textContent('#sKind'));
    ok(await page.isVisible('#remind') && (await page.textContent('#remind')).length > 10, 'a reminder shows when the session starts');
    ok(await page.isVisible('#pass') && await page.isVisible('#quietLine') && await page.isVisible('#detailsBtn'), 'Talk freely, quiet timer and Details show');
    await page.evaluate(() => history.back()); await sleep(400);
    ok((await view()) === 'session' && await page.isVisible('#vSession'), 'the browser Back button does not leave a session');
    await shot('session_1024');
    const p1 = feed('enroll2_me');
    await page.waitForFunction(() => SamtDebug.events.some(e => e.type === 'nudge'), null, { timeout: 60000 }).catch(() => {});
    const nudgeAt = await page.evaluate(() => { const e = SamtDebug.events.find(e => e.type === 'nudge'); return e ? e.t : null; });
    await page.waitForFunction(() => SamtDebug.events.some(e => e.type === 'state' && e.state === 'echo'), null, { timeout: 60000 }).catch(() => {});
    const echoAt = await page.evaluate(() => { const e = SamtDebug.events.find(e => e.type === 'state' && e.state === 'echo'); return e ? e.t : null; });
    const firstSpeech = await page.evaluate(() => { const e = SamtDebug.events.find(e => e.type === 'verdict'); return e ? e.t : null; });
    ok(nudgeAt != null && echoAt != null && echoAt > nudgeAt, `nudge before the echo (first verdict ${firstSpeech}s, nudge ${nudgeAt}s, echo ${echoAt}s)`);
    ok((await page.evaluate(() => SamtDebug.engine.echoLog.filter(x => x[1] === 'chime').length)) >= 1, 'the nudge tone played');
    // talk freely
    await page.click('#pass');
    const left = await page.evaluate(() => SamtDebug.ctrl.passLeft());
    ok(left > 18 && left <= 20, `talk freely: ${left.toFixed(1)} s left`);
    await sleep(100); ok(/^Echo back in 0:(19|20)$/.test(await page.textContent('#liveText')) && /^Add 20 s · 2 left$/.test(await page.textContent('#pass')), `pill "${await page.textContent('#liveText')}", button "${await page.textContent('#pass')}"`);
    await page.click('#pass'); const left2 = await page.evaluate(() => SamtDebug.ctrl.passLeft());
    ok(left2 > 20.5 && left2 <= 40, `a second tap adds 20 s (${left2.toFixed(1)} s left)`);
    // the third tap within 10 minutes still counts, then Talk freely is off for an hour (kept on the device)
    await page.click('#pass'); await sleep(100);
    const lock = await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('samt.shared')); return { min: Math.round((s.freeLock - Date.now()) / 60000), left: SamtDebug.ctrl.passLeft() }; });
    ok(lock.min === 60 && lock.left > 40 && await page.isDisabled('#pass') && /off for an hour/.test(await page.textContent('#toast')), `third tap: ${lock.left.toFixed(1)} s left, then off for ${lock.min} min; button off; "${await page.textContent('#toast')}"`);
    // a card and the sign from inside the session
    await page.click('#sCard'); await page.waitForSelector('#cardsPanel.show'); ok(true, 'Card opens in a session');
    await page.click('#cardsClose'); await page.waitForSelector('#cardsPanel', { state: 'hidden' });
    await page.click('#sSign'); await page.waitForSelector('#showView.show'); ok((await page.textContent('#showText')).length > 3, 'Sign opens in a session');
    await page.click('#showClose'); await page.waitForSelector('#showView', { state: 'hidden' });
    await p1; await sleep(500);
    // Details
    await page.click('#detailsBtn'); await page.waitForSelector('#detailsPanel.show'); await sleep(300);
    const tl = await page.textContent('#tlMe'); ok(/%/.test(tl), 'Details, you vs others: ' + tl + ' / ' + await page.textContent('#tlOth'));
    out('Details: talk ' + await page.textContent('#cTalkTime') + ', turns ' + await page.textContent('#cTalk') + ', short replies ' + await page.textContent('#cShort') + ', others ' + await page.textContent('#cOther') + ', cut in ' + await page.textContent('#cInt') + ', muted sounds ' + await page.textContent('#muteStatus2'));
    await shot('details_1024');
    await page.click('#detailsClose'); await page.waitForSelector('#detailsPanel', { state: 'hidden' });
    out('verdicts before any interruption: ' + await page.evaluate(() => { const ev = SamtDebug.events; const i = ev.findIndex(e => e.type === 'interrupt'); if (i < 0) return 'none'; let from = 0; for (let k = i - 1; k >= 0; k--) if (ev[k].type === 'segment') { from = k + 1; break; } return ev.slice(from, i + 1).filter(e => e.type === 'verdict' || e.type === 'interrupt').map(e => e.type === 'verdict' ? (e.isMe ? 'me' : 'oth') + '(' + e.margin.toFixed(1) + ')@' + e.t : 'INT@' + e.t).join(' '); }));
    // the session view on a phone, with Details open
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(400); await shot('session_390');
    ok((await overflow()) <= 0, `session 390px: overflow ${await overflow()}px`);
    let small = await smallText(); ok(!small.length, 'session 390px text floor 16: ' + (small.join(', ') || 'ok'));
    ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'session 390px fits one screen: ' + await page.evaluate(() => document.documentElement.scrollHeight) + 'px');
    await page.click('#detailsBtn'); await page.waitForSelector('#detailsPanel.show'); await sleep(400); await shot('details_390');
    small = await smallText(); ok(!small.length, 'Details 390px text floor 16: ' + (small.join(', ') || 'ok'));
    await page.click('#detailsClose'); await page.waitForSelector('#detailsPanel', { state: 'hidden' });
    await page.setViewportSize({ width: 1024, height: 1366 }); await sleep(300);
    // pausing: a tap keeps it going, a 2-second hold pauses it (the clock stands still); Resume, then pause and End session
    await page.click('#stop'); await sleep(400);
    ok((await view()) === 'session' && /Hold 2 seconds to pause/.test(await page.textContent('#toast')), 'a tap on the main button keeps the session: ' + await page.textContent('#toast'));
    await hold('#stop'); await sleep(200);
    const c1 = await page.textContent('#sReadout'); await sleep(2200); const c2 = await page.textContent('#sReadout');
    ok(/^Echo back in (1:00|0:5\d)$/.test(await page.textContent('#liveText')) && await page.isVisible('#resume') && await page.isVisible('#endSession') && await page.isHidden('#stop') && await page.isHidden('#pass') && c1 === c2,
      `a 2 s hold pauses: pill "${await page.textContent('#liveText')}", Resume and End session shown, clock stays ${c1} → ${c2}`);
    await page.click('#resume'); await sleep(400);
    ok(!(await page.evaluate(() => SamtDebug.session().paused)) && await page.isVisible('#stop') && await page.isHidden('#endSession'), 'Resume ends the pause early: ' + await page.textContent('#liveText'));
    // a pause ends by itself after 60 s (the test moves the pause's start back instead of waiting)
    await hold('#stop'); await sleep(200); const c3 = await page.textContent('#sReadout');
    await page.evaluate(() => { const s = SamtDebug.session(); s.pausedAt -= 58000; if (s.endAt) s.endAt -= 58000; SamtDebug.tick(); }); // as if 58 s went by: the pause's start and the session's end move together
    const near = await page.textContent('#liveText');
    await page.evaluate(() => { const s = SamtDebug.session(); s.pausedAt -= 3000; if (s.endAt) s.endAt -= 3000; SamtDebug.tick(); }); await sleep(300);
    ok(/^Echo back in 0:0[1-2]$/.test(near) && !(await page.evaluate(() => SamtDebug.session().paused)) && await page.isVisible('#stop') && Math.abs(toSec(await page.textContent('#sReadout')) - toSec(c3)) <= 2,
      `after 60 s the echo is back by itself: "${near}" → paused ${await page.evaluate(() => SamtDebug.session().paused)}; clock ${c3} → ${await page.textContent('#sReadout')}`);
    await hold('#stop'); await sleep(200); await page.click('#endSession');
    await page.waitForSelector('#endPanel.show', { timeout: 5000 });
    ok(true, 'End session from the pause; end sheet: ' + (await page.$$eval('#endStats .row', rs => rs.map(r => r.textContent).join(' | '))));
    await page.click('#moodSeg button:nth-of-type(2)'); await page.fill('#endNote', 'Hard in the meeting, easier after.');
    await shot('end_1024');
    await page.click('#askClaude');
    await page.waitForSelector('#endSummary:not([hidden])', { timeout: 10000 });
    ok((await page.textContent('#endSummaryText')).includes('quiet'), 'Claude summary shows');
    ok(sent && sent.session && sent.session.mood === 'okay' && sent.session.note.startsWith('Hard') && sent.session.echoBy === 'voice' && !('phrasesPassed' in sent.session) && Array.isArray(sent.last7Days) && sent.last7Days.length === 7 && !('samples' in sent) && JSON.stringify(sent).length < 3000,
      'request body: ' + JSON.stringify(sent).slice(0, 300));
    await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' });
    ok((await view()) === 'home' && await page.isVisible('#toProgress'), 'back on Home, Progress row: ' + await page.textContent('#progressStatus'));
    // Progress
    await visit('progress');
    const rows = await page.$$eval('#histList .row:not(.danger)', rs => rs.map(r => r.textContent));
    ok(rows.length === h0 + 1 && /Conversation/.test(rows[0]) && /Okay/.test(rows[0]), 'past sessions: ' + rows.join(' | '));
    const h = await page.evaluate(() => SamtDebug.history().slice().sort((a, b) => b.at - a.at));
    ok(h.length === h0 + 1 && h[0].note.startsWith('Hard') && h[0].summary && h[0].mood === 'okay' && h[0].kind === 'conversation', 'record saved with kind, mood, note, summary');
    ok((await page.textContent('#todayTalk')) !== '0:00', 'today talk time: ' + await page.textContent('#todayTalk'));
    ok(await page.evaluate(() => { const b = document.querySelectorAll('#weekPlot .wk-bar')[6]; return b && parseFloat(b.style.height) > 0; }), 'week chart: today has a column');
    await page.click('#budgetUp'); ok((await page.textContent('#budgetOut')) === '25 min', 'budget 25 min');
    await page.click('#histList .row:not(.danger)'); await page.waitForSelector('#endPanel.show');
    ok((await page.inputValue('#endNote')).startsWith('Hard') && !(await page.isHidden('#endDelete')), 'review opens with the note and Delete');
    await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' });
    await toHome(); ok((await view()) === 'home', 'Back to Home');
    // cards
    await page.click('#openCards'); await page.waitForSelector('#cardsPanel.show');
    ok((await page.$$('#cardGrid .cardb')).length === 8, 'eight cards');
    await shot('cards_1024');
    await page.click('#cardGrid .cardb >> nth=0'); await page.waitForSelector('#showView.show');
    ok((await page.textContent('#showText')) === 'Yes', 'show a card: Yes');
    await page.click('#showTurn'); ok(await page.evaluate(() => document.querySelector('#showView').classList.contains('turned')), 'turn around');
    await shot('show_1024');
    await page.click('#showClose'); await page.waitForSelector('#showView', { state: 'hidden' });
    await page.fill('#cardText', 'Back in ten minutes'); await page.click('#cardSaveTyped');
    ok((await page.$$('#cardGrid .cardb')).length === 9, 'saved a card');
    await page.click('#cardsEdit'); await page.click('#cardGrid .cardb.custom'); await page.waitForSelector('#actSheet.show');
    await page.click('#actRows .row.danger'); await sleep(450);
    ok((await page.$$('#cardGrid .cardb')).length === 8, 'deleted it');
    await page.click('#cardsClose'); await page.waitForSelector('#cardsPanel', { state: 'hidden' });
    // the sign
    await page.click('#openSign'); await page.waitForSelector('#showView.show');
    ok((await page.textContent('#showText')) === "I'm keeping quiet" && await page.isVisible('#showGlyph'), 'sign shows');
    await page.click('#showWords'); await page.waitForSelector('#actSheet.show'); await page.click('#actRows .row >> nth=1'); await sleep(450);
    ok((await page.textContent('#showText')) === 'Quiet time', 'sign words changed');
    await shot('sign_1024');
    await page.click('#showClose'); await page.waitForSelector('#showView', { state: 'hidden' });
    // reminders
    await page.click('#openRemind'); await page.waitForSelector('#remPanel.show');
    const n = (await page.$$('#remList .rem')).length; ok(n === 13, `reminders listed: ${n}`);
    await page.click('#remList .rem .btn.plain >> nth=0'); ok(await page.isVisible('#remList .rem .mean >> nth=0'), 'meaning opens on a tap');
    const ar = await page.evaluate(() => document.querySelector('#remList .rem .ar').textContent);
    ok(ar.normalize('NFC') === ar && /^مَّا يَلْفِظُ/.test(ar), 'first verse text intact');
    const fx = await page.evaluate(async () => {
      await document.fonts.ready; const un = s => s.replace(/"/g, '');
      const q = document.querySelector('#remList .rem .ar.quran'), hd = [...document.querySelectorAll('#remList .rem .ar')].find(e => !e.classList.contains('quran'));
      return { verse: un(getComputedStyle(q).fontFamily).split(',')[0], hadith: un(getComputedStyle(hd).fontFamily).split(',')[0],
        loaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => un(f.family)).sort().join(', ') }; });
    ok(fx.verse === 'Amiri Quran' && fx.hadith === 'Amiri' && /Amiri, Amiri Quran/.test(fx.loaded), `fonts: verses ${fx.verse}, hadith ${fx.hadith}; loaded ${fx.loaded}`);
    ok(fontHits.length >= 2 && fontHits.every(r => r.status === 200), 'font files: ' + fontHits.map(r => r.url.split('/').pop() + ' ' + r.status).join(', '));
    await shot('rem_1024');
    await page.click('#swRemind'); ok((await page.getAttribute('#swRemind', 'aria-checked')) === 'false', 'reminders off');
    await page.click('#remClose'); await page.waitForSelector('#remPanel', { state: 'hidden' });
    await page.click('#openRemind'); await page.waitForSelector('#remPanel.show');
    ok((await page.getAttribute('#swRemind', 'aria-checked')) === 'false', 'still off when opened again');
    await page.click('#swRemind'); await page.click('#remClose'); await page.waitForSelector('#remPanel', { state: 'hidden' });
    // backup has the new parts (Settings → Backup and erase)
    await visit('settings'); await page.click('#toData'); await page.waitForSelector('#dataPanel.show');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }).catch(() => null), page.click('#backupBtn')]);
    if (dl) { const p = path.join(OUT, `backup4_${engine}_${mode}.json`); await dl.saveAs(p); const d = JSON.parse(fs.readFileSync(p)); ok(d.version === 4 && d.history.length === h0 + 1 && d.shared.budget === 25 && Array.isArray(d.shared.mutes) && 'line' in d.shared, 'backup v4: history, shared settings with the line and muted sounds'); }
    else ok(false, 'backup download');
    await page.click('#dataDone'); await page.waitForSelector('#dataPanel', { state: 'hidden' });
    // layout: every page at a phone and a tablet, day and night
    for (const [w, hgt, theme] of [[390, 844, 'day'], [1024, 1366, 'night'], [390, 844, 'night']]) {
      await page.setViewportSize({ width: w, height: hgt });
      await page.evaluate(t => { localStorage.setItem('samt.theme', t); document.body.classList.toggle('theme-dark', t === 'night'); }, theme);
      for (const v of ['home', 'progress', 'settings']) {
        await visit(v); await sleep(300);
        await page.screenshot({ path: path.join(OUT, `f_${engine}_${mode}_${v}_${w}_${theme}.png`), fullPage: true });
        const over = await overflow(); const sm = await smallText();
        ok(over <= 0 && !sm.length, `${v} ${w}px ${theme}: overflow ${over}px, text floor 16 ${sm.join(', ') || 'ok'}`);
      }
    }
    await page.setViewportSize({ width: 390, height: 844 }); await toHome();
    await page.click('#openCards'); await page.waitForSelector('#cardsPanel.show'); await sleep(500); await shot('cards_390');
    await page.click('#cardGrid .cardb >> nth=4'); await page.waitForSelector('#showView.show'); await sleep(300); await shot('show_390'); await page.click('#showClose'); await page.click('#cardsClose');
    await visit('progress'); await page.click('#histList .row:not(.danger)'); await page.waitForSelector('#endPanel.show'); await sleep(500); await shot('end_390'); await page.click('#endDone');
  } catch (e) { ok(false, 'ERROR ' + (e.stack || e).toString().slice(0, 600)); }
  ok(!errs.length, 'page errors: ' + (errs.join(' | ') || 'none'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await browser.close(); srv.kill(); process.exit(fails ? 1 : 0);
})();
