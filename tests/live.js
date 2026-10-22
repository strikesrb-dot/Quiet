// Run from the repo root after a deploy: node tests/live.js. Makes one real Claude call through /api/summary.
// After the deploy: the live pages in WebKit — the same bytes as the repo's site/, the stage layout on a first open,
// the Amiri fonts served and used, the neural model loads, no errors — and one real Claude summary via /api/summary.
const pw = (() => { try { return require('playwright-core'); } catch (e) { return require('/opt/node-tools/node_modules/playwright-core'); } })(); const fs = require('fs'); const path = require('path');
const BASE = 'https://samt-quiet.netlify.app', SITE = require('path').resolve(__dirname, '..', 'site');
(async () => {
  const PX = process.env.HTTPS_PROXY;
  const browser = await pw.webkit.launch({ proxy: PX ? { server: PX } : undefined });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1024, height: 1366 } });
  for (const mode of ['light', 'neural']) {
    const page = await ctx.newPage(); const errs = [], fonts = [];
    page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('response', r => { if (/\/fonts\//.test(r.url())) fonts.push(`${r.url().split('/').pop()} ${r.status()} ${r.headers()['cache-control'] || ''}`); });
    const resp = await page.goto(`${BASE}/${mode}/`, { waitUntil: 'load' });
    const same = (await resp.text()) === fs.readFileSync(path.join(SITE, mode, 'index.html'), 'utf8');
    if (mode === 'neural') await page.waitForFunction(() => document.querySelector('#modelStatus').textContent.startsWith('Ready'), null, { timeout: 180000 }).catch(() => {});
    const home = await page.evaluate(() => ({
      setup: !document.querySelector('#setupCard').hidden, ready: !document.querySelector('#readyCard').hidden,
      quick: [...document.querySelectorAll('#openCards, #openSign, #openRemind')].filter(b => b.offsetParent).length,
      settingsRows: document.querySelectorAll('#vSettings .row').length, view: document.body.dataset.view, who: [...document.querySelectorAll('#whoSeg button')].map(b => b.textContent).join('|'),
      reminders: (window.SAMT_REMINDERS.verses || []).length + '+' + (window.SAMT_REMINDERS.hadith || []).length,
      model: (document.querySelector('#modelStatus') || {}).textContent }));
    await page.click('#openRemind'); await page.waitForSelector('#remPanel.show');
    const f = await page.evaluate(async () => { await document.fonts.ready; const un = s => s.replace(/"/g, '');
      const q = document.querySelector('#remList .rem .ar.quran'), h = [...document.querySelectorAll('#remList .rem .ar')].find(e => !e.classList.contains('quran'));
      return { verse: un(getComputedStyle(q).fontFamily).split(',')[0], hadith: un(getComputedStyle(h).fontFamily).split(',')[0],
        loaded: [...document.fonts].filter(x => x.status === 'loaded').map(x => un(x.family)).sort().join(', ') }; });
    console.log(mode, 'same bytes as site/:', same, JSON.stringify(home));
    console.log(mode, 'fonts:', JSON.stringify(f), '|', fonts.join(' ; '), '| errors:', errs.length ? errs.join(' | ') : 'none');
    await page.close();
  }
  const chooser = await (await ctx.request.get(`${BASE}/`)).text();
  console.log('chooser same bytes:', chooser === fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'));
  const page = await ctx.newPage();
  const body = { session: { kind: 'conversation', echoBy: 'sound level', minutes: 30, talkMin: 2.4, youPercent: 21, longestQuietMin: 11.5, echoes: 3, talkedOverSomeone: 0, nudges: 2, talkFreelyTaps: 1, mood: 'okay', note: 'Quiet at lunch, harder in the meeting.' },
    dailyBudgetMin: 20, last7Days: ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'].map((d, i) => ({ day: d, talkMin: [0, 0, 0, 0, 0, 0, 2.4][i], sessions: i === 6 ? 1 : 0 })), daysWithinBudget: 1 };
  await page.goto(`${BASE}/light/`);
  const t0 = Date.now();
  const res = await page.evaluate(async b => { const r = await fetch('/api/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, body: await r.text() }; }, body);
  console.log('POST /api/summary', res.status, `${Date.now() - t0} ms`); console.log(res.body);
  await browser.close();
})();
