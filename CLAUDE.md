# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Specter-EW is a tactical Electronic Warfare (EW) planning tool for calculating jamming effectiveness (J/S margin), sensing distances, and RF propagation. It runs as a Flask server and supports two deployment targets:

- **Local LAN (HTTP)**: accessed from tablets/laptops on the same network at `http://<host-ip>:5000`
- **Hosted (HTTPS)**: public-facing instance (e.g. Digital Ocean) behind a TLS-terminating reverse proxy

Two authentication modes are supported: **Clerk** (JWT-based, for HTTPS/hosted deployments) enabled by `CLERK_PUBLISHABLE_KEY`, and **session-based** (for LAN deployments) enabled by `APP_CREDENTIALS`. The localhost loopback (`127.0.0.1` / `::1`) bypasses authentication entirely.

Scenario persistence is file-based and browser-local only: users save/load portable `.specter.json` files from the Workbench, and autosave recovery uses `localStorage` on the current browser/device. Hosted Clerk login does not provide cloud scenario storage or cross-device resume.

## Running the Application

```bash
python3 -m venv venv
source venv/bin/activate
pip3 install -r requirements.txt
python3 app.py
```

Access at `http://localhost:5000` or `http://<host-ip>:5000`.

There are no build steps or linters configured. Runtime smoke tests live under `tests/` and can be run with `python -m unittest discover -s tests`.

## Deployment & Environment Variables

| Variable | Context | Description |
|----------|---------|-------------|
| `CLERK_PUBLISHABLE_KEY` | HTTPS deployments | Activates Clerk JWT auth. Set to the production publishable key (`pk_live_...`). The Frontend API URL is decoded from the key automatically. Supersedes `APP_CREDENTIALS` when set. |
| `CLERK_FRONTEND_API` | HTTPS deployments | Optional override for the Clerk Frontend API URL (e.g. `https://clerk.specter-ew.com`). Only needed if auto-derivation from the publishable key fails. |
| `SPECTER_HTTPS` | HTTPS deployments | Set to `true` when running behind a TLS proxy. Enables the `Secure` flag on session cookies. **Do not set on plain-HTTP LAN deployments** — browsers drop `Secure` cookies over HTTP, causing an infinite login redirect loop. |
| `APP_CREDENTIALS` | LAN deployments | Enables session-based login. Format: `user:pass,user2:pass2`. Ignored when `CLERK_PUBLISHABLE_KEY` is set. |
| `FLASK_SECRET_KEY` | LAN deployments | Signs session cookies. Required when `APP_CREDENTIALS` is set — without it each Gunicorn worker generates its own key, causing random logouts under multi-worker deployments. Not needed for Clerk auth. |

## Architecture

**Backend** (`app.py` + `core/`): Stateless Flask REST API with eight endpoints (plus auth routes):
- `POST /calculate_ea` — Electronic Attack: computes J/S margin (jamming effectiveness)
- `POST /calculate_es` — Electronic Support: computes omni sensing/detection range
- `POST /calculate_es_terrain` — ES with terrain-aware detection polygon (per-bearing diffraction)
- `POST /calculate_jammer_footprint` — EA jammer coverage polygon (per-bearing, terrain-aware); uses jammer EIRP and the global rx_sensitivity as the reference threshold
- `POST /compute_overlap` — Common area overlap between multiple ES detection rings
- `POST /get_elevations` — Elevation profile fetch for LOS/diffraction calculations
- `GET /tiles/local/<z>/<x>/<y>.png` — Serves local imagery GeoTIFFs as XYZ map tiles (204 if no coverage)
- `GET /api/data_dir_status` — Returns current local data directory path, DTED cell count, imagery file count, and locked state (localhost only)
- `POST /api/rescan_data` — Re-runs the local data directory scan without restarting (localhost only)
- `POST /api/set_data_dir` — Changes the local data directory path and rescans; persists to `specter_config.json` (localhost only, path validation enforced)
- `GET/POST /login` — Login page; renders Clerk SignIn component when `CLERK_PUBLISHABLE_KEY` is set, otherwise the custom username/password form
- `GET /logout` — Clears Flask session and redirects to login (Clerk sign-out is handled client-side via `window.Clerk.signOut()` before this redirect)

**Core physics** (`core/`):
- `link_budget.py` — EIRP, watts-to-dBm, frequency-hopping tax
- `propagation.py` — Multi-band hybrid path loss model (Egli, COST-231 Hata, Two-Ray, SHF/FSPL+foliage), received power, jamming evaluation, and sensing distance
- `elevation.py` — Elevation profile fetching, LOS checking, Deygout multiple knife-edge diffraction (ITU-R P.526); `_fetch_elevations()` implements local-first / API-fallback pipeline
- `local_data.py` — Local geospatial data manager: startup scanner for DTED L2 and GeoTIFF imagery, DTED elevation sampler, imagery tile renderer, coverage checker, and data directory configuration
- `antenna.py` — Directional antenna gain pattern, bearing calculations

**Frontend** (`static/js/map_logic.js`, vanilla JS):
- Leaflet.js map with OpenStreetMap and Esri Satellite tile layers
- Interactive placement of red (enemy), blue (friendly), and black (marker) nodes
- Black marker nodes are reference-only — no RF calculations, no links, no elevation fetch
- Versioned `.specter.json` scenario save/load, dirty-state tracking, and browser-local autosave recovery via `localStorage`; scenario files persist serializable planning intent only, not Leaflet objects, cookies, auth data, local filesystem paths, or cached terrain/elevation responses
- Link creation between red/blue nodes triggers RF calculations via API calls
- Workbench tabs are ordered Ops, Library, Builder, Scenario. Ops is default. Library places node templates as red/blue nodes; Builder creates complete radio/receiver/jammer node templates. User templates persist in `localStorage`, import/export as JSON packs, and are embedded in `.specter.json` scenario exports. Built-ins live in `static/equipment_profiles.json`, are schema v2 node templates, are commercial/civilian only, and must not include military radios, generic examples, or built-in jammer presets.
- Red and blue nodes carry node-attached `equipment` configs in scenario schema v3. Selecting a red/blue node loads that equipment into the sidebar; edits update the selected node. Receiver/jammer frequency fields are shown as locked reference/target context.
- `Link Enemy Comms by Frequency` auto-links only compatible same-frequency enemy radio pairs (0.001 MHz tolerance) and skips mismatches/non-radio transmitters.
- Workbench panel for managing multiple nodes simultaneously; toggles between EA and EP modes via the EP button in the workbench header
- Permanent MGRS grid labels above all icons; inline MGRS input in every popup lets the user type a grid string and jump the icon to that location
- Jammer footprint toggle on blue nodes: terrain-shaped cyan polygon showing per-bearing jammer coverage
- EP (Electronic Protection) mode: green EP nodes (`epNodes[]`, IDs prefixed `EP`) each hold one or more named sub-systems; clicking Calculate fires sequential `/calculate_es_terrain` calls (one per system) and renders color-coded terrain rings; sidebar shows EP-specific parameters (terrain, enemy RX sensitivity) while hiding EA controls. EP node system cards support both manual `+ Add System` and Library-based `Add From Library`, copying template name/frequency/power/gain/antenna type/beamwidth/height into editable EP system rows.
- Ring and footprint labels rendered as standalone `L.tooltip` instances positioned at the rightmost polygon vertex (not bound to the layer, so they don't re-anchor to the geometric center on map move); stored as `node.esLabel`, `node.fpLabel`, and `sys.label` and cleaned up alongside their ring layer; EP system labels are staggered 20 px vertically per system index to prevent stacking

**Template** (`templates/index.html`): Single-page app; all JS/CSS loaded from `static/`.

## Key Design Decisions

- **Multi-band hybrid propagation model**: path loss is routed by frequency and TX antenna height. `_cost231_valid()` gates COST-231 Hata / Two-Ray (freq ≥ 150 MHz AND tx_height ≥ 30 m). Routing table:
  - `freq > 2000 MHz` → SHF: FSPL + distance-proportional clutter absorption (2.0 / 5.0 dB/GHz·km for light/dense terrain) + near-ground canopy penalty (`_shf_near_ground_penalty_db()`); sensing distance capped at 1× radio horizon. NLOS paths add `diffraction_loss_db` as a terrain-blockage penalty (SHF does not meaningfully diffract, so the Deygout value represents opaque blockage severity rather than diffraction gain)
  - LOS + COST-231 valid → **Two-Ray Ground Reflection** (40 dB/decade)
  - NLOS + COST-231 valid → **COST-231 Hata** with urban/suburban/rural terrain correction
  - `freq ≥ 1000 MHz` AND COST-231 invalid (low antenna) → **FSPL** baseline + flat terrain correction (`_egli_terrain_correction_db()`); Egli is calibrated for 40–900 MHz and over-predicts path loss by 20–30 dB at 1–2 GHz, so FSPL is the physically correct floor for upper-UHF low-antenna scenarios; radio horizon cap applied
  - All others (VHF/UHF tactical, freq < 1000 MHz, low antenna) → **Egli (1957)** empirical model (SI constant 47.39) + flat terrain correction (`_egli_terrain_correction_db()`); no artificial horizon cap — the 40 dB/decade slope provides natural rolloff and the FSPL floor keeps results physically plausible at all distances
  - Free space / aerial terrain → **FSPL** (0 dB terrain correction)
  - `calculate_sensing_distance()` is the exact closed-form (or binary-search for SHF clutter) inverse of `calculate_path_loss()` for each branch
- **Terrain correction across all bands**: `_egli_terrain_correction_db(terrain_type)` returns a flat additive penalty (rural/open 0 dB, light forest/suburban +8 dB, dense forest/urban +20 dB) applied to the Egli and upper-UHF FSPL branches. For SHF, `_shf_near_ground_penalty_db(tx_height_m, rx_height_m, terrain_type)` adds an additional flat penalty when either antenna is below 5 m AGL in vegetated terrain (+5 dB light, +10 dB dense), capturing Fresnel-zone obstruction and canopy-entry absorption. All terrain type keywords use substring matching (`"dense"/"urban"`, `"suburb"/"light"`, fallthrough for open/rural) consistent across all model functions.
- **Deygout multiple knife-edge diffraction**: `_deygout_loss_db()` in `elevation.py` recursively finds the dominant obstacle, computes ITU-R P.526 knife-edge loss, and recurses on the two sub-paths; the sum is added to NLOS path loss for all frequency bands. For SHF the value acts as a blockage penalty rather than a classical diffraction correction.
- **No database**: all active planning state is client-side and the backend is purely stateless calculation. Durable scenario persistence is portable `.specter.json` download/upload; autosave recovery is local to the browser/device and should not be treated as cloud save even when Clerk auth is active.
- **Frequency-hopping tax**: node-attached in the frontend, not universal across the workspace. `calculate_ea` still accepts `apply_fh`, `enemy_bw_khz`, and `jammer_bw_khz`, but the frontend supplies those values per J/S pair from the red transmitter equipment and blue jammer equipment.
- **Terrain type as model selector**: terrain type (free space, rural, light forest, dense forest) drives the propagation model branch (COST-231 urban/suburban/rural correction; SHF clutter coefficient) and applies flat or distance-proportional clutter penalties across all frequency bands.
- **Directional antenna support**: nodes can be configured with azimuth and beamwidth; gain is reduced for off-boresight links using a Gaussian pattern approximation.
- **Antenna height AGL**: per-node height (metres) adjusts the LOS/diffraction endpoint elevation AND gates the propagation model — tx_height ≥ 30 m is required to route to COST-231 Hata / Two-Ray. Default is 1.0 m (minimum accepted). The SHF sensing distance cap and the Egli/SHF radio horizon calculations all use the actual AGL heights.
- **Common area detection overlay**: computes the geographic overlap between multiple ES detection rings to identify jointly-observable areas.
- **Jammer footprint**: per-bearing coverage polygon for blue nodes, driven by jammer EIRP and terrain diffraction. Uses the same `calculate_sensing_distance` / `get_elevation_profiles_batch` pattern as ES terrain rings. Reference threshold is the global `rx_sensitivity` parameter. Rendered in cyan (`#00bcd4`) to distinguish from red ES rings.
- **Black marker nodes**: reference-only annotation icons (`blackNodes[]`, IDs prefixed `M`). No elevation fetch, no RF links, no calculations. Managed by `placeBlackNode()`, `bindBlackPopup()`, and the `'place-black'` mode. Included in `updateMGRSTooltips()` and the Clear All / Center on Nodes controls.
- **EP mode**: toggled by `toggleEpMode()` which sets `epModeActive` and adds/removes the `ep-mode` CSS class on `<body>`. `.ea-only` elements are hidden and `.ep-only` elements shown via CSS rules when `body.ep-mode` is active. EP nodes (`epNodes[]`, IDs prefixed `EP`) are placed by `placeEpNode()` and managed by `addSystemToEpNode()`, `removeSystemFromEpNode()`, `calculateEpNode()`, `clearEpNodeRings()`, and `removeEpNode()`. Systems use colors from `EP_COLORS[]` (8-color palette, assigned by index mod 8). Sequential `for...of` loop in `calculateEpNode()` avoids exceeding the OpenTopoData 1 req/sec rate limit. EP nodes are included in `updateMGRSTooltips()`, Clear All, and Center on Nodes (including ring bounds).
- **Edge labels on rings**: all ring/footprint labels use `makeEdgeLabel()` — a standalone `L.tooltip` (not bound via `bindTooltip`) positioned at the rightmost polygon vertex (`polygonPoints.reduce()` by max longitude) or at a computed east offset for circle fallbacks. Stored separately from the ring layer (`node.esLabel`, `node.fpLabel`, `sys.label`) and removed alongside the ring at every cleanup site. This prevents Leaflet from re-anchoring the label to `getBounds().getCenter()` on map move events.
- **Inline MGRS input**: all three icon types include an MGRS text field in their popup (`mgrsInputSection()`), pre-filled with the current grid. Enter or the Go button calls `window.moveNodeToMGRS(type, id, value)`, which validates via `mgrs.toPoint()`, repositions the marker, pans the map, and triggers recalculation for red/blue nodes.
- **Authentication**: two modes, selected at startup by which env var is present. **Clerk** (`CLERK_PUBLISHABLE_KEY` set): `check_auth()` reads the `__session` cookie (a short-lived RS256 JWT set by Clerk's JS SDK), verifies it against Clerk's JWKS endpoint (`{frontend_api}/.well-known/jwks.json`) using `PyJWKClient` (keys cached in-process), and allows the request if valid. The Frontend API URL is decoded from the publishable key's base64url payload at startup. The login page mounts Clerk's `SignIn` component via `window.Clerk.mountSignIn()`; logout calls `window.Clerk.signOut()` client-side. **APP_CREDENTIALS** (LAN, no Clerk key): classic session cookie set on successful form POST, verified by `session.get('authenticated')`. CSRF protection (Flask-WTF) and rate limiting (10/min, Flask-Limiter) apply to the form only. The CSP is extended at runtime to allow Clerk's domain for scripts, styles, connect, fonts, and blob workers when Clerk is active. Localhost (`127.0.0.1` / `::1`) bypasses both auth paths entirely.
- **Local geospatial data pipeline**: `core/local_data.py` manages a startup-scanned index of DTED and GeoTIFF files in `LOCAL_DATA_DIR`. `_fetch_elevations()` in `elevation.py` tries `sample_dted()` first, then falls back to the opentopodata API for uncovered points. Only DTED Level 2 (`.dt2`, 30m) is indexed — L0 (900m) and L1 (90m) are excluded because their post spacing is too coarse for accurate Deygout diffraction calculations, and the API's SRTM 30m provides equivalent quality where local L2 is absent.
- **Adaptive ring quality**: `calculate_es_terrain` and `calculate_jammer_footprint` call `is_locally_covered(lat, lon, radius_km)` before computing bearings. If all required DTED cells are in the local index, ring quality is 72 bearings × 25 samples (near-instant); otherwise it falls back to 36 × 11 (rate-limited API, ~4 seconds).
- **Data directory configuration**: `LOCAL_DATA_DIR` is initialised by `_init_data_dir()` at startup: env var `LOCAL_DATA_DIR` → `specter_config.json` → default `local_data/`. The env-var path is locked (UI cannot override it). The three `/api/data_dir_*` endpoints are localhost-only (consistent with the existing auth model) and block sensitive filesystem paths to prevent local file inclusion attacks.
- **Local imagery tiles**: GeoTIFF files in `local_data/` (other than DTED) are indexed by WGS84 bounds and served as 256×256 PNG tiles via `/tiles/local/<z>/<x>/<y>.png`, reprojeced to Web Mercator (EPSG:3857) using rasterio. The Leaflet layer control exposes this as an overlay that users can toggle on/off.
