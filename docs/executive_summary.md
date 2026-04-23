# Executive Summary: Specter-EW Planning Tool

## BLUF (Bottom Line Up Front)
**Specter-EW** is a standalone, browser-based tactical Electronic Warfare (EW) planning tool. It allows armored and ground maneuver elements to rapidly visualize friendly jamming effects (Electronic Attack) and enemy detection capabilities (Electronic Support) over real-world terrain. It replaces guesswork with mathematically rigorous, terrain-aware RF modeling.

## The Problem
Historically, tactical EW planning has relied on flat-earth assumptions or generic "circles on a map." This leads to severe operational blind spots: assuming a friendly jammer is suppressing an enemy when a mountain actually blocks the signal, or assuming friendly comms are safe from enemy detection because VHF ground-wave propagation was not accounted for.

## The Specter Solution
Specter-EW solves this by integrating a high-fidelity physics engine with real-time satellite elevation data (SRTM 30m). When an operator places a node on the map, Specter calculates how the electromagnetic wave interacts with the specific hills, valleys, and clutter of that exact environment.

### Operational Impact
* **Electronic Support (ES) - Threat Detection:** Operators can drop an enemy receiver on the map to instantly draw its "Detection Ring." Specter shapes this polygon around the terrain, showing exactly where blue forces can operate without being detected. 
* **Electronic Attack (EA) - Jamming Footprints:** Commanders can visualize exactly what area a friendly jammer is suppressing. The "Jammer Footprint" ensures the target is neutralized while visually confirming that adjacent friendly units won't suffer fratricide from signal bleed-over.
* **Overlap Analysis:** Identifies geographic "kill boxes" where multiple enemy sensors have overlapping coverage, allowing commanders to route forces through electromagnetic dead space.

### Key Capabilities
* **Terrain & Elevation Aware:** Automatically pulls elevation data to calculate Line-of-Sight (LOS) and mountain diffraction.
* **Tactical Integration:** Supports MGRS coordinates natively for rapid node placement and exportable KML files for integration into ATAK or Google Earth. 
* **Platform Agnostic:** Handles dismounted VHF radios, mast-mounted UHF sites, and SHF drone/Wi-Fi links with specifically calibrated physics models for each.
* **Rapid Deployment:** Runs locally on a tactical LAN or hosted environment, requiring minimal computing overhead.
