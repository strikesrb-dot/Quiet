// Run from the repo root after tests/setup-flow.js has run for the same engine and version (it restores that run's
// backup from tests/out/): node tests/sound-level.js [webkit|chromium] [light|neural]. Ends ALL PASS or N FAILED.
// Sound level in a real engine with the fake mic: the pickers on Home and in a session, the line and its − / +, near
// and far voices from the 5-minute test stream (the others at full loudness, and 15 dB quieter as if farther away),
// switching mid-session, Talk freely, Conversation's turn time, muting a machine's hum (and a roar that can't be), the
// check placing the line, the session's record and Claude's request, layout at 390 and 1024.
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require('/opt/node-tools/node_modules/playwright-core'); } })(); const { spawn } = require('child_process'); const fs = require('fs'), path = require('path');
const [engine = 'webkit', mode = 'light', speed = '25'] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..'), OUT = path.join(__dirname, 'out'), sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
const PORT = 8970 + Math.floor(Math.random() * 20);
let fails = 0; const ok = (c, s) => { console.log(`[${engine} ${mode}] ${c ? 'PASS' : 'FAIL'} ${s}`); if (!c) fails++; };
(async () => {
  const srv = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' }); await sleep(800);
  const PX = process.env.HTTPS_PROXY;
  const browser = engine === 'webkit'
    ? await pw.webkit.launch({ proxy: PX ? { server: PX, bypass: '127.0.0.1,localhost' } : undefined })
    : await pw.chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: PX ? [`--proxy-server=${PX}`, '--proxy-bypass-list=127.0.0.1;localhost'] : [] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 1366 } });
  const page = await ctx.newPage(); const errs = []; let sent = null;
  page.on('pageerror', e => errs.push('pageerror: ' + e.message)); page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.route('**/api/summary', async route => { sent = JSON.parse(route.request().postData() || '{}'); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ summary: 'You kept quiet well.' }) }); });
  const out = s => console.log(`[${engine} ${mode}] ${s}`);
  const shot = n => page.screenshot({ path: path.join(OUT, `s_${engine}_${mode}_${n}.png`), fullPage: false });
  const view = () => page.evaluate(() => SamtDebug.view());
  const hold = async sel => { const b = await page.locator(sel).boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(2200); await page.mouse.up(); };
  const smallText = () => page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.offsetParent && e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && parseFloat(getComputedStyle(e).fontSize) < 16).map(e => e.tagName + '.' + e.className + ':' + getComputedStyle(e).fontSize).slice(0, 8));
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const content = () => page.evaluate(() => Math.round(document.querySelector('.win').getBoundingClientRect().bottom + 32));
  const line = () => page.evaluate(() => SamtDebug.line());
  const kind = () => page.evaluate(() => (SamtDebug.ctrl && SamtDebug.ctrl.kind) || 'voice');
  const echoStates = () => page.evaluate(() => SamtDebug.events.filter(e => e.type === 'state' && e.state === 'echo').length);
  const setSpeed = v => page.evaluate(v => { SamtDebug.engine.speed = v; }, v);
  try {
    await page.goto(`http://127.0.0.1:${PORT}/site/${mode}/?fakemic=1&speed=${speed}`);
    if (mode === 'neural') await page.waitForFunction(() => document.querySelector('#modelStatus').textContent.startsWith('Ready'), null, { timeout: 180000 });
    await page.waitForFunction(() => window.SamtDebug && SamtDebug.feed, null, { timeout: 20000 });
    await page.setInputFiles('#restoreFile', path.join(OUT, `backup_${engine}_${mode}.json`));
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('restored'), null, { timeout: 30000 });
    // sounds for the test, made in the page: the stream with the other voices at a gain; a hum; a roar; your talk
    await page.evaluate(() => {
      const sr = 16000; let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
      window.__T = {
        async load() { if (this.x) return; this.tl = await (await fetch('/tests/audio/test.json')).json(); this.x = new Float32Array(await (await fetch('/tests/audio/test.f32')).arrayBuffer()); },
        stream(gain) { const y = Float32Array.from(this.x); for (const c of this.tl) if (c.role !== 'me') for (let i = Math.round(c.start * sr); i < Math.round(c.end * sr); i++) y[i] *= gain; return y; },
        // talk clips of these voices, 0.9 s apart, looping over them until there's maxSec of talk
        clips(roles, maxSec, gain) { const list = this.tl.filter(c => roles.includes(c.role) && c.kind === 'test_talk'), parts = [], gap = new Float32Array(14400); let sec = 0;
          for (let i = 0; sec < maxSec && list.length && i < 500; i++) { const c = list[i % list.length]; parts.push(this.x.slice(Math.round(c.start * sr), Math.round(c.end * sr)).map(v => v * gain), gap); sec += c.end - c.start; }
          return this.cat(parts); },
        cat(parts) { const y = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { y.set(p, o); o += p.length; } return y; },
        hum(sec) { return Float32Array.from({ length: sec * sr }, (_, i) => { const t = i / sr; return 0.05 * Math.sin(2 * Math.PI * 150 * t) + 0.03 * Math.sin(2 * Math.PI * 300 * t) + 0.02 * Math.sin(2 * Math.PI * 450 * t) + 0.003 * rnd(); }); },
        roar(sec) { return Float32Array.from({ length: sec * sr }, () => 0.09 * rnd()); },
        mix(a, b) { const y = Float32Array.from(a); for (let i = 0; i < Math.min(a.length, b.length); i++) y[i] += b[i]; return y; },
        play(name, y) { return SamtDebug.engine.play(name, y); },
        // which clips of the stream the echo opened in (from the echo state's on and off times)
        // t0: the Listener's clock when the stream began (a session's second stream starts later on it)
        score(t0) { const ev = SamtDebug.events, opens = []; let at = null;
          for (const e of ev) if (e.type === 'state') { const t = e.t - t0; if (e.state === 'echo' && at == null) at = t; else if (e.state !== 'echo' && at != null) { opens.push([at, t]); at = null; } }
          if (at != null) opens.push([at, 1e9]);
          const hit = c => opens.some(([a, b]) => a <= c.end + 0.1 && b >= c.start);
          const pct = (a, f) => a.length ? Math.round(100 * a.filter(f).length / a.length) : null;
          const me = this.tl.filter(c => c.role === 'me' && c.kind !== 'test_phrase'), oth = this.tl.filter(c => c.role !== 'me'), roles = {};
          for (const c of oth) (roles[c.role] = roles[c.role] || []).push(c);
          return { you: pct(me, hit), others: pct(oth, c => !hit(c)), roles: Object.fromEntries(Object.entries(roles).map(([r, a]) => [r, pct(a, c => !hit(c))])) }; }
      };
      return window.__T.load();
    });
    // 1. Home: the picker
    const who = await page.$$eval('#whoSeg button', bs => bs.map(b => b.textContent));
    ok(who.join('|') === 'Your voice|Sound level', 'Home picker: ' + who.join(' | '));
    await page.click('#whoSeg button:nth-of-type(2)'); await sleep(200);
    ok((await page.evaluate(() => SamtDebug.wiz().who)) === 'level' && await page.isEnabled('#go'), 'Sound level picked; Start enabled');
    // 2. a test session: near and far voices, the line, − / +
    await page.evaluate(() => SamtDebug.setLine(-24));
    await page.click('#test'); await page.waitForSelector('#vSession:not([hidden])'); await sleep(300);
    ok((await kind()) === 'level' && await page.isVisible('#lineDown') && await page.isVisible('#lineUp') && await page.isVisible('#lineMark'), 'test session runs on the line, with − / + and the line mark');
    ok((await page.$eval('#sWhoSeg button[aria-checked="true"]', b => b.textContent)) === 'Sound level', 'session picker shows Sound level');
    for (const [label, gain] of [['others 15 dB quieter (farther)', 0.178], ['others as loud as you', 1]]) {
      const t0 = await page.evaluate(() => { SamtDebug.events.length = 0; return SamtDebug.listener.fs.nFrames / 100; });
      await page.evaluate(g => __T.play('stream', __T.stream(g)), gain); await sleep(800);
      const s = await page.evaluate(t0 => __T.score(t0), t0);
      out(`line -24, ${label}: you echoed ${s.you}% | others ignored ${s.others}% ${JSON.stringify(s.roles)}`);
      if (gain < 1) ok(s.you >= 95 && s.others >= 90, `near and far voices split by the line: you ${s.you}%, others ignored ${s.others}%`);
    }
    const l0 = await line(), m0 = await page.$eval('#lineMark', e => parseFloat(e.style.left));
    await page.click('#lineUp'); const l1 = await line(), m1 = await page.$eval('#lineMark', e => parseFloat(e.style.left));
    ok(l1 === l0 + 2 && m1 > m0 && (await page.evaluate(() => SamtDebug.ctrl.p.line)) === l1, `+ raises the line ${l0} → ${l1} (mark ${m0}% → ${m1}%), live in the session`);
    await page.click('#lineDown'); ok((await line()) === l0, '− lowers it back: ' + await line());
    await page.evaluate(() => { SamtDebug.events.length = 0; });
    await page.evaluate(() => { const x = new Float32Array(16000); for (let i = 8000; i < 8032; i++) x[i] = 0.3; return __T.play('click', x); }); await sleep(300);
    ok((await echoStates()) === 0, 'a click (2 ms, loud) does not turn the echo on');
    // 3. switching mid-session keeps the numbers
    await page.evaluate(() => __T.play('me', __T.clips(['me'], 8, 1))); await sleep(400);
    const t1 = await page.evaluate(() => SamtDebug.ctrl.counts.talkTime);
    await page.click('#sWhoSeg button:nth-of-type(1)'); await sleep(300);
    const k2 = await kind(), t2 = await page.evaluate(() => SamtDebug.ctrl.counts.talkTime);
    ok(k2 !== 'level' && t2 >= t1 && t1 > 0 && await page.isHidden('#lineDown'), `switched to Your voice mid-session (${k2}); talk time kept ${t1.toFixed(1)} → ${t2.toFixed(1)} s; − / + hidden`);
    await page.click('#sWhoSeg button:nth-of-type(2)'); await sleep(300);
    ok((await kind()) === 'level' && (await page.evaluate(() => SamtDebug.wiz().who)) === 'level', 'and back to Sound level');
    // 4. muting a machine's hum, from Details; a roar can't be muted
    await page.evaluate(() => SamtDebug.setLine(-34));
    await page.evaluate(() => { SamtDebug.events.length = 0; }); await page.evaluate(() => __T.play('hum', __T.hum(3))); await sleep(500);
    ok((await echoStates()) > 0, 'a loud hum goes over the line before it is muted');
    await page.click('#detailsBtn'); await page.waitForSelector('#detailsPanel.show'); await sleep(300);
    out(`Details: corrections hidden ${await page.isHidden('#last')}, short replies hidden ${await page.isHidden('#shortRow')}, muted sounds ${await page.textContent('#muteStatus2')}`);
    await page.click('#dMute'); await page.waitForSelector('#mutePanel.show'); await sleep(300);
    await setSpeed(4); const humP = page.evaluate(() => __T.play('hum', __T.hum(5)));
    await page.click('#muteGo');
    await page.waitForFunction(() => { const t = document.querySelector('#muteResult').textContent; return t && !/Listening/.test(t); }, null, { timeout: 30000 });
    const mres = await page.textContent('#muteResult'), mutes = await page.evaluate(() => SamtDebug.mutes());
    ok(mutes.length === 1 && /^Muted/.test(mres), `hum muted: "${mres}" ${JSON.stringify(mutes[0] && mutes[0].tones)}`);
    out('muted list: ' + (await page.$$eval('#muteList .row', rs => rs.map(r => r.textContent).join(' | '))));
    await shot('mute_1024');
    await humP; await setSpeed(+speed);
    await page.evaluate(() => { SamtDebug.events.length = 0; }); await page.evaluate(() => __T.play('hum', __T.hum(3))); await sleep(500);
    ok((await echoStates()) === 0, 'after muting, the same hum stays under the line');
    await page.evaluate(() => { SamtDebug.events.length = 0; }); await page.evaluate(() => { const me = __T.clips(['me'], 6, 1); return __T.play('me+hum', __T.mix(me, __T.hum(Math.ceil(me.length / 16000)))); }); await sleep(500);
    ok((await echoStates()) > 0, 'your voice over the muted hum still turns the echo on');
    await setSpeed(4); const roarP = page.evaluate(() => __T.play('roar', __T.roar(5)));
    await page.click('#muteGo');
    await page.waitForFunction(() => { const t = document.querySelector('#muteResult').textContent; return t && !/Listening/.test(t); }, null, { timeout: 30000 });
    ok((await page.evaluate(() => SamtDebug.mutes().length)) === 1 && /every pitch/.test(await page.textContent('#muteResult')), 'a roar is not muted: ' + await page.textContent('#muteResult'));
    await roarP; await setSpeed(+speed);
    await page.click('#muteClose'); await page.waitForSelector('#mutePanel', { state: 'hidden' });
    await page.click('#detailsClose'); await page.waitForSelector('#detailsPanel', { state: 'hidden' });
    await page.click('#stop'); await page.waitForSelector('#vHome:not([hidden])'); await sleep(300);
    // 5. a real session in Silence: Talk freely, hold to stop, the record, Claude's request
    await page.evaluate(() => SamtDebug.setLine(-24));
    const log0 = await page.evaluate(() => SamtDebug.engine.echoLog.length);
    await page.click('#go'); await page.waitForSelector('#vSession:not([hidden])'); await sleep(300);
    await page.evaluate(() => { SamtDebug.events.length = 0; });
    await page.evaluate(() => __T.play('stream', __T.stream(0.178).subarray(0, 16000 * 60))); await sleep(800);
    const opens = await page.evaluate(n => SamtDebug.engine.echoLog.slice(n).filter(x => x[1] === true).length, log0);
    ok(opens > 0, `real session: the echo opened ${opens} times in the first minute of the stream`);
    await page.click('#pass'); await sleep(150);
    ok((await page.evaluate(() => SamtDebug.ctrl.passLeft())) > 8 && /Talking freely/.test(await page.textContent('#liveText')), 'Talk freely: ' + await page.textContent('#liveText'));
    // the session screen on a phone, with a reminder
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(400); await shot('session_390');
    ok((await overflow()) <= 0 && (await content()) <= 844, `session 390px: overflow ${await overflow()}px, content ${await content()}px of 844`);
    let small = await smallText(); ok(!small.length, 'session 390px text floor 16: ' + (small.join(', ') || 'ok'));
    await page.setViewportSize({ width: 1024, height: 1366 }); await sleep(300);
    await hold('#stop'); await page.waitForSelector('#endPanel.show', { timeout: 8000 });
    const rows = await page.$$eval('#endStats .row', rs => rs.map(r => r.textContent));
    ok(rows.some(r => /Echo by\s*Sound level/.test(r)), 'end sheet: ' + rows.join(' | '));
    await page.click('#askClaude'); await page.waitForSelector('#endSummary:not([hidden])', { timeout: 10000 });
    ok(sent && sent.session && sent.session.echoBy === 'sound level' && sent.session.talkMin > 0, 'Claude request: echoBy ' + (sent && sent.session.echoBy) + ', talkMin ' + (sent && sent.session.talkMin));
    await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' });
    const h = await page.evaluate(() => SamtDebug.history().slice().sort((a, b) => b.at - a.at)[0]);
    ok(h && h.who === 'level' && h.talkTime > 0, `record: who ${h && h.who}, talk ${h && h.talkTime} s`);
    await page.click('#toProgress'); await sleep(300);
    ok(/Sound level/.test(await page.textContent('#histList .row')), 'Past sessions marks it: ' + await page.textContent('#histList .r2'));
    await page.click('#vProgress [data-back]'); await sleep(300);
    // 6. Conversation on the line: the turn's talk time, a nudge, then the echo
    await page.click('#kindSeg button:nth-of-type(2)'); await page.click('#convLine'); await page.waitForSelector('#convPanel.show');
    while ((await page.textContent('#limitOut')) !== '5 s') await page.click('#limitDown');
    await page.click('#convDone'); await page.waitForSelector('#convPanel', { state: 'hidden' });
    await page.click('#go'); await page.waitForSelector('#vSession:not([hidden])'); await sleep(300);
    await page.evaluate(() => { SamtDebug.events.length = 0; });
    await page.evaluate(() => SamtDebug.feed('enroll_me', '/tests/audio/enroll_me.f32')); await sleep(500);
    const ev = await page.evaluate(() => { const e = SamtDebug.events; const n = e.find(x => x.type === 'nudge'), o = e.find(x => x.type === 'state' && x.state === 'echo'); return { nudge: n ? n.t : null, echo: o ? o.t : null }; });
    ok(ev.nudge != null && ev.echo != null && ev.echo > ev.nudge && ev.echo >= 4.5, `Conversation, 5 s turns: nudge at ${ev.nudge}s, echo at ${ev.echo}s`);
    await setSpeed(+speed); await hold('#stop'); await page.waitForSelector('#endPanel.show', { timeout: 8000 }); await page.click('#endDone'); await page.waitForSelector('#endPanel', { state: 'hidden' });
    await page.click('#kindSeg button:nth-of-type(1)');
    // 7. the check on the line (Settings → Step-by-step setup → Check it), near voices then voices as loud as yours
    await page.click('#toSettings'); await sleep(200); await page.click('#toWizard'); await sleep(300);
    for (let i = 0; i < 8; i++) { // to the Check it step: from the summary, or through the steps (Skip, or Next on a done one)
      if (await page.isVisible('#wzSum')) { await page.click('#wzSumList .row:nth-child(4)'); await sleep(200); continue; }
      if ((await page.textContent('#wzStepTitle')) === 'Check it') break;
      await page.click(await page.isVisible('#wzNext') ? '#wzNext' : '#wzMain'); await sleep(200);
    }
    ok((await page.textContent('#wzStepTitle')) === 'Check it' && /Sound level/.test(await page.textContent('#wzBody')), 'check step says it checks Sound level');
    const startBtn = async () => { for (const id of ['#wzMain', '#wzAlt']) if (await page.isVisible(id) && /Check again|Start the check/.test(await page.textContent(id))) return id; return '#wzMain'; };
    const runCheck = async gain => {
      await page.click(await startBtn()); await page.waitForSelector('#recPanel:not([hidden])'); await sleep(300);
      // each round gets more than 20 s of talk, so it ends by itself (no race with tapping Done)
      await page.evaluate(() => __T.play('me', __T.clips(['me'], 23, 1)));
      await page.waitForFunction(() => document.querySelector('#recDone').textContent === 'Start', null, { timeout: 60000 });
      out(`  between the rounds: ${await page.textContent('#recHint')}`);
      await page.click('#recDone'); await sleep(300);
      await page.evaluate(g => __T.play('others', __T.clips(['man_typ', 'man_hard', 'woman_a', 'man_far'], 23, g)), gain);
      await page.waitForSelector('#recPanel', { state: 'hidden', timeout: 60000 }); await sleep(300);
      return { you: await page.textContent('#wzYou'), oth: await page.textContent('#wzOth'), status: await page.textContent('#wzStatus'), main: await page.textContent('#wzMain'), lv: await page.evaluate(() => SamtDebug.wiz().check.lv) };
    };
    let r = await runCheck(0.178);
    out(`check, far voices: caught you ${r.you} | ignored others ${r.oth} | "${r.status}" | main "${r.main}" | levels ${JSON.stringify(r.lv)}`);
    ok(/over the line and theirs stays under/.test(r.status) || /between you/.test(r.main), 'the check passes, or offers the line between you');
    r = await runCheck(1);
    out(`check, voices as loud as yours: caught you ${r.you} | ignored others ${r.oth} | "${r.status}" | main "${r.main}" | levels ${JSON.stringify(r.lv)}`);
    if (/between you/.test(r.main)) { const before = await line(); await page.click('#wzMain'); await page.waitForSelector('#recPanel:not([hidden])'); out(`"Put the line between you" moved the line ${before} → ${await line()} and started the check again`); await page.click('#recCancel'); await page.waitForSelector('#recPanel', { state: 'hidden' }); }
    await shot('check_1024');
    await page.click('#vWizard [data-back]'); await sleep(250); await page.click('#vSettings [data-back]'); await sleep(250);
    // 8. layout: Home and Settings at a phone and a tablet; the mute sheet at a phone
    for (const [w, hgt] of [[390, 844], [1024, 1366]]) {
      await page.setViewportSize({ width: w, height: hgt }); await sleep(300);
      ok((await overflow()) <= 0 && (await content()) <= hgt && !(await smallText()).length, `Home ${w}px: overflow ${await overflow()}px, content ${await content()}px`);
      await page.click('#toSettings'); await sleep(300);
      ok((await overflow()) <= 0 && !(await smallText()).length, `Settings ${w}px: overflow ${await overflow()}px, content ${await content()}px`);
      await page.click('#toMute'); await page.waitForSelector('#mutePanel.show'); await sleep(400); if (w === 390) await shot('mute_390');
      small = await smallText(); ok(!small.length, `mute sheet ${w}px text floor 16: ` + (small.join(', ') || 'ok'));
      if (w === 1024) { await page.click('#muteList .row'); await page.waitForSelector('#actSheet.show'); await page.click('#actRows .row.danger'); await sleep(450); ok((await page.evaluate(() => SamtDebug.mutes().length)) === 0, 'unmuted from the list'); }
      await page.click('#muteClose'); await page.waitForSelector('#mutePanel', { state: 'hidden' }); await page.click('#vSettings [data-back]'); await sleep(250);
    }
  } catch (e) { ok(false, 'ERROR ' + (e.stack || e).toString().slice(0, 700)); }
  ok(!errs.length, 'page errors: ' + (errs.join(' | ') || 'none'));
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  await browser.close(); srv.kill(); process.exit(fails ? 1 : 0);
})();
