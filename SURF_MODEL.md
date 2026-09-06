# Page 3 physical model

Page 3 is a real-time, reduced coastal-wave model with a 3D view and procedural
audio. It is not a validated coastal engineering or computational fluid dynamics
solver. Use it to explore wind, breaking, run-up and spatial hearing, not to predict
flooding, sound exposure or conditions at a real beach.

## Coordinates and wind

All lengths are metres and time is seconds. The shoreline is `z = 0`, the ocean is
at negative `z`, and `x` runs along the beach. The observer's ears are 1.70 m above
the sand. Yaw zero faces the ocean. Movement stays on the beach.

The wind blows in the positive `z` direction. The slider represents a uniform
10 m wind speed, `U`, over an adjustable upstream fetch, `F`. An SMB-style
fetch-limited estimate sets the incident sea state:

```text
X  = g F / U²
Hs = 0.283 U²/g tanh(0.0125 X^0.42)
Tp = 7.54 U/g tanh(0.077 X^0.25)
```

The app uses unadjusted slider wind in this empirical estimate. Period is bounded
below at 1.6 s. At zero wind no new crests form. Existing waves keep travelling.
Incoming crests have varied heights and periods around this estimate, with
correlated alongshore variation. This is not a full directional wave spectrum.
The initial sea has a 40 s warm-up, so opening the page shows established surf.

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

At shore, the remaining bore starts a shallow swash sheet. Its front follows
`dv/dt = -g slope - 0.10 v |v|`. Gravity slows the incoming sheet, reverses its
velocity, and draws it back into the water. Sheet thickness decreases as it spreads.
The last reach wets the sand, which dries gradually. This is a parcel approximation
to run-up, not a conservative wetting/drying shallow-water solver.

Physics uses fixed 1/60 s steps. Long frame gaps are capped at 0.1 s. Pause, hidden
tabs, and leaving page 3 stop its simulation and audio. Graphics use local Three.js
with generated water, foam, sky, sand and spray materials. No image downloads are
needed.

## Sound generation and the two ears

Each audible breaking strip generates its own seeded pressure signal. There is
no surf recording or repeating audio loop. The signal combines broadband noise,
low-frequency turbulent noise, and damped bubble tones. Bubble frequencies use
the near-surface Minnaert scaling `f ≈ 3.26 / R`, with radius `R` in metres.
This supplies a plausible timbre, not an acoustic solution of an entrained bubble
population or transmission across the water-air boundary.

The main impact rises over about 35 ms, then decays to zero over 1.4 to 3.8 s,
depending on wave height. Neighboring strips can crash at different times. A whole
crest therefore makes an extended, spatially distributed breaking sound, while
each strip sounds once. One source represents every 12 m of crest. Its amplitude
scales with the square root of a strip-energy estimate, `ρ g H² / 8 × area`.
At most 36 voices play at once.

The ear span is 0.175 m. Every source follows the breaking water, and the audio
recomputes paths as the observer walks or turns. Each ear gets:

- Its own 3D distance `r` and travel time `r / (343 + U n_z)`, where `n_z` is the
  source-to-ear direction along the wind. This is a first-order uniform-wind
  approximation.
- Pressure attenuation `1 / max(1, r)`.
- A distance- and direction-dependent low-pass filter to approximate atmospheric
  high-frequency loss and the head's acoustic shadow.
- A continuously changing fractional delay, so radial motion changes timing and
  pitch. This approximates Doppler; it is not a full retarded-time ray solver.

Both ears receive the same emitted signal through separate paths. The channel
merger preserves left and right. A stereo-linked compressor and a soft peak ceiling limit loud mixtures;
levels are relative and are not calibrated in pascals or dB SPL. Delay lines drain
before disposal. Pausing or leaving the page disconnects all active sources.

The app does not calculate ground or object sound reflections. It also omits
measured pinna HRTFs, diffraction around a full head mesh, atmospheric refraction,
humidity-specific absorption, full 3D turbulence, wave-wave scattering, tides,
currents, sediment transport, and two-way interactions between colliding swash
sheets. Those omissions are material limits on realism.

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
