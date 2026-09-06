# Checks for 3D surf

Run `npm run check` and `npm test` from the repository root. The Node tests do not
need a browser or audio hardware.

The audio checks need a browser with Web Audio. `surf-audio-browser.js` renders the
production voice graph in an `OfflineAudioContext` and tests onset delay, channel
symmetry, a half-turn, attenuation, DC offset and a 36-source overload. With a
Playwright CLI session open on the app, run:

```sh
playwright-cli run-code 'async (page) => {
  await page.addScriptTag({path:"tests/surf-audio-browser.js"});
  return await page.evaluate(() => runSurfAudioChecks());
}'
```

## Browser checks completed

The September 6, 2026 check used Chromium, both over localhost and directly from
`index.html`. It covered:

- Layout widths of 320, 390, 600, 768, 1024 and 1440 pixels, with no horizontal overflow.
- Keyboard walking, a 15° turn, drag-to-look and resetting the observer.
- Wind and fetch sliders changing offshore height and period.
- Pause freezing physics and disconnecting voices, mute, and resume.
- Full-screen entry and the on-screen exit control.
- Page 1 Gaussian playback and page 2 automatic wave sound after leaving page 3.
- Returning to page 3 without duplicate canvases or audio from other pages.
- Finite stereo samples, correct ear-arrival order and no clipping in the overload test.
- No JavaScript or WebGL console errors during these checks.

These checks do not establish perceptual realism, validate the fluid model, or
cover every browser and audio device. See `SURF_MODEL.md` for the physical limits.
