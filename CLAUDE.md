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

**Backend** (`app.py` + `core/`): Stateless Flask REST API with two calculation endpoints:
- `POST /calculate_ea` — Electronic Attack: computes J/S margin (jamming effectiveness)
- `POST /calculate_es` — Electronic Support: computes sensing/detection range

**Core physics** (`core/`):
- `link_budget.py` — EIRP, watts-to-dBm, frequency-hopping tax
- `propagation.py` — Dual-slope path loss model (20 log for <1km, 40 log for >1km), clutter/terrain loss, received power, jamming evaluation, and sensing distance

**Frontend** (`static/js/map_logic.js`, ~900 lines, vanilla JS):
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
- **Security headers** are set in `app.py` but there is no authentication — deploy only on trusted/air-gapped networks.
