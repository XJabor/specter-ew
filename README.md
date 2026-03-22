# Specter EW Planning Tool

A tactical Electronic Warfare planning tool for EA/ES mission analysis. Runs locally in the browser.

![Specter Interface](images/ui-screenshot.png)

## Features

- **Jamming effectiveness (J/S margin)** — calculates jammer-to-signal ratio at the enemy receiver
- **Sensing distance rings** — visualizes ES detection range for threat awareness
- **Dual terrain support** — switch between line-of-sight (free space) and terrain-masked propagation models
- **Frequency-hopping tax** — applies a configurable jamming penalty for frequency-hopping waveforms
- **Workbench** — select multiple blue and red icons to place on the map. Link red nodes individually or link all nodes automatically. Select individual links to highlight it on the map
- **Interactive map** — move all icons freely on a Leaflet map that automatically calculates distance

## Requirements

- Python 3.12+
- Flask 3.0.0

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

1. Select Enemy Node or Friendly Node and click on the map where you want to place them
2. Link Enemy Nodes individually or by selecting "Link All Enemy Comms" in the Workbench
3. Left-Click Enemy Node and select "Show Detection Ring" if desired
3. Left-Click Friendly Icon, select "Link to Target", then select your desired Enemy Node to target

- Left-Click Enemy Node: Link Enemy Comms, Toggle Detection Ring, Remove Node
- Left-Click Friendly Node: Link to Target (then click your target to calculate EA), Remove Node

The tool calculates J/S margin at the enemy RX and displays sensing rings showing ES detection threat radius. Adjust platform parameters in the sidebar and recalculate instantly.

## Field Deployment

The server binds to `0.0.0.0:5000`, making it accessible to other devices on the local network:

```
http://<host-ip>:5000
```

Debug mode is disabled. Use on a **trusted network only** (tactical LAN, isolated hotspot, etc.).

> **Security note:** This tool has no authentication and is not hardened for internet-facing deployment. Do not expose it on a public network without adding authentication and HTTPS.

### Disclaimer
This application was built with AI. These models are conservative estimates. Use these estimates at your own risk.

### To Do
- Offline mode
- Account for elevation data in EA and ES links
