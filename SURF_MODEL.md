# Page 3 physical model

Page 3 is a real-time, reduced coastal-wave model with a 3D view and procedural
audio. It is not a validated coastal engineering or computational fluid dynamics
solver. Use it to explore wind, breaking, run-up and spatial hearing, not to predict
flooding, sound exposure or conditions at a real beach.

## Coordinates and wind

All lengths are metres and time is seconds. The shoreline is `z = 0`, the ocean is
at negative `z`, and `x` runs along the beach. The observer's ears are 1.70 m above
the sand. Yaw zero faces the ocean. Movement stays on the beach.

The slider sets mean wind speed at 10 m height. Every 2 to 7 seconds a seeded
generator draws a Gaussian speed multiplier, with standard deviation 0.19 and
bounds of 0.55 to 1.45, and a direction uniformly within ±10° of positive `z`.
Both approach their new targets with a 1.5 s response time. The instantaneous wind
drives spray and sound propagation. Integrated wind displacement moves the ripple
texture without jumps. An SMB-style
fetch-limited estimate sets the incident sea state:

```text
X  = g F / U²
Hs = 0.283 U²/g tanh(0.0125 X^0.42)
Tp = 7.54 U/g tanh(0.077 X^0.25)
```

Here `U` is instantaneous gust speed and `F` is fetch in metres. The estimated sea
state relaxes over 9 s, and each new crest inherits the wind direction at birth.
Period is bounded below at 1.6 s. Zero mean wind immediately removes wind input;
the existing sea state decays and waves already present keep travelling.
Incoming crests have varied heights and periods around this estimate, with
correlated alongshore variation. This is not a full directional wave spectrum.
The initial sea has a 40 s warm-up, so opening the page shows established surf.
The browser chooses a fresh random seed on initialization. Numerical tests use
fixed seeds for repeatability.

## Propagation and collapse

The sea floor slopes shoreward at 0.065 with an uneven submerged bar. The dry beach
slope is 0.085. Each crest has 41 connected sections spaced 4 m apart across 160 m
of shoreline. At each physics step the code solves finite-depth dispersion:

```text
ω² = g k tanh(kh)
c = ω/k
cg = c/2 [1 + 2kh / sinh(2kh)]
Htarget = Hincident sqrt(cg,incident / cg)
Hbreak = min(0.78h, 0.142 L tanh(kh))
```

The changing phase speed bends crests over variable depth. A small discrete
along-crest curvature term smooths adjacent positions. Shoaling approximates
conservation of wave energy flux before breaking. A modest empirical wind-input
term adds growth where wind outruns the wave. Neither term solves the complete
wave-action balance.

A depth or steepness threshold starts a section's collapse. That section sends a
disturbance to each neighbor with travel time `4 / sqrt(gh)`. A disturbance can
trigger a neighbor that exceeds 45% of its own breaking limit. This coupling and
threshold are heuristic. Each section has exactly one break event, never a looping
crash. Collapsing sections lose height through depth-dependent dissipation and
produce foam and gravity-driven spray. Wind advects the spray.

At `z = -6 m`, each incoming section deposits a depth/momentum pulse into a shared
41 × 81 shallow-water grid. Cells are 4 m alongshore and 0.25 m cross-shore. The grid
extends from `z = -8` to `12 m`. Handoff height uses remaining crest height plus
22% of pre-break height, bounded to 0.008 to 0.65 m. This empirical handoff replaces
the earlier independent moving sheets.

The finite-volume solver advances depth `h` and both horizontal momenta `hu, hv`.
It uses Rusanov fluxes with hydrostatic reconstruction and bed-pressure corrections.
An adaptive substep enforces a combined-direction Courant limit of 0.38. Bed drag
reduces momentum semi-implicitly. Internal fluxes exchange mass and momentum between
cells, so opposing flows slow one another and raise a bore instead of crossing
unchanged. Tests check conserved water volume in a closed domain, symmetric
collisions, nonnegative depth, and still water over variable bed elevation.

The offshore five-cell sponge absorbs outgoing water. The landward and alongshore
edges are closed. Compression adds foam, which moves with the mass flux and decays.
The rendering samples the water depth and foam field, discards dry cells, and makes
thin water transparent. A separate wetness field darkens exposed sand and dries over
40 s. Centimetre-scale bed relief makes the shoreline irregular. This remains a
first-order, depth-averaged solver, not a resolved 3D turbulent free surface.

Ocean physics uses fixed 1/60 s steps. Long frame gaps are capped at 0.1 s. Pause
freezes the wind and water, fades audio out over 35 ms, and suspends its clock.
Resume retains source playback cursors and delay lines. Leaving the page or hiding
the browser stops and disposes its sources. Graphics use local Three.js
with generated water, foam, sky, sand and spray materials. No image downloads are
needed.

## Sound generation and the two ears

Each audible breaking strip generates its own seeded pressure signal. There is
no surf recording or repeating audio loop. The signal combines several filtered
noise bands, low-frequency turbulent pressure, and noise-excited low bubble-cloud
resonances. Smooth random modulation makes the roar less uniform. This is a
procedural timbre model, not a coupled-bubble or water-air transmission solver.

The main impact rises over about 110 ms, then decays to zero over 4 to 7 s,
depending on wave height. Neighboring strips can crash at different times. A whole
crest therefore makes an extended, spatially distributed breaking sound, while
each strip sounds once. One source represents every 12 m of crest. Its amplitude
scales with the square root of a strip-energy estimate, `ρ g H² / 8 × area`.
At most 48 voices play at once. Breaking sources remain at the actual collapse
position, instead of continuing to chase an intact crest. A handoff event can start
an 8 s wash source, with no concurrent duplicate wash source at the same alongshore
sample. Its level follows the square root of a turbulence proxy summed from
`h |v|³ × (0.2 + foam)`. Its position follows that proxy's centroid, so collisions
and backwash change both the wash sound's strength and origin. These are empirical
sound-source estimates, not calibrated acoustic power.

The ear span is 0.175 m. Audio paths update as the observer walks or turns, the
wind changes, and wash sources move. Each ear gets:

- Its own 3D distance `r` and travel time `r / (343 + wind · n)`, where `n` is the
  source-to-ear unit direction. This is a first-order, spatially uniform-wind
  approximation.
- Pressure attenuation `1 / max(1, r)`.
- A distance- and direction-dependent low-pass filter to approximate atmospheric
  high-frequency loss and the head's acoustic shadow.
- A continuously changing fractional delay, so radial motion changes timing and
  pitch. This approximates Doppler; it is not a full retarded-time ray solver.

Both ears receive the same emitted signal through separate paths. The channel
merger preserves left and right. A stereo-linked compressor and a soft peak ceiling limit loud mixtures;
levels are relative and are not calibrated in pascals or dB SPL. Delay lines drain
before disposal. Optional rings show the three strongest estimated sources, amber
for breaking and blue for wash. The readout reports the strongest source's paths.

The app does not calculate ground or object sound reflections. It also omits
measured pinna HRTFs, diffraction around a full head mesh, atmospheric refraction,
humidity-specific absorption, full 3D turbulence, wave-wave scattering, tides,
large-scale currents, and sediment transport. The shallow-water grid does not feed
back into offshore crest dynamics. Those omissions are material limits on realism.

## Background references

- The [USGS wind-wave methods](https://pubs.usgs.gov/publication/sir20225056/full)
  give the fetch-growth formula family used here. Page 3 uses its deep-water limit
  for incoming waves, then propagates crests through local depth.
- The [SWAN technical description of wave-energy dissipation](https://swanmodel.sourceforge.io/online_doc/swantech/node16.html)
  describes depth-induced breaking and the empirical nature of breaking closures.
  Page 3 does not implement SWAN.
- The [USACE coastal revetment manual](https://www.publications.usace.army.mil/Portals/76/Publications/EngineerManuals/EM_1110-2-1614.pdf)
  covers breaking and run-up for coastal design. Its scope also illustrates why
  the reduced swash model here should not be used for design.
- [A candidate mechanism for exciting sound during bubble coalescence](https://pubs.aip.org/asa/jasa/article/129/3/EL83/978660/A-candidate-mechanism-for-exciting-sound-during)
  studies bubble oscillation and acoustic emission. The app uses a simplified
  oscillator timbre, not that paper's nonlinear bubble model.
- [Audusse et al., hydrostatic reconstruction](https://www.math.univ-paris13.fr/~audusse/articles/hydro.pdf)
  describes the well-balanced strategy used for the shared shallow-water grid.
- [Improved water sound synthesis using coupled bubbles](https://graphics.stanford.edu/papers/coupledbubbles/assets/coupledbubbles.pdf)
  explains why low cloud modes matter for the sound of breaking water. Page 3 uses
  noise-excited low resonances as a surrogate, not the paper's coupled solver.

## Development and checks

The checked-in renderer bundle makes `index.html` usable through a static server
or directly as a local file. Runtime network access is unnecessary. To rebuild the
bundle or run the numerical tests:

```sh
npm ci
npm run build:vendor
npm run check
npm test
```

`tests/surf-physics.test.cjs` checks dispersion, wind response, symmetry and rotation
of ear paths, single impacts, neighboring collapse, run-up reversal, bounded state,
and deterministic audio samples. Browser checks should also cover desktop/mobile
layout, movement, drag-to-look, wind/fetch sliders, pause, mute, page transitions,
and nonzero stereo output without nonfinite samples or clipping.

Three.js 0.180.0 is bundled under its MIT license in `vendor/THREE-LICENSE.txt`.
