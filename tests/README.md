# Samt browser tests

Real-engine checks of the built pages in `site/`, with the fake microphone (`?fakemic=1&speed=N`) fed the synthetic
recordings in `audio/` (TTS voices: "me", "others", the twelve phrases, and a 5-minute mixed test stream with its
timeline in `test.json`). Run them from the repo root after `python3 scripts/build.py`, and ship only when they pass
in WebKit (Safari's engine), which is what iPhone and iPad run.

```bash
node tests/setup-flow.js webkit light    # setup, test session, real session, end sheet, backup/restore/erase, 5 widths
node tests/features.js webkit light      # needs the backup the line above saved in tests/out/
node tests/setup-flow.js webkit neural   # then features.js webkit neural; also chromium light for both
node tests/live.js                       # after a deploy: live bytes = site/, fonts, model, one real Claude summary
```

- `setup-flow.js` prints what it saw (it has no pass/fail count): look for `page errors: none`, `overflow 0px` at
  390 · 744 · 834 · 1024 · 1440, and sensible test-pass numbers (Light about: talk echoed 86%, phrases passed 88%,
  others ignored 78%; Neural: 100% / 96% / 96%).
- `features.js` ends `ALL PASS` or `N FAILED`.
- Screenshots and backup files go to `tests/out/` (ignored by git).

Needs Playwright with WebKit. The scripts load `playwright-core` (or `/opt/node-tools/node_modules/playwright-core`);
if `ls /opt/pw-browsers` shows no `webkit-*`, install it:
`node /opt/node-tools/node_modules/playwright-core/cli.js install --with-deps webkit`. Chromium runs use
`/opt/pw-browsers/chromium-1194`. This WebKit build crashes on a reload after a history step back, so
`setup-flow.js` reopens Samt in a new tab instead of reloading.
