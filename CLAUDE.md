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
- `propagation.py` — Dual-slope path loss model (smooth 20→40 log blend across 0.5–2.0 km transition), clutter/terrain loss, received power, jamming evaluation, and sensing distance
- `elevation.py` — Elevation profile fetching, LOS checking, knife-edge diffraction (ITU-R)
- `antenna.py` — Directional antenna gain pattern, bearing calculations

**Frontend** (`static/js/map_logic.js`, ~1,300 lines, vanilla JS):
- Leaflet.js map with OpenStreetMap and Esri Satellite tile layers
- Interactive placement of red (enemy) and blue (friendly) nodes
- Link creation between nodes triggers RF calculations via API calls
- Workbench panel for managing multiple nodes simultaneously
- MGRS coordinate display for all placed icons
- Jammer footprint toggle on blue nodes: terrain-shaped cyan polygon showing per-bearing jammer coverage

**Template** (`templates/index.html`): Single-page app; all JS/CSS loaded from `static/`.

## Key Design Decisions

- **Dual-slope propagation model**: path loss switches from free-space (20 log distance) to terrain-masked (40 log distance) at 1 km. This conservative estimate is intentional.
- **No database**: all state is client-side (Leaflet map markers/layers); the backend is purely stateless calculation.
- **Frequency-hopping tax**: applies a configurable dB penalty when hopping waveforms are selected.
- **Clutter loss**: terrain type (urban, suburban, open) adds attenuation on top of path loss.
- **Directional antenna support**: nodes can be configured with azimuth and beamwidth; gain is reduced for off-boresight links using a Gaussian pattern approximation.
- **Antenna height AGL**: per-node height (metres) adjusts the effective endpoint elevation in the LOS/diffraction calculation only. Path loss is still computed with a ground-level assumption by design.
- **Common area detection overlay**: computes the geographic overlap between multiple ES detection rings to identify jointly-observable areas.
- **Jammer footprint**: per-bearing coverage polygon for blue nodes, driven by jammer EIRP and terrain diffraction. Uses the same `calculate_sensing_distance` / `get_elevation_profiles_batch` pattern as ES terrain rings. Reference threshold is the global `rx_sensitivity` parameter. Rendered in cyan (`#00bcd4`) to distinguish from red ES rings.
- **Authentication**: session-based login via `APP_CREDENTIALS` env var. CSRF protection (Flask-WTF) on the login form. Login attempts are rate-limited to 10/minute per IP (Flask-Limiter). API endpoints (`/calculate_*`, etc.) are same-origin `fetch()` calls and are not subject to CSRF. Security headers are set on all responses.
