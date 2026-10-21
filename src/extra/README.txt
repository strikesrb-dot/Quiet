Samt v3
=======

Samt is already online at https://samt-quiet.netlify.app (it updates itself from
GitHub). This zip is a copy of the same pages, for keeping or for putting up
somewhere else.

The microphone only works when Samt is opened from a web address (https),
not from the Files app.

Putting this copy online by hand with Netlify:
1. In Safari on the iPad, sign in at app.netlify.com.
2. Add new site > Deploy manually, then tap the upload area and pick samt-v3.zip.
3. Open the site's link in Safari and choose Samt Light or Samt Neural.
4. Tap a start button and allow the microphone.
5. Optional: Share > Add to Home Screen. Safari then won't clear your setup
   after a week of not opening it.

Claude's end-of-session summary needs the online Samt (samt-quiet.netlify.app):
it runs on Netlify's servers, so a copy uploaded by hand shows "Couldn't reach
Claude" instead. Everything else works the same.

What's inside
  index.html               chooser page
  light/index.html         Samt Light (everything in one file, works offline once loaded)
  neural/index.html        Samt Neural (loads ONNX Runtime from jsDelivr)
  neural/voice-model.onnx  on-device voice-ID model (WeSpeaker ResNet34, 8-bit weights, 6.4 MB)
  _headers                 caching rule for the model file
