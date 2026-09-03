# Reduced-Order Physics Simulations

Reduced-order, physics-informed simulations for R&D.

## D33 Lunar Cargo Mission v7 — "COLDWATER"

A single-file, fully offline browser simulation of a heavy cargo flight to the lunar south
pole: deorbit burn → coast → powered descent from PDI → touchdown beside a pre-positioned
base → cargo ramp → rover egress → a DEM-planned traverse into a permanently shadowed
crater to log candidate cold traps.

**Terrain, illumination, shadows, the landing site, the rover route and the cold-trap
candidates are all derived from real LRO LOLA topography.**

Build it and open `dist/lunar_cargo_mission_v7.html` in any browser with WebGL2. No network,
no CDN, no build step at runtime, no workers.

```bash
npm run build      # inline src/ + the DEM asset into dist/lunar_cargo_mission_v7.html
npm test           # physics-core regression tests (node --test)
npm run headless   # boot the bundle in Chromium, fly the mission, capture frames
npm run all        # syntax check + tests + build + headless
```

### Controls

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `C` | cycle camera | `1` `2` `3` `4` | time warp 1× / 4× / 16× / 64× |
| `V` | vision mode (visible / night / thermal) | `Q` `E` | exposure bias −/+ |
| `L` | rover headlights | `N` | landing ellipse: beacon-aided vs map-only |
| `M` | rover auto / manual | `P` | pause |
| `WASD` | drive (manual) | `R` | restart |
| mouse drag / wheel | free camera | `H` | hide UI |

---

## What is measured, what is modelled, what is invented

The simulation is explicit about this, in the source and in the in-app **DATA & FIDELITY**
panel. Nothing synthetic is allowed to reach a screening number.

**SOURCE (measured).** NASA PDS Geosciences, LRO LOLA GDR polar DEM `ldem_875s_5m`
(5 m/px, polar stereographic, south pole). A 25.6 km window centred on the pole, resampled
to 512² @ 50 m, elevation relative to a 1737.4 km sphere.

**DERIVED (F2).** Mean illumination by ray-marching the real DEM over a 24-azimuth sweep at
1.5° solar elevation. A second, *directional* sun-visibility raster is swept at the actual
sun azimuth with a 0.53° solar-disc penumbra — that is what casts the long terrain shadows
you see. Surface temperature by radiative equilibrium (Stefan–Boltzmann) on the real slope;
PSRs by connected components; the landing pad by slope/illumination screening; the rover
route by A* with an 18° grade limit.

**MODELLED (F2).** The descent is flown end to end — see below.

**SYNTHETIC (F1, cosmetic).** Sub-50 m surface roughness and the small-crater field (below
DEM post spacing); *all* terrain beyond the 25.6 km LOLA window, which exists only to give
the approach and the horizon somewhere to be; plume, ejecta, engine-scoured ground, and the
base and vehicle geometry.

**NOT CLAIMED.** Not CFD, not validated flight GNC, not a certified design tool, and not an
ice detection. Cold traps are temperature-stability candidates derived from topography
alone — no neutron, radar or UV data. Vehicle mass, thrust, inertia and gear limits are
Apollo-LM-class assumptions, exposed in `src/core.js` so they can be changed.

---

## Physics

### The descent is flown, not handed over

v6 started the vehicle at a 2.6 km "high gate" with an invented state. v7 flies the whole
profile: DOI from a 100 km circular orbit sized by vis-viva (19.4 m/s), a half-orbit coast
to a 15.24 km periapsis (Apollo's PDI altitude), then powered descent — braking, approach
and terminal — arriving on the pad with propellant in the tanks.

| | value |
| --- | --- |
| PDI | 15.24 km @ 1692 m/s |
| Braking phase | ~770 s over ~674 km downrange |
| Approach phase | ~124 s over ~7.3 km, from the high gate |
| Planned ΔV | 2031 m/s of 2235 m/s available (~9% margin) |
| Touchdown | ~0.7 m/s vertical, <1 m/s lateral, upright to ~1° |

Guidance is **ZEM/ZEV** (the Apollo E-guidance family) closing on the *navigated* state, not
the truth state. Planar translation carries the curvature terms (`vx²/r`, `vx·vh/r`) and
1/r² gravity, so a vehicle coasting at periapsis stays in orbit instead of falling out of
the sky. Attitude is second-order with real inertia and an RCS torque limit; throttle has
first-order lag and a deep-throttle floor; the radar altimeter has noise, lag and a lock
altitude, and the IMU drifts. Touchdown is on the real terrain height under the vehicle.

Three bugs found and fixed while building this are documented in the source where they
were fixed, because each is a trap worth remembering:

- **The braking leg must target the high gate, not the pad.** Targeting the pad arrives
  ~7 km late; the approach leg then has to overshoot, fly backwards, and burns ~100 m/s
  extra doing it.
- **A "vertical authority floor" set as a fraction of maximum thrust exceeds local
  gravity** on a light, high-thrust vehicle, so the lander *climbs* while nulling drift and
  drains the terminal propellant budget. The floor has to sit below weight.
- **An attitude rate limit the RCS cannot brake produces a limit cycle.** At 9°/s with only
  3.2°/s² of authority, stopping a slew costs ~12° of travel, so the vehicle oscillates and
  arrives tilted. The rate command is now braking-aware (`q = √(2·α·|e|)`), which is why
  real attitude autopilots use a parabolic switching curve rather than pure proportional
  rate.

### Navigation error is the story the dispersion tells

The Monte Carlo is two-stage: dispersions at PDI are propagated through the braking phase
to the high gate, then the approach and terminal phases are flown from the dispersed gate
and screened against the real DEM at the actual touchdown point.

Because the guidance closes on position, injection dispersion is largely nulled and
**navigation dominates the landing ellipse** — as it did on Apollo. Press `N` to switch the
plot between the two cases:

| | 3σ downrange | site acceptance | dominant abort driver |
| --- | --- | --- | --- |
| Beacon-aided | ±37 m | 98% | lateral velocity at contact |
| Map-relative only | ±121 m | 88% | terrain undulation |

That difference *is* the argument for a precision navigation aid at the base, and it falls
out of the physics rather than being asserted.

Site screening uses the DEM alone. Undulation is measured over a 120 m radius (~2.4 DEM
pixels — the smallest scale the data resolves), de-trended by the local best-fit plane, and
calibrated against the reference pad rather than an invented threshold. Footpad-scale
roughness is **unresolvable** at 50 m/px and is reported as a declared data gap, not
estimated.

---

## Rendering

Raw WebGL2, no libraries, no CDN — the offline property is deliberate and preserved.

- **One terrain system for the whole mission.** A radial grid anchored under the camera with
  geometrically growing ring spacing, mapped onto the lunar sphere exactly (a point at arc
  distance `s` sits at horizontal `R·sin(s/R)`, vertical `R·(cos(s/R)−1)`). That gives a
  true curved horizon at any altitude from 100 km orbit down to the pad, with near-constant
  screen-space triangle size. Real DEM inside the data window, procedural relief beyond.
- **Lunar regolith is not Lambertian.** Shading uses Lommel-Seeliger with a Hapke opposition
  surge, which is why the surface reads as the Moon rather than as grey clay.
- **There is no sky in vacuum.** Ambient is ground-bounce scaled by the *local* irradiance
  plus faint earthshine — so a permanently shadowed crater is genuinely black except for the
  rover's lamps, and at 1.5° solar elevation flat ground is dark while sun-facing slopes are
  brilliant. That contrast is the south-polar look.
- **Terrain self-shadowing comes from the DEM sun-visibility raster** — exact, global and
  free. The shadow map therefore only carries vehicle and base casters, so one small map is
  enough even with the sun barely above the horizon.
- **Linear HDR throughout, AgX applied once**, after GPU auto-exposure (log-average with a
  1×1 ping-pong and temporal adaptation). Stars are at physically faint levels, so they
  vanish when the camera stops down for sunlit terrain and emerge in shadow — as a real
  camera does. False-colour views (night vision, thermal) bypass the tonemap entirely, since
  they are already display-referred.
- **The plume is nearly invisible and the dust flies flat.** An Apollo-class hypergolic
  engine firing in vacuum shows almost no flame; what the landing films show is a *sheet* of
  regolith leaving at a few degrees above horizontal at tens of m/s on pure ballistic arcs,
  with no billowing and no settling. Both are modelled that way.
- The GPU terrain displacement and the CPU vehicle placement share an **integer hash**, so
  they agree bit-for-bit. A `sin()`-based hash diverges at these world coordinates because
  the argument exceeds float32 precision — which would leave the rover floating or sunk.

---

## Layout

```
src/core.js     physics, guidance, navigation, terrain field, Monte Carlo  (no GL, no DOM)
src/glsl.js     shared GLSL blocks: AgX, regolith BRDF, DEM sampling, terrain height field
src/gfx.js      WebGL2 layer: programs, terrain grid, shadow map, post chain
src/mission.js  mission state machine, cameras, dust, HUD, frame loop
src/index.html  shell + provenance panel      src/style.css
assets/         the LOLA-derived DEM asset (deflate + base64, decoded at boot)
test/core.test.js   physics regression tests   test/headless.js   Chromium boot + flight + frames
build.js        inlines everything into dist/
```

`src/core.js` runs headlessly under Node with no browser APIs, which is what makes the
physics testable independently of the renderer.

## Validation

`npm run all` runs: syntax check → 20 physics regression tests → build → headless Chromium
run that boots the bundle, compiles every shader, flies the complete mission from orbit to
survey complete, and asserts that no frame is a silent black screen. The headless run also
covers the mobile code path (`node test/headless.js --mobile`).

A green headless run is necessary, not sufficient — it renders under SwiftShader, so
reported frame rates are not meaningful and on-device confirmation is still required before
any performance claim.
