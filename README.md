# Specter EW Planning Tool

A tactical Electronic Warfare planning tool for EA/ES mission analysis. Runs locally in the browser.

![Specter Interface](images/ui-screenshot.png)

## Features

- **Jamming effectiveness (J/S margin)** — calculates jammer-to-signal ratio at the enemy receiver
- **Elevation-aware propagation** — queries the Open-Elevation API to compute line-of-sight status and knife-edge diffraction loss (ITU-R P.526) for each jamming link; EA results include an LOS/NLOS badge and the diffraction penalty applied
- **Terrain-shaped detection rings** — ES sensing range is rendered as an azimuthal polygon rather than a uniform circle, shrinking in directions blocked by terrain; falls back to a circle if the elevation API is unreachable
- **Directional antenna support** — each node can be configured as omni or directional via its popup; enter boresight azimuth (True North) and half-power beamwidth. Effective gain is computed per bearing using a Gaussian beam model with a −20 dB sidelobe floor, affecting both J/S margin and the shape of detection rings
- **Clutter terrain types** — manual terrain category (free space, rural, light forest, dense forest) applies a frequency-dependent clutter loss on top of the elevation-derived diffraction
- **Frequency-hopping tax** — applies a configurable jamming penalty for frequency-hopping waveforms
- **Per-node naming and MGRS labels** — nodes can be renamed; permanent MGRS grid labels and elevation readouts are displayed above each marker on the map
- **Workbench** — place multiple red (enemy) and blue (friendly) nodes, link them individually or all at once, rename them, and remove links via the ✕ buttons in the link status table; click any row to highlight the corresponding link on the map
- **Node overlap analysis** — select two or more active detection rings to compute and highlight their common coverage area in yellow, with MGRS coordinates at each corner vertex

## Requirements

- Python 3.12+
- Flask 3.0.0
- requests 2.28+
- shapely 2.0+

## Install and Setup

```bash
git clone https://github.com/XJabor/specter-ew.git
cd specter-ew
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip3 install -r requirements.txt
python3 app.py
```

Open `http://localhost:5000` in your browser.

## Usage

1. Select **Enemy Node** or **Friendly Node** and click the map to place them
2. Link enemy nodes individually or select **Link All Enemy Comms** in the Workbench
3. Left-click an enemy node and select **Show Detection Ring** if desired
4. Left-click a friendly node, select **Link to Target**, then click the enemy node to target

Additional controls available from any node popup:
- **Rename Node** — set a custom label (shown in MGRS tooltips and the results table)
- **Antenna** — switch between Omni and Directional; if Directional, enter the boresight azimuth (° True North) and beamwidth (° HPBW)

Adjust platform parameters in the left sidebar and all links recalculate instantly.

## Field Deployment

The server binds to `0.0.0.0:5000`, making it accessible to other devices on the local network:

```
http://<host-ip>:5000
```

Debug mode is disabled. Use on a **trusted network only** (tactical LAN, isolated hotspot, etc.).

### Authentication

Password protection is supported for deployments outside a trusted network. Setup details are not documented here — contact the project maintainer for configuration guidance.

> **Security note:** Password protection must be paired with HTTPS to be effective. Always place the server behind a TLS-terminating reverse proxy (e.g. nginx) for any internet-facing deployment.

### Disclaimer
This application was built with AI assistance. The propagation models are conservative estimates. Use results at your own risk.
