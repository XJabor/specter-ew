# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Specter-EW is a tactical Electronic Warfare (EW) planning tool for calculating jamming effectiveness (J/S margin), sensing distances, and RF propagation. It runs as a Flask server and supports two deployment targets:

- **Local LAN (HTTP)**: accessed from tablets/laptops on the same network at `http://<host-ip>:5000`
- **Hosted (HTTPS)**: public-facing instance (e.g. Digital Ocean) behind a TLS-terminating reverse proxy

Session-based authentication is implemented via `APP_CREDENTIALS`. The localhost loopback (`127.0.0.1` / `localhost`) bypasses authentication entirely for local development.

## Running the Application

```bash
python3 -m venv venv
source venv/bin/activate
pip3 install -r requirements.txt
python3 app.py
```

Access at `http://localhost:5000` or `http://<host-ip>:5000`.

There are no build steps, test suites, or linters configured.

## Deployment & Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FLASK_SECRET_KEY` | Recommended | Signs session cookies. If unset, a random key is generated per-process — every restart invalidates active sessions. Set persistently in production (e.g. systemd `EnvironmentFile`). |
| `APP_CREDENTIALS` | Optional | Enables login. Format: `user:pass,user2:pass2`. If unset, the app is open to all. |
| `SPECTER_HTTPS` | Optional | Set to `true` when running behind a TLS proxy (Digital Ocean). Enables the `Secure` flag on session cookies. **Do not set on plain-HTTP LAN deployments** — browsers drop `Secure` cookies over HTTP, causing an infinite login redirect loop. |

## Architecture

**Backend** (`app.py` + `core/`): Stateless Flask REST API with eight endpoints (plus auth routes):
- `POST /calculate_ea` — Electronic Attack: computes J/S margin (jamming effectiveness)
- `POST /calculate_es` — Electronic Support: computes omni sensing/detection range
- `POST /calculate_es_terrain` — ES with terrain-aware detection polygon (per-bearing diffraction)
- `POST /calculate_jammer_footprint` — EA jammer coverage polygon (per-bearing, terrain-aware); uses jammer EIRP and the global rx_sensitivity as the reference threshold
- `POST /compute_overlap` — Common area overlap between multiple ES detection rings
- `POST /get_elevations` — Elevation profile fetch for LOS/diffraction calculations
- `GET/POST /login` — Login page (session-based auth)
- `GET /logout` — Clears session and redirects to login

**Core physics** (`core/`):
- `link_budget.py` — EIRP, watts-to-dBm, frequency-hopping tax
- `propagation.py` — Multi-band hybrid path loss model (Egli, COST-231 Hata, Two-Ray, SHF/FSPL+foliage), received power, jamming evaluation, and sensing distance
- `elevation.py` — Elevation profile fetching, LOS checking, Deygout multiple knife-edge diffraction (ITU-R P.526)
- `antenna.py` — Directional antenna gain pattern, bearing calculations

**Frontend** (`static/js/map_logic.js`, ~1,400 lines, vanilla JS):
- Leaflet.js map with OpenStreetMap and Esri Satellite tile layers
- Interactive placement of red (enemy), blue (friendly), and black (marker) nodes
- Black marker nodes are reference-only — no RF calculations, no links, no elevation fetch
- Link creation between red/blue nodes triggers RF calculations via API calls
- Workbench panel for managing multiple nodes simultaneously
- Permanent MGRS grid labels above all icons; inline MGRS input in every popup lets the user type a grid string and jump the icon to that location
- Jammer footprint toggle on blue nodes: terrain-shaped cyan polygon showing per-bearing jammer coverage

**Template** (`templates/index.html`): Single-page app; all JS/CSS loaded from `static/`.

## Key Design Decisions

- **Multi-band hybrid propagation model**: path loss is routed by frequency and TX antenna height. `_cost231_valid()` gates COST-231 Hata / Two-Ray (freq ≥ 150 MHz AND tx_height ≥ 30 m). Routing table:
  - `freq > 2000 MHz` → SHF: FSPL + ITU-R P.833 foliage/clutter absorption; strict 1× radio horizon cap (no over-horizon propagation at SHF)
  - LOS + COST-231 valid → **Two-Ray Ground Reflection** (40 dB/decade)
  - NLOS + COST-231 valid → **COST-231 Hata** with urban/suburban/rural terrain correction
  - All others (VHF/UHF tactical) → **Egli (1957)** empirical model (SI constant 47.39); 3× radio horizon cap preserves VHF ground-wave range while preventing extrapolation
  - Free space / aerial terrain → **FSPL**
  - `calculate_sensing_distance()` is the exact closed-form (or binary-search for SHF clutter) inverse of `calculate_path_loss()` for each branch
- **Deygout multiple knife-edge diffraction**: `_deygout_loss_db()` in `elevation.py` recursively finds the dominant obstacle, computes ITU-R P.526 knife-edge loss, and recurses on the two sub-paths; the sum is added to NLOS path loss for all non-SHF frequencies.
- **No database**: all state is client-side (Leaflet map markers/layers); the backend is purely stateless calculation.
- **Frequency-hopping tax**: applies a configurable dB penalty when hopping waveforms are selected.
- **Terrain type as model selector**: terrain type (free space, rural, suburban, urban/dense) drives both the propagation model branch (COST-231 urban/suburban/rural correction; SHF foliage coefficient) and the clutter penalty magnitude.
- **Directional antenna support**: nodes can be configured with azimuth and beamwidth; gain is reduced for off-boresight links using a Gaussian pattern approximation.
- **Antenna height AGL**: per-node height (metres) adjusts the LOS/diffraction endpoint elevation AND gates the propagation model — tx_height ≥ 30 m is required to route to COST-231 Hata / Two-Ray. Default is 1.0 m (minimum accepted). Radio horizon caps in both Egli and SHF branches use the actual AGL heights.
- **Common area detection overlay**: computes the geographic overlap between multiple ES detection rings to identify jointly-observable areas.
- **Jammer footprint**: per-bearing coverage polygon for blue nodes, driven by jammer EIRP and terrain diffraction. Uses the same `calculate_sensing_distance` / `get_elevation_profiles_batch` pattern as ES terrain rings. Reference threshold is the global `rx_sensitivity` parameter. Rendered in cyan (`#00bcd4`) to distinguish from red ES rings.
- **Black marker nodes**: reference-only annotation icons (`blackNodes[]`, IDs prefixed `M`). No elevation fetch, no RF links, no calculations. Managed by `placeBlackNode()`, `bindBlackPopup()`, and the `'place-black'` mode. Included in `updateMGRSTooltips()` and the Clear All / Center on Nodes controls.
- **Inline MGRS input**: all three icon types include an MGRS text field in their popup (`mgrsInputSection()`), pre-filled with the current grid. Enter or the Go button calls `window.moveNodeToMGRS(type, id, value)`, which validates via `mgrs.toPoint()`, repositions the marker, pans the map, and triggers recalculation for red/blue nodes.
- **Authentication**: session-based login via `APP_CREDENTIALS` env var. CSRF protection (Flask-WTF) on the login form. Login attempts are rate-limited to 10/minute per IP (Flask-Limiter). API endpoints (`/calculate_*`, etc.) are same-origin `fetch()` calls and are not subject to CSRF. Security headers are set on all responses.
