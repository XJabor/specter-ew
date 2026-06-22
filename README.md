# Specter EW Planning Tool

A tactical Electronic Warfare planning tool for EA/ES mission analysis. Runs locally in the browser.

![Specter Interface](images/ui-screenshot.png)

## Features

- **Jamming effectiveness (J/S margin)** — calculates jammer-to-signal ratio at the enemy receiver
- **Elevation-aware propagation** — uses local DTED Level 2 (30m) when available, falling back to the Open-Topo-Data API (SRTM 30m) for uncovered areas; computes line-of-sight status and Deygout multiple knife-edge diffraction loss (ITU-R P.526) for each jamming link; EA results include an LOS/NLOS badge and the diffraction penalty applied
- **Terrain-shaped detection rings** — ES sensing range is rendered as an azimuthal polygon rather than a uniform circle, shrinking in directions blocked by terrain; falls back to a circle if the elevation API is unreachable. Quality adapts to data source: **72 bearings × 25 samples** when local DTED L2 covers the area (near-instant); **36 bearings × 11 samples** when falling back to the API (~4 seconds, 4 API requests). Subsequent renders of the same area are instant from cache regardless of source
- **Jammer footprint** — toggle "Show Jammer Footprint" on any friendly node to display a terrain-shaped cyan polygon showing the jammer's effective coverage area per bearing, using the same reference sensitivity as ES detection rings. Directional antennas produce the expected teardrop lobe; omni antennas produce a roughly circular footprint. Falls back to a uniform circle if the elevation API is unreachable
- **Directional antenna support** — each node can be configured as omni or directional via its popup; enter boresight azimuth (True North) and half-power beamwidth. Effective gain is computed per bearing using a Gaussian beam model with a −20 dB sidelobe floor, affecting J/S margin, the shape of detection rings, and the shape of jammer footprints
- **Antenna height AGL** — each node has a configurable height above ground level (meters). Height is applied to the LOS/diffraction calculation so a mast-mounted antenna can correctly clear terrain obstacles that a ground-level node would not, and also gates the propagation model — tx height ≥ 30 m enables COST-231 Hata and Two-Ray Ground Reflection for UHF frequencies
- **Configurable capture effect thresholds** — the J/S margin boundaries for No Effect, Warbling, and Complete Jamming are adjustable in the sidebar to match the target receiver type (analog vs. digital); link colors and workbench row colors update instantly when thresholds change
- **Range sanity warning** — a warning appears in the workbench when any jamming link or detection ring exceeds 50 km, flagging that Earth curvature is not modeled at those ranges
- **Multi-band propagation routing** — terrain type (free space, rural, light forest, dense forest) applies calibrated corrections across every frequency band: Egli empirical for VHF/UHF ground forces (flat penalty of +8 dB light / +20 dB dense vs. rural); COST-231 Hata for elevated UHF stations; Two-Ray Ground Reflection for confirmed LOS at UHF; and an ITU-R P.833 foliage/clutter model for SHF (>2 GHz) drone and ISM-band links (2.0 / 5.0 dB/GHz·km for light/dense terrain, plus a near-ground canopy penalty when antennas are below 5 m AGL). SHF sensing distance is capped at the geometric radio horizon; VHF/UHF Egli propagates at 40 dB/decade with no artificial ceiling. SHF NLOS paths apply the Deygout blockage penalty, correctly treating terrain as an opaque barrier
- **Frequency-hopping tax** — applies a configurable jamming penalty for frequency-hopping waveforms
- **Per-node naming and MGRS labels** — nodes can be renamed; permanent MGRS grid labels and elevation readouts are displayed above each marker on the map; all icon types have an inline MGRS input field in their popup — type a grid string and press Enter (or Go) to jump the icon to that location
- **Marker icons** — a third icon type (black) can be placed as a reference point; shows a permanent MGRS label, supports rename and move-to-MGRS, and has no RF or link features
- **EP (Electronic Protection) mode** — a separate workbench mode for friendly force analysis. Place EP nodes on the map, add named sub-systems to each node (each with its own frequency, TX power, and gain), then click Calculate to generate terrain-aware detection rings for every system. Rings are color-coded per system from a fixed palette. Universal parameters (terrain type, enemy RX sensitivity) live in the sidebar. Switch between EA and EP modes with the EP button in the workbench header; all node types coexist when switching
- **Workbench** — place red (enemy), blue (friendly), and black (marker) nodes, link them individually or all at once, rename them, and remove links via the ✕ buttons in the link status table; click any row to highlight the corresponding link on the map
- **Node overlap analysis** — select two or more active detection rings to compute and highlight their common coverage area in yellow, with MGRS coordinates at each corner vertex
- **KML export** — exports the current map state to a `.kml` file from the Workbench. Includes enemy and friendly node placemarks, enemy comms links, jamming links (colored by J/S margin), ES detection ring polygons, and overlap zones. A second export option includes midpoint distance labels on all links and detection range labels on each ring, for use in Google Earth, ATAK, or any KML-compatible tool

## Requirements

- Python 3.12+
- Flask 3.0.0
- requests 2.28+
- shapely 2.0+
- flask-wtf 1.2+
- flask-limiter 3.5+
- rasterio 1.3+ *(local DTED and imagery support)*
- Pillow 9.0+ *(local imagery tile rendering)*
- PyJWT 2.4+ *(Clerk JWT verification for hosted deployments)*
- cryptography 41.0+ *(RSA key support for JWT)*

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

Native Windows, Linux, and macOS executable builds are documented in
[`docs/cross_platform_executables.md`](docs/cross_platform_executables.md) and
[`docs/windows_exe.md`](docs/windows_exe.md). Tagged `v*` releases are built
natively for all supported platforms by GitHub Actions.

## Usage

### EA/ES Mode (default)

1. Select **Enemy Node**, **Friendly Node**, or **Marker** and click the map to place them
2. Link enemy nodes individually or select **Link All Enemy Comms** in the Workbench
3. Left-click an enemy node and select **Show Detection Ring** if desired
4. Left-click a friendly node and select **Show Jammer Footprint** to visualize its coverage area (optional)
5. Left-click a friendly node, select **Link to Target**, then click the enemy node to target

Additional controls available from any node popup:
- **Rename Node** — set a custom label (shown in MGRS tooltips and the results table)
- **MGRS** — inline input field pre-filled with the node's current grid; edit and press Enter or Go to move the icon to that location
- **Antenna** — switch between Omni and Directional; if Directional, enter the boresight azimuth (° True North) and beamwidth (° HPBW) *(red and blue nodes only)*
- **Height AGL** — set the antenna height above ground level in meters (affects LOS/diffraction only) *(red and blue nodes only)*

Adjust platform parameters in the left sidebar and all links recalculate instantly.

### EP Mode

1. Click the **EP** button in the workbench header to switch to EP mode
2. Click **Place EP Node** and click the map to place a friendly node
3. In the workbench card, click **+ Add System** and configure each system's name, frequency, TX power, and gain
4. Click **Calculate** to generate terrain-aware detection rings for all systems on that node
5. Left-click the EP node icon on the map to rename or delete it

Set terrain type and enemy RX sensitivity in the left sidebar. All node types (red, blue, black, EP) coexist — switching modes does not clear the map.

## Local Geospatial Data

Specter can use local elevation and imagery files instead of (or in addition to) the online API, enabling offline operation and higher ring quality.

### DTED Elevation

Place DTED **Level 2** (`.dt2`, 30m) files in the `local_data/` directory using the standard military directory layout:

```
local_data/
  w094/
    n29.dt2
    n30.dt2
  w095/
    n29.dt2
```

Only Level 2 is indexed. Level 0 (900m) and Level 1 (90m) are intentionally excluded — their post spacing is too coarse for accurate diffraction calculations, and the fallback API (SRTM 30m) provides equivalent or better quality for areas without L2 coverage.

Free DTED L2 for CONUS is available from the [USGS National Map Downloader](https://apps.nationalmap.gov/downloader/) under *Elevation Products (3DEP) → 1/3 arc-second → GeoTIFF* (note: USGS 3DEP GeoTIFFs are not in DTED format — DTED L2 files must be sourced separately from NGA or similar).

### Imagery

Place GeoTIFF imagery (`.tif`, `.tiff`) anywhere under `local_data/`. Files are served as XYZ map tiles via an overlay layer in the layer control.

### Configuring the Data Directory

The default data directory is `local_data/` inside the app folder. To use an external drive or alternate path:

- **Environment variable** (recommended for fixed deployments): set `LOCAL_DATA_DIR=/path/to/data` before starting the app — the path is locked and cannot be changed via the UI
- **UI** (localhost only): a *Local Data Directory* panel appears in the sidebar when accessing from `127.0.0.1`; enter the path and click Apply, or click Rescan after adding new files

The configured path is persisted in `specter_config.json` across restarts.

## Field Deployment

The server binds to `0.0.0.0:5000`, making it accessible to other devices on the local network:

```
http://<host-ip>:5000
```

Debug mode is disabled. Use on a **trusted network only** (tactical LAN, isolated hotspot, etc.).

### Authentication

Specter supports two authentication modes depending on the deployment target.

#### Hosted / HTTPS deployments — Clerk

Public-facing deployments use [Clerk](https://clerk.com) for sign-in. Clerk handles the login UI and issues short-lived JWTs that the server verifies on every request — no server-side session storage required.

| Variable | Description |
|----------|-------------|
| `CLERK_PUBLISHABLE_KEY` | Your Clerk production publishable key (`pk_live_...`). Setting this activates Clerk auth and disables the `APP_CREDENTIALS` path. The Frontend API URL is derived from the key automatically. |
| `CLERK_FRONTEND_API` | Optional override for the Clerk Frontend API URL. Only needed if automatic derivation from the publishable key fails (e.g. custom domain configurations). |
| `SPECTER_HTTPS` | Set to `true` when serving over TLS. Enables the `Secure` flag on session cookies. **Do not set on plain-HTTP deployments.** |

Setup steps:
1. Create a **production** instance in the [Clerk dashboard](https://dashboard.clerk.com) (development instances only work on `localhost`)
2. Add your domain (e.g. `specter-ew.com`) under Configure → Domains
3. Add the required DNS records at your DNS provider — set any CNAME records to **DNS only (grey cloud)** if using Cloudflare
4. Set `CLERK_PUBLISHABLE_KEY` in your server's environment and restart

#### LAN / HTTP deployments — APP_CREDENTIALS

Local network deployments use simple username/password authentication via environment variables.

| Variable | Description |
|----------|-------------|
| `APP_CREDENTIALS` | Enables login. Format: `user:pass` or `user1:pass1,user2:pass2`. If unset, the app is open to anyone who can reach it. |
| `FLASK_SECRET_KEY` | Signs session cookies. Generate one with: `python3 -c "import secrets; print(secrets.token_hex(32))"`. Required when `APP_CREDENTIALS` is set — without it, each server worker uses a different key, causing random logouts. |

Example:
```bash
export APP_CREDENTIALS="alice:correcthorsebatterystaple,bob:hunter2"
export FLASK_SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
python3 app.py
```

> **Security note:** `APP_CREDENTIALS` transmits passwords in plaintext over HTTP. For any internet-facing deployment, use Clerk (HTTPS) instead.

#### Localhost bypass

Requests from `127.0.0.1` or `::1` always bypass authentication — both Clerk and `APP_CREDENTIALS`. This allows local development without credentials.

### Disclaimer
This application was built with AI assistance. The propagation models (Egli, COST-231 Hata, Two-Ray Ground Reflection, FSPL + ITU-R P.833 foliage) are empirical or theoretical approximations. Use results at your own risk.

## License

Copyright &copy; 2026 John E. Plaziak.

Specter EW is free software: you may redistribute it and/or modify it under the
terms of the [GNU Affero General Public License version 3](LICENSE), as published
by the Free Software Foundation. Modified versions made available over a network
must offer their corresponding source code as required by the AGPL.

This software is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for details.

Versions released before this license change remain available under the license
included with those releases.

## Commercial Licenses

Organizations that prefer not to operate under AGPL-3.0 may obtain a separate
commercial license. For pricing and licensing inquiries, contact
[licensing@specter-ew.com](mailto:licensing@specter-ew.com).

## Contact

For general inquiries, contact
[contact@specter-ew.com](mailto:contact@specter-ew.com).
