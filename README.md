# Shoreline spatial sound lab

A beach simulator for exploring how stationary and moving sources affect stereo
arrival time and level, with two top-down pages and a first-person 3D surf page.

## Run locally

The checked-in app needs no build step or runtime downloads. Open `index.html`
directly, or serve the repository with a static web server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000` in a modern browser. Headphones are recommended.

## Controls

- Switch between Sound sources, Moving waves, and 3D surf at the top of the screen.
- Drag a seagull, Gaussian-noise, or wave source from the left palette into the scene.
- Click a palette source to add one near the listener.
- Drag any placed source to reposition it; select it to see the live acoustic readout.
- The waveform figure compares the idealized source signal with the independently
  delayed and attenuated left- and right-ear signals on shared axes.
- Use `W/A/S/D` or the arrow keys to move the listener within the sand.
- Use `Q/E` to rotate the listener left or right in 15° increments.
- Press `Delete` or `Backspace` to remove the selected source.
- Click **Play scene** to hear all placed sources together.
- A wave placed on the Sound sources page remains stationary until **Play scene** is
  pressed. It then produces spatial surf noise, moves shoreward using the same
  depth-dependent speed model as page 2, and disappears at the waterline. Its single
  Gaussian envelope spans that complete journey from emergence to shore.
- On the Moving waves page, wave crests appear automatically at random offshore
  locations at an adjustable waves-per-minute rate. Their spatial sound plays
  automatically while the page is active, with exactly one envelope per crest. Most
  crests move shoreward, some fade offshore, and occasional crests travel horizontally
  along the beach. Select a crest for a live acoustic readout or add one manually. A
  seagull also appears every ten seconds at a random location and flies on a random
  heading while its recorded call is spatialized along the moving path.

## 3D surf

Page 3 puts the camera at eye level on the beach. Onshore wind and fetch set
incoming wave height and period. Connected crests shoal over the sandbar, break,
and wash onto the sand before receding. Breaking sections generate turbulence and
bubble sound without recordings. Each ear has a separate moving sound path.

Use `W/A/S/D` or arrows to walk, `Q/E` to turn 15°, and drag to look around.
Touch controls are inside the view. Wind, fetch and listening level have sliders.
Pause, mute, full screen and a reset-view control are also available. Sound starts
when the page opens, subject to browser autoplay permission. Tap the view if the
browser asks for a gesture. Leaving the page stops its audio.

This is a reduced real-time physics model, not a validated fluid solver.
[The model notes](SURF_MODEL.md) give its equations, approximations and omissions.
Run `npm test` for numerical tests and `npm run check` for JavaScript syntax checks.
To rebuild the bundled Three.js renderer, run `npm ci` and `npm run build:vendor`.

## Acoustic model on pages 1 and 2

The scene represents a 36 × 22.5 m area. For every source, the simulator computes
the geometric distance to each ear using a 17.5 cm adult ear span and a speed of
sound of 343 m/s. Each stereo channel receives its own fractional-sample propagation
delay and free-field `1/r` pressure attenuation (capped inside 1 m). Sources are
direct-path only: ground and object reflections are intentionally omitted.

The seagull source uses a two-second excerpt from a real public-domain herring gull
field recording. Gaussian-noise sources produce two seconds of white noise multiplied
by a Gaussian amplitude envelope.

Moving waves use the shallow-water approximation `c = √(gh)` over an idealized
0.3–2.5 m depth profile. A crest may arrive at shore, fade offshore, or travel
occasionally alongshore, and always acts as one moving point source. Each crest's full
lifetime is rendered once as white noise under one zero-ended Gaussian envelope;
source-to-ear distance and fractional propagation delay are recalculated from its first
appearance through its endpoint.

## Audio credit

`assets/seagull-call.ogg` is a two-second edited excerpt of “Gull 1,” a herring gull
recorded by avphillips on Long Island, USA, in September 1999. The recording was
released into the public domain through PDSounds and is archived by
[Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Gull_1.ogg).
