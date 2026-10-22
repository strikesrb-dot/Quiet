# Samt

A quiet-time aid. While it runs, your own voice comes back to you in your headphones a fraction of a second late
(delayed auditory feedback), which makes talking very hard. What turns the echo on is your choice: **Your voice** (Samt
recognises your voice and echoes only that) or **Sound level** (any sound over a loudness line you set; with the mic
near your mouth, your voice crosses the line and people farther away don't). The listening runs on the device; no
audio is uploaded.

- **Samt Light** (`site/light/`): one self-contained page. Tells you apart from women, children and the TV well; less
  sure against other men.
- **Samt Neural** (`site/neural/`): adds an on-device voice-ID model (WeSpeaker ResNet34, 8-bit weights, 6.4 MB) run with
  ONNX Runtime Web 1.20.1 from jsDelivr. Much better against other men. Needs iPadOS 16.4 or newer.

Each version keeps its own setup in the browser (IndexedDB), with a backup file you can save and restore.

How it is laid out, by stage (Home shows only what fits where you are):

- **Before your voice is taught**, Home offers one thing: Set up Samt, four steps one at a time (see below). Sessions
  open after the first step. Cards, the sign and reminders work from the start.
- **Ready.** Home has the session length (tap the time), Silence or Conversation, Your voice or Sound level, Start, a
  test without echo, and today's talk time; then three quick tools (Card, Sign, Reminders) and two rows, Progress and
  Settings.
- **In a session** the screen shows only the session: Your voice or Sound level (one tap switches, and the session
  keeps its numbers), time left, the "Quiet for" timer, the live pill (with Sound level, − and + beside it move the line
  on the level bar), a reminder, Talk freely, Card, Sign, and the main button: a 2-second hold pauses the session for
  up to 60 seconds (the echo stops, the mic's sound is set aside and the clock stands still; the pill counts down "Echo
  back in 0:45", then the echo is back by itself); Resume ends the pause early and End session finishes the session; a
  test stops with a tap. A call or Siri pauses it too, until you tap Resume. Details (the numbers, a correction for the last verdict with Your voice, echo
  volume, muted sounds) opens as a sheet. The browser's Back can't leave a running session.
- **Afterwards**, the end sheet: the numbers, a mood, a note, and Claude's summary if you ask for it.
- **Progress**: today against the daily talk budget, days within it, the last 7 days as a chart, past sessions.
  Light and Neural on one device share these.
- **Settings** is a short index (step-by-step setup, your voice, other voices; conversation, echo, matching, muted
  sounds; appearance; backup and erase; about). Each row shows its value and opens on its own; nothing is deeper than
  that.

Silence echoes whenever you talk. Conversation lets you talk for a while each turn (5 to 60 seconds) before the echo;
talking over someone starts it at once (Your voice only); a soft two-note tone nudges you first. **Talk freely** gives
you 20 seconds without the echo (each tap adds 20, up to 60; the pill counts down "Echo back in 0:14"); any 3 taps
within 10 minutes turn it off for an hour, on this device in Light and Neural alike (`samt.shared`: `freeTaps`,
`freeLock`), so ending a session doesn't reset it. Phrases that pass (v1 to v6) are gone: with Your voice, replies
under half a second still never echo.

## Sound level

`LevelGate` in `src/pipeline.js`. No voice check: any sound over the line opens the echo at once and holds it through
short dips (the hold is the echo's delay plus 150 ms, so a word's end is never cut); anything under it is ignored. It
measures the raw 16 kHz audio itself in 10 ms frames, over the last 30 ms, and opens after two frames over the line, so
a click doesn't. The line is in dB (−66 to −16, 2 dB a tap), shared by Light and Neural (`samt.shared`); until it's
set, it starts between your setup reading and the other voices from the setup, or 10 dB under your reading. All time
over the line counts as your talk time, and the session is marked Sound level. Samt learns nothing from it (it can't
be sure the voice was yours). Conversation's turn time works; "talking over someone" doesn't. The setup's Check it
step checks whichever is picked; with Sound level it can put the line halfway between your typical level and the
others' loudest, when they're 4 dB or more apart.

It works when your voice reaches the mic louder than other people's: earbuds whose mic sits near your mouth. In the
tests (the 5-minute stream, line −24 dB), with the other voices 15 dB quieter than yours it caught all of your talk and
ignored all of theirs; with them as loud as yours, no line split them.

**Muted sounds** (Settings, or Details in a session): Samt listens for 3 seconds while a sound plays, finds its steady
pitches (peaks at least 10 dB over their surroundings, 50 Hz to 7 kHz, up to 6) and cuts each with a notch filter, both
in the echo (Web Audio `BiquadFilterNode`, between the delay and the gate) and in what the line measures (the same
filters in JavaScript). Up to 4 sounds. A sound spread over every pitch (wind, a roar) has no such peaks, so nothing is
muted and it says to raise the line instead.

## Setup, step by step

The first open starts it, and Settings opens it again (Step-by-step setup). One step at a time, each with its result:

1. **Your voice**: read a short passage, about 45 seconds. The one step that can't be skipped.
2. **Hear the echo**: about 10 seconds of the real echo, to hear it once and to check that Samt knows the voice.
3. **Other voices**: about 30 seconds of someone else talking while you stay quiet.
4. **Check it**: you talk for about 20 seconds, then someone else does; no echo plays. Samt counts the stretches of talk
   a second or longer: yours it caught (the echo would have come on), theirs it ignored (the echo never would have, not
   even for a moment). With Your voice: if it took them for you, one tap makes Matching stricter and checks again; if
   it missed you, one tap makes it looser. With Sound level: one tap puts the line between you, or raises or lowers it.
   Teaching more, or changing Matching, the line or the muted sounds, marks the last result out of date. The check only
   measures: nothing from it is learned.

Then a summary of the four. The steps' state is kept per version (localStorage `samt.<mode>.setup`); erasing the setup
starts it again.

## Claude summaries

`netlify/functions/summary.mts` serves `POST /api/summary`. It calls Claude with the Anthropic SDK through Netlify AI
Gateway, which injects the credentials, so no key is stored anywhere. The model is `claude-sonnet-5-5`; set the
`SAMT_MODEL` environment variable (Functions scope) to change it. It is rate-limited to 6 calls a minute per visitor.
Each request says what turned the echo on (`echoBy`: `voice` or `sound level`), so the note doesn't claim Sound level's
talk time was all yours.

## Reminders

`src/reminders.json` holds the verses and hadith. Qur'an text: Tanzil Project, Uthmani text v1.1 (tanzil.net),
NFC-normalised, CC BY 3.0 (verbatim copies only, credit Tanzil and link to tanzil.net), byte for byte the copy Hifz Hub
pins (`site/mithlayn-assets/mushaf-data/quran_tanzil_uthmani.json` in Repo-1, tatweel off). English: Pickthall (1930),
as Tanzil hosts it (non-commercial use). Hadith: wording, numbers and grades from sunnah.com, cross-checked letter for
letter against an independent sunnah.com dataset; an-Nawawi's Forty no. 12 is given with an-Nawawi's own grading
(hasan), while sunnah.com grades at-Tirmidhi's narration of it (2317) da'if. The "In plain words" meanings are short
renderings, not a published translation. Never edit the Arabic by hand.

## Fonts

Arabic is set in Amiri: Amiri Quran for the verses, Amiri for all other Arabic (the hadith, a sūrah's name, ﷺ, an
Arabic card). Both are from the Amiri project (github.com/aliftype/amiri) under the SIL Open Font License 1.1, taken
from Fontsource 5.3.0 (the Arabic subset, regular weight) and kept in `src/fonts/` with the licence (`OFL.txt`); the
build copies them to `site/fonts/`, which both pages share. English stays in the device's own font.

## Deploy

Netlify publishes `site/` as it is (see `netlify.toml`) and bundles the one function; the pages have no build step.
The Netlify project (samt-quiet) is not linked to this repository's Git builds, so a push alone does not deploy: each
release is uploaded with Netlify's deploy tool from a clean checkout. To make every push to `main` deploy, link the
repository in Netlify (Project configuration, Build & deploy, Link repository).

## Change it

The pages are built from `src/`: `template.html` (markup and Quiet Glass styles), `chooser.html` (the start page) and
the modules `dsp.js`, `models.js`, `pipeline.js`, `voice-light.js`, `voice-neural.js`, `mic.js`, `ui.js`, the
reminders in `reminders.json` and the fonts in `fonts/`. After an edit:

```bash
python3 scripts/build.py   # rewrites site/index.html, site/light/, site/neural/, site/fonts/ (leaves the model alone)
```

Then run the browser tests (`tests/README.md`): they drive the built pages in WebKit (Safari's engine) with a fake
microphone and check every page at phone and iPad widths. Ship only when they pass.

## Notes

- Taps never zoom the page or select text: every element is `touch-action: manipulation` (pinch zoom still works;
  the hold-to-pause button is `none`), and text can't be selected except in typing fields.
- ONNX Runtime Web is pinned to 1.20.1: 1.21 and later run away in WebKit on iOS / iPadOS 26.2 and kill the tab
  (microsoft/onnxruntime#26827).
- The look follows the Quiet Glass design language from Repo-1 (`site/DESIGN-LANGUAGE.md`, `styles/ql/tokens.css`,
  `styles/ds-ui.css`); the tokens are copied into `src/template.html`.
