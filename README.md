# Samt

A quiet-time aid. While it runs, your own voice comes back to you in your headphones a fraction of a second late
(delayed auditory feedback), which makes talking very hard. It does this only for your voice, and it lets greetings,
salam and short answers through. The listening runs on the device; no audio is uploaded.

- **Samt Light** (`site/light/`): one self-contained page. Tells you apart from women, children and the TV well; less
  sure against other men.
- **Samt Neural** (`site/neural/`): adds an on-device voice-ID model (WeSpeaker ResNet34, 8-bit weights, 6.4 MB) run with
  ONNX Runtime Web 1.20.1 from jsDelivr. Much better against other men. Needs iPadOS 16.4 or newer.

Each version keeps its own setup in the browser (IndexedDB), with a backup file you can save and restore.

What else is on the page:

- **Silence or Conversation.** Silence echoes whenever you talk. Conversation lets you talk for a while each turn
  (5 to 60 seconds) before the echo; talking over someone starts it at once; a soft two-note tone nudges you first.
  **Talk freely** gives you 10 seconds without the echo (each tap adds 10).
- **Progress.** A live "Quiet for" timer, the share of the talking that was you, a daily talk budget, days in a row
  within it, the last 7 days as a chart, and past sessions with a mood and a note. Light and Neural share these.
- **Claude's summary** (optional, per session): the end-of-session sheet can ask Claude for a short note. Only the
  session's numbers, the mood and your note are sent; audio never leaves the device.
- **Without your voice.** Cards to show (or have the iPad read out), an in-silence sign, and reminders about speech
  from the Qur'an and the Sunnah, one of which can open each session.

## Claude summaries

`netlify/functions/summary.mts` serves `POST /api/summary`. It calls Claude with the Anthropic SDK through Netlify AI
Gateway, which injects the credentials, so no key is stored anywhere. The model is `claude-sonnet-5-5`; set the
`SAMT_MODEL` environment variable (Functions scope) to change it. It is rate-limited to 6 calls a minute per visitor.

## Reminders

`src/reminders.json` holds the verses and hadith. Qur'an text: Tanzil Project, Uthmani text v1.1 (tanzil.net),
NFC-normalised, CC BY 3.0 (verbatim copies only, credit Tanzil and link to tanzil.net). English: Pickthall (1930), as
Tanzil hosts it (non-commercial use). Hadith: wording, numbers and grades from sunnah.com, cross-checked letter for
letter against an independent sunnah.com dataset; the "In plain words" meanings are short renderings, not a
published translation. Never edit the Arabic by hand.

## Deploy

Netlify publishes `site/` as it is (see `netlify.toml`) and bundles the one function; the pages have no build step.
The Netlify project (samt-quiet) is not linked to this repository's Git builds, so a push alone does not deploy: each
release is uploaded with Netlify's deploy tool from a clean checkout. To make every push to `main` deploy, link the
repository in Netlify (Project configuration, Build & deploy, Link repository).

## Change it

The pages are built from `src/`: `template.html` (markup and Quiet Glass styles), `chooser.html` (the start page) and
the modules `dsp.js`, `models.js`, `pipeline.js`, `voice-light.js`, `voice-neural.js`, `mic.js`, `ui.js`, and the
reminders in `reminders.json`. After an edit:

```bash
python3 scripts/build.py   # rewrites site/index.html, site/light/, site/neural/ (leaves the model alone)
```

Then check the pages in WebKit (Safari's engine) at phone and iPad widths before pushing.

## Notes

- ONNX Runtime Web is pinned to 1.20.1: 1.21 and later run away in WebKit on iOS / iPadOS 26.2 and kill the tab
  (microsoft/onnxruntime#26827).
- The look follows the Quiet Glass design language from Repo-1 (`site/DESIGN-LANGUAGE.md`, `styles/ql/tokens.css`,
  `styles/ds-ui.css`); the tokens are copied into `src/template.html`.
