# Samt browser tests

Real-engine checks of the built pages in `site/`, with the fake microphone (`?fakemic=1&speed=N`) fed the synthetic
recordings in `audio/` (TTS voices: "me", "others", the twelve phrases, and a 5-minute mixed test stream with its
timeline in `test.json`). Run them from the repo root after `python3 scripts/build.py`, and ship only when they pass
in WebKit (Safari's engine), which is what iPhone and iPad run.

```bash
node tests/setup-flow.js webkit light    # setup step by step (with the check), test session, real session, end sheet, backup/restore/erase, 5 widths
node tests/features.js webkit light      # needs the backup the line above saved in tests/out/
node tests/sound-level.js webkit light   # Sound level: the line, near and far voices, switching, a muted hum (same backup)
node tests/setup-flow.js webkit neural   # then features.js webkit neural; also chromium light for both
node tests/live.js                       # after a deploy: live bytes = site/, fonts, model, one real Claude summary
```

- `setup-flow.js` prints what it saw (it has no pass/fail count): look for `page errors: none`, `overflow 0px` at
  390 · 744 · 834 · 1024 · 1440, and sensible test-pass numbers with Your voice (v7, WebKit: Light talk echoed 86%,
  others ignored 80%; Neural 100% / 100%; with no phrase list, your short phrases mostly echo now: 13% and 50% let
  through). The setup's check uses voices from the test stream that never taught Samt (your talk, then two men's):
  Light caught you 7 of 7 but ignored the men only 1 of 6, even stricter; Neural 7 of 7 and 6 of 6. The `stretches`
  line shows each one (E echo to the end, e echo then off, - none).
- `features.js` and `sound-level.js` end `ALL PASS` or `N FAILED`. `sound-level.js` also prints how the line split the
  stream (line −24 dB): with the other voices 15 dB quieter, 100% of your talk echoed and 100% of theirs ignored; with
  them as loud as yours, only 40% of theirs ignored (the hard male voice never). Its sounds are made in the page:
  the stream with the others at a gain, a 150 · 300 · 450 Hz hum, white noise, a 2 ms click.
- Screenshots and backup files go to `tests/out/` (ignored by git).

Needs Playwright with WebKit. The scripts load `playwright-core` (or `/opt/node-tools/node_modules/playwright-core`);
if `ls /opt/pw-browsers` shows no `webkit-*`, install it:
`node /opt/node-tools/node_modules/playwright-core/cli.js install --with-deps webkit`. Chromium runs use
`/opt/pw-browsers/chromium-1194`. This WebKit build crashes on a reload after a history step back, so
`setup-flow.js` reopens Samt in a new tab instead of reloading.
