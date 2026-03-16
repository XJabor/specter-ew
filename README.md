# EW Planner

A tactical Electronic Warfare planning tool for EA/ES mission analysis. Runs locally in the browser — no internet required.

![Specter Interface](images/ui-screenshot.png)

## Features

- **Jamming effectiveness (J/S margin)** — calculates jammer-to-signal ratio at the enemy receiver
- **Sensing distance rings** — visualizes ES detection range for threat awareness
- **Dual terrain support** — switch between line-of-sight (free space) and terrain-masked propagation models
- **Frequency-hopping tax** — applies a configurable jamming penalty for frequency-hopping waveforms
- **Interactive map** — 3-click placement workflow on a Leaflet map

## Requirements

- Python 3.12+
- Flask 3.0.0

## Setup

```bash
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Open `http://localhost:5000` in your browser.

## Usage

1. **Click once** on the map to place the Enemy Transmitter (TX)
2. **Click again** to place the Enemy Receiver (RX)
3. **Click a third time** to place your Jammer

The tool calculates J/S margin at the enemy RX and displays sensing rings showing ES detection threat radius. Adjust platform parameters in the sidebar and recalculate instantly.

## Field Deployment

The server binds to `0.0.0.0:5000`, making it accessible to other devices on the local network:

```
http://<host-ip>:5000
```

Debug mode is disabled. Use on a **trusted network only** (tactical LAN, isolated hotspot, etc.).

> **Security note:** This tool has no authentication and is not hardened for internet-facing deployment. Do not expose it on a public network without adding authentication and HTTPS.
