# Samt

A quiet-time aid. While it runs, your own voice comes back to you in your headphones a fraction of a second late
(delayed auditory feedback), which makes talking very hard. It does this only for your voice, and it lets greetings,
salam and short answers through. The listening runs on the device; no audio is uploaded.

- **Samt Light** (`site/light/`): one self-contained page. Tells you apart from women, children and the TV well; less
  sure against other men.
- **Samt Neural** (`site/neural/`): adds an on-device voice-ID model (WeSpeaker ResNet34, 8-bit weights, 6.4 MB) run with
  ONNX Runtime Web 1.20.1 from jsDelivr. Much better against other men. Needs iPadOS 16.4 or newer.

Each version keeps its own setup in the browser (IndexedDB), with a backup file you can save and restore.

How it is laid out, by stage (Home shows only what fits where you are):

- **Before your voice is taught**, Home offers one thing: Set up Samt, five steps one at a time (see below). Sessions
  open after the first step. Cards, the sign and reminders work from the start.
- **Ready.** Home has the session length (tap the time), Silence or Conversation, Start, a test without echo, and
  today's talk time; then three quick tools (Card, Sign, Reminders) and two rows, Progress and Settings.
- **In a session** the screen shows only the session: time left, the "Quiet for" timer, the live pill, a reminder,
  Talk freely, Card, Sign, and Stop, which takes a 2-second hold so it can't end by accident (a test stops with a
  tap). Details (the numbers, a correction for the last verdict, echo volume) opens as a sheet. The browser's Back
  can't leave a running session.
- **Afterwards**, the end sheet: the numbers, a mood, a note, and Claude's summary if you ask for it.
- **Progress**: today against the daily talk budget, days within it, the last 7 days as a chart, past sessions.
  Light and Neural on one device share these.
- **Settings** is a short index (step-by-step setup, your voice, other voices, phrases that pass; conversation, echo,
  matching; appearance; backup and erase; about). Each row shows its value and opens on its own; nothing is deeper
  than that.

Silence echoes whenever you talk. Conversation lets you talk for a while each turn (5 to 60 seconds) before the echo;
talking over someone starts it at once; a soft two-note tone nudges you first. **Talk freely** gives you 10 seconds
without the echo (each tap adds 10).

## Setup, step by step

The first open starts it, and Settings opens it again (Step-by-step setup). One step at a time, each with its result:

1. **Your voice**: read a short passage, about 45 seconds. The one step that can't be skipped.
2. **Hear the echo**: about 10 seconds of the real echo, to hear it once and to check that Samt knows the voice.
3. **Other voices**: about 30 seconds of someone else talking while you stay quiet.
4. **Check it**: you talk for about 20 seconds, then someone else does; no echo plays. Samt counts the stretches of talk
   a second or longer: yours it caught (the echo would have come on), theirs it ignored (the echo never would have, not
   even for a moment). If it took them for you, one tap makes Matching stricter and checks again; if it missed you,
   one tap makes it looser. Teaching more, or changing Matching, marks the last result out of date. The check only
   measures: nothing from it is learned.
5. **Phrases that pass** (optional): the greetings, thanks and short answers, 3 times each.

Then a summary of the five. The steps' state is kept per version (localStorage `samt.<mode>.setup`); erasing the setup
starts it again.

## Claude summaries

`netlify/functions/summary.mts` serves `POST /api/summary`. It calls Claude with the Anthropic SDK through Netlify AI
Gateway, which injects the credentials, so no key is stored anywhere. The model is `claude-sonnet-5-5`; set the
`SAMT_MODEL` environment variable (Functions scope) to change it. It is rate-limited to 6 calls a minute per visitor.

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

- ONNX Runtime Web is pinned to 1.20.1: 1.21 and later run away in WebKit on iOS / iPadOS 26.2 and kill the tab
  (microsoft/onnxruntime#26827).
- The look follows the Quiet Glass design language from Repo-1 (`site/DESIGN-LANGUAGE.md`, `styles/ql/tokens.css`,
  `styles/ds-ui.css`); the tokens are copied into `src/template.html`.
