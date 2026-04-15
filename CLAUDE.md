# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Specter-EW is a tactical Electronic Warfare (EW) planning tool for calculating jamming effectiveness (J/S margin), sensing distances, and RF propagation. It runs as a local Flask server intended for use on trusted networks only — no authentication is implemented by design.

## Running the Application

```bash
python3 -m venv venv
source venv/bin/activate
pip3 install -r requirements.txt
python3 app.py
```

Access at `http://localhost:5000` or `http://<host-ip>:5000`.

There are no build steps, test suites, or linters configured.

## Architecture

**Backend** (`app.py` + `core/`): Stateless Flask REST API with five endpoints:
- `POST /calculate_ea` — Electronic Attack: computes J/S margin (jamming effectiveness)
- `POST /calculate_es` — Electronic Support: computes omni sensing/detection range
- `POST /calculate_es_terrain` — ES with terrain-aware detection polygon (per-bearing diffraction)
- `POST /compute_overlap` — Common area overlap between multiple ES detection rings
- `POST /get_elevations` — Elevation profile fetch for LOS/diffraction calculations

**Core physics** (`core/`):
- `link_budget.py` — EIRP, watts-to-dBm, frequency-hopping tax
- `propagation.py` — Dual-slope path loss model (smooth 20→40 log blend across 0.5–2.0 km transition), clutter/terrain loss, received power, jamming evaluation, and sensing distance
- `elevation.py` — Elevation profile fetching, LOS checking, knife-edge diffraction (ITU-R)
- `antenna.py` — Directional antenna gain pattern, bearing calculations

**Frontend** (`static/js/map_logic.js`, ~1,200 lines, vanilla JS):
- Leaflet.js map with OpenStreetMap and Esri Satellite tile layers
- Interactive placement of red (enemy) and blue (friendly) nodes
- Link creation between nodes triggers RF calculations via API calls
- Workbench panel for managing multiple nodes simultaneously
- MGRS coordinate display for all placed icons

**Template** (`templates/index.html`): Single-page app; all JS/CSS loaded from `static/`.

## Key Design Decisions

- **Dual-slope propagation model**: path loss switches from free-space (20 log distance) to terrain-masked (40 log distance) at 1 km. This conservative estimate is intentional.
- **No database**: all state is client-side (Leaflet map markers/layers); the backend is purely stateless calculation.
- **Frequency-hopping tax**: applies a configurable dB penalty when hopping waveforms are selected.
- **Clutter loss**: terrain type (urban, suburban, open) adds attenuation on top of path loss.
- **Directional antenna support**: nodes can be configured with azimuth and beamwidth; gain is reduced for off-boresight links using a Gaussian pattern approximation.
- **Antenna height AGL**: per-node height (metres) adjusts the effective endpoint elevation in the LOS/diffraction calculation only. Path loss is still computed with a ground-level assumption by design.
- **Common area detection overlay**: computes the geographic overlap between multiple ES detection rings to identify jointly-observable areas.
- **Security headers** are set in `app.py` but there is no authentication — deploy only on trusted/air-gapped networks.
