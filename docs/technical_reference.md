# Technical Reference and Physics Engine

## 1. System Architecture

Specter-EW uses a stateless Flask REST backend with a vanilla JavaScript and Leaflet frontend. Map state, nodes, links, and rendered overlays remain client-side; the backend performs calculations and geospatial sampling without a database.

The calculation engine uses a hybrid empirical-deterministic propagation model. Model selection depends on frequency, terrain type, transmitter antenna height, and LOS state. Path-loss results are never allowed below the free-space path-loss floor.

## 2. Propagation Routing Matrix

| Conditions | LOS model | NLOS model | Sensing-range behavior |
|---|---|---|---|
| Free-space/aerial terrain, up to 2 GHz | FSPL | FSPL | No terrain correction; upper-UHF aerial paths are exempt from the ground horizon cap |
| Below 1 GHz and COST-231 invalid | Egli + flat terrain correction | Egli + terrain correction + obstruction loss | No artificial horizon cap |
| 1-2 GHz, transmitter below 30 m | FSPL + flat terrain correction | FSPL + terrain correction + obstruction loss | Capped at the 4/3-Earth radio horizon unless free-space/aerial |
| 150 MHz-2 GHz, transmitter at least 30 m | Two-Ray Ground Reflection | COST-231 Hata + obstruction loss | Closed-form inverse of the selected model |
| Above 2 GHz | FSPL + SHF clutter + near-ground penalty | Same baseline + obstruction penalty | Binary search when clutter is nonzero; capped at the 4/3-Earth radio horizon |

`_cost231_valid()` requires frequency at least 150 MHz and transmitter height at least 30 m AGL. The SHF branch is selected first for frequencies above 2 GHz. Frequencies below 1 GHz that do not meet the COST-231 gate use Egli; its intended calibration region is tactical VHF/UHF, approximately 40-900 MHz.

### Model Details

- **Egli:** Uses a 40 dB/decade distance slope, actual antenna heights floored at 1 m, a terrain correction, and an FSPL floor. It is used for low-antenna tactical VHF/UHF links.
- **Upper-UHF FSPL branch:** Avoids extending Egli above its calibrated band, where Egli can over-predict loss. Ground paths receive the same flat terrain corrections as Egli.
- **Two-Ray:** Used for confirmed LOS paths in the COST-231-valid domain. Its distance term follows a 40 dB/decade slope and retains an FSPL floor.
- **COST-231 Hata:** Used for NLOS paths in the valid elevated-antenna domain, with rural, suburban/light, and urban/dense corrections.
- **SHF:** Uses FSPL plus a distance- and frequency-proportional clutter term. When either endpoint is below 5 m AGL, vegetated/cluttered terrain receives an additional near-ground penalty.

## 3. Terrain and Clutter Corrections

| Terrain type | Egli / upper-UHF FSPL | SHF clutter coefficient | SHF near-ground penalty below 5 m AGL |
|---|---:|---:|---:|
| Free Space / Aerial | 0 dB | 0 dB/GHz-km | 0 dB |
| Rural / Open | 0 dB | 0 dB/GHz-km | 0 dB |
| Light Forest / Suburban | +8 dB | 2.0 dB/GHz-km | +5 dB |
| Dense Forest / Urban | +20 dB | 5.0 dB/GHz-km | +10 dB |

Terrain keywords use substring matching consistently across model branches. Egli and upper-UHF corrections are flat additive losses. SHF clutter increases with frequency and distance; its near-ground penalty is flat.

## 4. Elevation and Local-Data Pipeline

Elevation requests follow a local-first, partial-fallback pipeline:

1. The local-data scanner indexes DTED Level 2 (`.dt2`) cells using their standard latitude/longitude directory layout.
2. Requested points covered by indexed DTED are sampled locally through Rasterio.
3. Only uncovered points are submitted to the OpenTopoData SRTM 30 m endpoint.
4. Profiles are cached by rounded endpoints and sample count to avoid repeat requests after parameter-only changes.

DTED Levels 0 and 1 are intentionally excluded because their post spacing is too coarse for the terrain-obstruction analysis. GeoTIFF files other than DTED are indexed by WGS84 bounds and rendered as 256 x 256 Web Mercator map tiles.

Sampling adapts to the calculation:

- Point-to-point EA links use 48 samples through 5 km, 72 samples through 15 km, and 96 samples beyond 15 km.
- ES rings and jammer footprints use 72 bearings x 25 samples when the complete projected area has local DTED coverage.
- When online elevation is required, rings use 36 bearings x 11 samples to respect the public API's 100-location and one-request-per-second limits.

If terrain retrieval fails, point-to-point EA reports a terrain warning and uses non-terrain path loss. Terrain rings fall back to their calculated circular range.

## 5. LOS, Earth Curvature, and Obstruction Loss

Geometric LOS uses endpoint terrain elevation plus antenna height AGL and a 4/3 effective-Earth radius of 8,500 km. Interior samples include Earth bulge; an obstruction greater than 1 m above the LOS line marks the path NLOS.

For an NLOS profile, the engine selects the sample with the highest Fresnel-Kirchhoff parameter and applies the ITU-R P.526 knife-edge approximation for that dominant obstruction. This is intentionally not a recursive multiple-edge Deygout sum. Recursive treatment caused a smooth sampled ridge to be counted as many independent edges and could produce unrealistic losses above 100 dB.

Terrain-ring walking applies obstruction loss only when terrain itself rises above the straight geometric endpoint line. Earth-bulge-only obstruction does not add knife-edge loss in this path because the empirical ground models already include long-range rolloff; applying both would double-count curvature.

At SHF, the computed knife-edge value is treated as blockage severity rather than useful bending around terrain.

## 6. Radio-Horizon and Inverse Calculations

- **Egli VHF/UHF:** No hard horizon cap. Its 40 dB/decade slope provides natural rolloff, with the FSPL floor preserving physical plausibility.
- **Upper-UHF low-antenna ground paths:** Capped at one 4/3-Earth radio horizon because meaningful ground-wave propagation is not assumed.
- **SHF:** Capped at one 4/3-Earth radio horizon.
- **Free-space/aerial terrain:** Exempt from the upper-UHF ground horizon cap.

`calculate_sensing_distance()` mirrors the routing in `calculate_path_loss()`. It uses closed-form inverses for FSPL, Egli, Two-Ray, and COST-231 Hata. SHF clutter adds a linear distance term, so that branch uses a monotonic binary search.

## 7. Link Budgets and Antennas

- **EIRP:** Transmit power is converted from watts to dBm and combined with effective antenna gain.
- **Directional gain:** A Gaussian horizontal pattern reduces gain away from boresight, with a -20 dB sidelobe floor. Bearing-specific gain affects EA links, ES rings, and jammer footprints.
- **Frequency-hopping tax:** When enabled, the jammer budget is reduced by `10 log10(jammer bandwidth / target channel bandwidth)`.
- **J/S margin:** Received jammer power minus received enemy-signal power is compared with configurable lower and upper thresholds.
- **Jammer footprint:** Its boundary is where estimated received jammer power reaches the configured reference sensitivity. It is not a J/S-success contour because it does not include a target signal at every polygon point.
- **Antenna height:** Per-node AGL height changes endpoint geometry and determines whether the COST-231/Two-Ray gate is available.

## 8. Map Products and Geometry

- ES rings and jammer footprints are bearing-sampled polygons shaped by antenna gain and terrain.
- EP nodes can contain multiple named systems; each system receives its own terrain ring and color. Calculations run sequentially to remain within the public elevation API rate limit.
- Shapely intersects two or more active sensing polygons for common-area analysis, including MultiPolygon results.
- KML exports include configured nodes, links, rings, overlaps, and optional labels for compatible GIS applications.
- Black marker nodes are reference-only and never trigger RF or elevation calculations.

## 9. Deployment, Authentication, and Runtime Data

The same Flask application runs from source and from PyInstaller packages for Windows, Linux x86_64, macOS Intel, and macOS Apple Silicon. Packaged templates, static assets, and the AGPL license are read from the bundle; `specter_config.json` and external local data remain outside the extracted bundle.

Hosted HTTPS deployments can use Clerk RS256 JWT verification. Trusted-LAN deployments can use session credentials from `APP_CREDENTIALS` with a required stable `FLASK_SECRET_KEY`. Requests arriving from `127.0.0.1` or `::1` bypass authentication by design. Local data-directory administration endpoints are loopback-only.

## 10. Model Boundaries

Specter-EW provides planning estimates, not validated site-survey predictions. The models do not explicitly resolve buildings, weather, atmospheric ducting, polarization mismatch, antenna installation loss, receiver implementation details, or time-varying interference. Terrain categories approximate clutter and vegetation rather than deriving them from land-cover rasters. Elevation accuracy and sample spacing can materially change obstruction results.

Geometric LOS includes Earth curvature, but very long propagation paths remain model-sensitive; the interface warns when links or rings exceed 50 km. Results should be checked against field measurements and authoritative tools when operational risk is high.

Copyright (C) 2026 John E. Plaziak. Licensed under the GNU Affero General Public License version 3; see the repository `LICENSE` file.
