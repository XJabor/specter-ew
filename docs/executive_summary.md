# Executive Summary: Specter-EW Planning Tool

## BLUF (Bottom Line Up Front)

**Specter-EW** is a browser-based tactical Electronic Warfare planning aid for estimating jamming effectiveness, sensing exposure, and RF coverage over real terrain. It combines link-budget calculations, frequency-aware propagation models, antenna patterns, and elevation profiles to give operators a more useful estimate than uniform circles or free-space assumptions alone.

Specter-EW is a decision-support tool, not a substitute for field measurements, spectrum analysis, or authoritative mission-planning systems.

## The Problem

Tactical EW planning is often reduced to generic coverage circles or flat-terrain calculations. Those shortcuts can hide important effects: terrain may block a jammer, low-frequency signals may propagate farther than expected, directional antennas may expose only part of an area, and friendly emitters may be detectable from unexpected bearings.

## The Specter Approach

Specter-EW places friendly, enemy, reference, and Electronic Protection nodes on an interactive map. Its backend calculates received power, jammer-to-signal margin, sensing distance, terrain obstruction, and geographic overlap. Elevation lookup is local-first: DTED Level 2 data is used when available, with SRTM 30 m data from OpenTopoData used for uncovered points.

### Operational Views

- **Electronic Attack (EA):** Calculates the received enemy signal, received jammer signal, and resulting J/S margin at a target receiver. User-configurable thresholds classify the estimated result as No Effect, Warbling/Contested, or Complete Jamming.
- **Electronic Support (ES):** Produces terrain-shaped sensing polygons that estimate where an emitter may be detected by a configured sensor.
- **Jammer Footprints:** Displays a terrain- and bearing-aware received-power boundary for a jammer. This is a coverage estimate referenced to the configured sensitivity threshold; it is not, by itself, proof of successful jamming.
- **Electronic Protection (EP):** Models multiple friendly subsystems at a shared node and displays separate terrain-aware exposure rings, helping planners assess where friendly emissions may be observed.
- **Overlap Analysis:** Highlights areas covered by multiple active sensing polygons, identifying jointly observable or higher-exposure areas.

### Key Capabilities

- **Hybrid propagation engine:** Routes VHF/UHF, elevated UHF, upper-UHF low-antenna, and SHF links through different calibrated model branches.
- **Terrain-aware analysis:** Uses antenna height, 4/3-Earth geometric LOS, dominant-obstruction knife-edge loss, clutter corrections, and SHF canopy penalties.
- **Directional antennas:** Applies bearing-dependent gain using boresight azimuth and half-power beamwidth.
- **Tactical coordinates and export:** Supports MGRS placement and KML export for use in Google Earth, ATAK, and compatible GIS tools.
- **Local geospatial data:** Indexes DTED Level 2 elevation and GeoTIFF imagery, reducing reliance on external elevation and imagery services where local coverage exists.
- **Flexible deployment:** Runs from source or packaged Windows, Linux, and macOS builds; supports local-only, trusted-LAN, and hosted HTTPS deployments.
- **Authentication choices:** Supports Clerk JWT authentication for hosted deployments and session-based credentials for LAN deployments. Loopback access is intentionally allowed without authentication.

## Operational Limitations

Propagation results are estimates derived from empirical and theoretical models. Accuracy depends on input power, antenna characteristics, terrain classification, elevation quality, atmospheric conditions, vegetation, structures, and receiver behavior. Local data does not make the entire interface fully offline: external JavaScript libraries and online base-map layers may still require network access unless separately cached or replaced.

Copyright (C) 2026 John E. Plaziak. Licensed under the GNU Affero General Public License version 3; see the repository `LICENSE` file.
