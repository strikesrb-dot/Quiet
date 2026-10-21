# Samt

A quiet-time aid. While it runs, your own voice comes back to you in your headphones a fraction of a second late
(delayed auditory feedback), which makes talking very hard. It does this only for your voice, and it lets greetings,
salam and short answers through. Everything runs on the device; nothing is uploaded.

- **Samt Light** (`site/light/`): one self-contained page. Tells you apart from women, children and the TV well; less
  sure against other men.
- **Samt Neural** (`site/neural/`): adds an on-device voice-ID model (WeSpeaker ResNet34, 8-bit weights, 6.4 MB) run with
  ONNX Runtime Web 1.20.1 from jsDelivr. Much better against other men. Needs iPadOS 16.4 or newer.

Each version keeps its own setup in the browser (IndexedDB), with a backup file you can save and restore.

## Deploy

Netlify publishes `site/` as it is (see `netlify.toml`); there is no build step. Every push to `main` deploys.

## Change it

The pages are built from `src/`: `template.html` (markup and Quiet Glass styles), `chooser.html` (the start page) and
the modules `dsp.js`, `models.js`, `pipeline.js`, `voice-light.js`, `voice-neural.js`, `mic.js`, `ui.js`. After an edit:

```bash
python3 scripts/build.py   # rewrites site/index.html, site/light/, site/neural/ (leaves the model alone)
```

Then check the pages in WebKit (Safari's engine) at phone and iPad widths before pushing.

## Notes

- ONNX Runtime Web is pinned to 1.20.1: 1.21 and later run away in WebKit on iOS / iPadOS 26.2 and kill the tab
  (microsoft/onnxruntime#26827).
- The look follows the Quiet Glass design language from Repo-1 (`site/DESIGN-LANGUAGE.md`, `styles/ql/tokens.css`,
  `styles/ds-ui.css`); the tokens are copied into `src/template.html`.
