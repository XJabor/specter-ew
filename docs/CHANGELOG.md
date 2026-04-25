-----
24APR26

- Added terrain-type correction factors to the Egli model (VHF/UHF, 30–999 MHz): terrain selection now meaningfully reduces detection range for light forest (+8 dB penalty, ~37% range reduction) and dense forest/urban (+20 dB, ~70% reduction) relative to open/rural; previously all non-free-space terrain produced identical results in this band
- Applied the same flat terrain correction to the upper-UHF FSPL branch (1000–2000 MHz, low antennas), closing a gap where the terrain selector had no effect on 1–2 GHz ground-level signals
- Raised SHF clutter absorption coefficients to values calibrated against empirical woodland measurements: light forest/suburban 1.0 → 2.0 dB/GHz·km; dense forest/urban 2.4 → 5.0 dB/GHz·km (gives ~12 dB/km effective attenuation at 2.4 GHz through dense forest vs. ~6 dB/km previously)
- Added SHF near-ground canopy penalty: when either antenna is below 5 m AGL in vegetated terrain, an additional flat loss is applied (+10 dB dense, +5 dB light) to model Fresnel-zone obstruction and canopy-entry absorption at microwave frequencies; free-space/rural paths and elevated terminals (≥ 5 m) are unaffected
- Net effect on the reported scenario (2.4 GHz, 25 W, 1 m antennas, dense forest): detection range reduced from ~4.6 km to ~2.0 km, consistent with empirical data for ground-level SHF propagation in dense pine forest

- Fixed a physics bug where the VHF/UHF signal model (Egli) produced a flat "dead zone" — signals at 30 km and 500 km were incorrectly calculated as identical strength; the model now correctly increases signal loss at all distances
- Fixed a physics bug where a mountain blocking a microwave/SHF signal (e.g. a drone link at 5 GHz) was treated as if it were not there; terrain blockage now correctly applies a large penalty to obstructed SHF paths
- Removed an artificial range ceiling on VHF/UHF detection; the model's natural 40 dB-per-decade rolloff now handles long-range behavior without a hard cutoff
- SHF (microwave) sensing distance retains its strict one-hop horizon cap, as microwaves cannot bend over the Earth's curvature
- Fixed a routing bug where upper UHF signals (1–2 GHz) from low antennas were fed into the Egli model, which is only calibrated for 40–900 MHz; those frequencies now correctly use a free-space baseline, removing a ~25 dB over-penalty that made 2 GHz appear to have a shorter range than 5 GHz
- Fixed a follow-on bug where the free-space baseline for 1–2 GHz had no range cap, producing physically impossible 40+ km detection rings for ground-level antennas; a radio horizon cap (matching the existing microwave/SHF cap) now limits range to what Earth geometry actually allows
- Updated CLAUDE.md and technical reference to document the upper-UHF routing rule

-----

-----
22APR26

- Replaced the old simplified path loss formula with a four-model routing stack based on frequency and antenna height
- VHF/UHF ground forces (e.g. 80 MHz radios, short antennas): now uses the Egli (1957) empirical model, which correctly gives longer range at lower frequencies
- Elevated UHF stations (150–2000 MHz, antenna ≥ 30 m): NLOS paths use COST-231 Hata (accounts for terrain type); confirmed LOS paths use Two-Ray Ground Reflection
- SHF/drone/Wi-Fi links (>2 GHz): uses free-space path loss plus an ITU-R foliage penalty for suburban/urban terrain
- Each model now applies a radio horizon cap — Egli uses 3× horizon to preserve VHF ground-wave range; SHF uses strict 1× (no over-horizon bending at those frequencies)
- Diffraction over terrain obstacles now uses the Deygout method, which sums losses from multiple peaks instead of only the tallest one
- Antenna height now also controls which propagation model is selected (tx height ≥ 30 m required for COST-231/Two-Ray)
- Default antenna height changed to 1.0 m (typical dismounted soldier with a short whip antenna)
- Updated README and internal documentation to reflect the new propagation engine

-----

-----
20APR26

- Added a black "Marker" icon type to the Workbench — purely a reference point with no RF calculations or links
- Marker icons show a permanent MGRS coordinate label above them on the map, just like red and blue icons
- All three icon types (red enemy, blue friendly, black marker) now have an inline MGRS grid input in their popup
- Type a grid reference and press Enter (or the Go button) to instantly jump that icon to the typed location
- Moving a red or blue icon via MGRS input automatically recalculates all linked jamming and detection results
- Added SEO meta description and Open Graph tags to the login page for better search engine visibility
- Added a visible description of Specter EW and a GitHub link below the login box for first-time visitors
- Updated README and internal documentation to reflect the new Marker icon and MGRS input features

-----

-----
18APR26

- Fixed a bug on the login page where the word "None" appeared underneath "AN EW PLANNING TOOL" on every page load
- The fix was a one-word change in how the page handles an empty error message — it now correctly shows nothing when there is no error
- Renamed the "Environment" section in the settings sidebar to "Radio Information"
- Added colored left-side border bars to the "Radio Information" and "Enable Frequency Hopping" tabs, matching the visual style of the other tabs
- "Radio Information" uses a dark green bar; "Enable Frequency Hopping" uses an amber/yellow bar matching its existing label color

-----

-----
16APR26

- Added "Show Jammer Footprint" button to friendly (blue) node popups
- Toggling the footprint draws a cyan polygon on the map showing how far the jammer's signal reaches in each direction
- The polygon is terrain-aware — it shrinks in directions where hills block the signal, just like enemy detection rings
- Directional antennas produce a narrow teardrop lobe; omni antennas produce a roughly circular footprint — useful for verifying antenna settings look correct
- The footprint boundary uses the same receiver sensitivity setting already in the sidebar, keeping results consistent with detection rings
- The footprint automatically refreshes when any sidebar parameter (frequency, power, terrain, etc.) changes or when the node is dragged
- Updated README and internal documentation to reflect the new feature
- Added a collapse button (▼/▶) to the Workbench panel on phones and tablets — tap it to shrink the panel down to just its title bar, freeing up map space
- Tap the arrow again to expand the Workbench back to full size
- Added a close button (✕) inside the settings sidebar on phones and tablets — tap it to dismiss the panel without reaching back to the hamburger menu in the corner
- Both buttons are hidden on desktop where the layout has more room; no change to the desktop experience
- Stylized the login page

-----

-----
15APR26

- Added KML export to the Workbench — downloads the current map as a .kml file compatible with Google Earth, ATAK, and other mapping tools
- Exported KML includes enemy and friendly node markers, enemy comms lines, jamming lines, detection ring polygons, and overlap zones
- Jamming lines are exported in their current color (green, orange, or red) based on the calculated signal margin
- A second export button ("Export KML (w/ Labels)") includes text labels showing distances on all links and detection range on each ring
- Updated README to document the new KML export feature

-----

-----
14APR26

- Added a login page with session-based authentication; credentials are set via the APP_CREDENTIALS environment variable (format: user:pass)
- Fixed a critical bug where the session cookie flag prevented login from working on plain-HTTP local network deployments
- Added CSRF (cross-site request forgery) protection to the login form and rate limiting (10 attempts/minute) to block brute-force attacks
- Added a logout button at the bottom of the sidebar
- Switched the terrain elevation API from Open-Elevation (unreliable, ~10–16s) to Open-Topo-Data (reliable, ~4s); detection rings now consistently return terrain-shaped polygons instead of falling back to plain circles
- Optimised the elevation batch request logic so API response time counts against the rate-limit window, reducing unnecessary waiting between requests
- Tuned terrain ring to 36 bearings × 11 elevation samples (396 points, 4 API requests) — full visual precision with minimal propagation accuracy trade-off
- Updated README with full authentication setup instructions and honest notes on terrain ring timing
- Added per-node antenna height above ground level (AGL) — set in meters via each node's popup; raises the effective endpoint height in the line-of-sight calculation so mast-mounted antennas can clear terrain obstacles
- Added configurable capture effect thresholds — operators can now adjust the J/S margin (signal strength difference) boundaries for No Effect, Warbling, and Complete Jamming to match analog or digital target receivers
- Link line colors and workbench row colors now update instantly when thresholds are changed
- Added input validation to prevent the Complete Jamming threshold from being set lower than the No Effect threshold
- Added a range sanity warning in the workbench when any jamming link or detection ring exceeds 50 km, flagging that Earth curvature is not accounted for at those distances
- Fixed a pre-existing bug where J/S margins between -6 and -5 dB were incorrectly reported as Complete Jamming instead of Warbling

-----

-----
13APR26

- Added per-node directional antenna support — each node can be set to omni or directional via its popup
- Directional nodes accept a boresight azimuth (degrees True North) and a beam width (half-power beamwidth)
- Gain falls off using a Gaussian beam pattern with a -20 dB floor outside the main beam
- Jamming calculations now account for whether the jammer falls inside or outside the enemy receiver's beam
- Enemy sensing (detection ring) shape now reflects the TX antenna direction — sector-shaped instead of circular for directional nodes
- Fixed a bug where typing an azimuth value in a node popup would reset to 0 before the value was saved
- Updated the README to reflect all features added since initial release
- Smoothed the dual-slope path loss model transition between free-space and ground-plane regions (0.5–2 km blend zone)

-----

-----
09APR26

- Enemy and friendly map nodes can now be renamed via a new "Rename Node" button in each node's popup menu (max 20 characters)
- Custom node names appear on the map coordinate labels, in popups, and in the workbench link status table
- Added "Overlap Analysis" section to the workbench panel for identifying common detection coverage areas
- Users can select which enemy nodes (that have active detection rings) to include in the analysis
- Clicking "Show Common Coverage" highlights the area where ALL selected nodes can simultaneously detect in yellow
- Overlap calculation is handled server-side using the Shapely geometry library — no browser restrictions
- Added "Show MGRS Corners" toggle that places coordinate labels at every vertex of the overlap zone
- MGRS corner labels are selectable and copyable for use in planning documents
- Added shapely>=2.0 to requirements.txt as a new dependency
- Fixed a security issue where an external map library (Turf.js) was blocked by the app's content security policy

-----

-----
04APR26

- Added a full Content Security Policy (CSP) header to restrict which external resources the browser can load
- Added HSTS, Referrer-Policy, and Permissions-Policy security headers to harden internet-facing deployments
- Added request size limits to prevent oversized payload abuse
- Added coordinate bounds validation to all calculation endpoints to reject malformed GPS inputs
- Added input count and structure validation to the elevation lookup endpoint

-----

-----
03APR26

- Added support for deploying to internet-facing platforms (Heroku/Render) via Procfile and gunicorn web server
- Added HTTP Basic Authentication support for internet-facing deployments with multi-user support
- Each placed node now fetches and displays its real-world elevation (in metres) alongside its MGRS coordinate
- Elevation is re-fetched automatically when a node is dragged to a new position

-----

-----
28MAR26

- Added terrain and elevation awareness to both jamming (EA) and sensing (ES) calculations
- The model now queries a real elevation API to build terrain profiles between nodes
- Line-of-sight analysis accounts for terrain blocking and calculates diffraction loss over obstacles
- Detection rings now reflect actual terrain — shrinking behind hills that block the signal
- Added core/elevation.py to handle all elevation API calls and line-of-sight geometry
- Updated the UI screenshot in the README to reflect current appearance

-----

-----
22MAR26

- Replaced single-node placement with a full Workbench panel supporting multiple enemy and friendly nodes
- Added Link All Enemy Comms quick action to connect all enemy nodes in one click
- Added a Link Status table to the workbench showing jamming margins and effects for all active links
- Results are color-coded: green (complete jamming), orange (partial), red (no effect)
- Added a "Center on Nodes" map button that fits all placed nodes and detection rings into view
- Nodes can now be individually removed via their popup menu

-----

-----
16MAR26

- Fixed a bug where zero or negative values for transmit power and frequency were accepted without error
- Added MGRS (military grid) coordinate labels that appear above every placed node on the map
- Added a compact results bar at the bottom of the screen on mobile showing the best jamming margin
- Improved the mobile layout so the map and controls display correctly on small screens

-----

-----
15MAR26

- Initial public release of Specter EW — a tactical Electronic Warfare planning tool
- Supports jamming effectiveness (J/S margin) calculation between enemy and friendly nodes
- Supports sensing/detection range calculation for enemy receivers
- MIT License added

-----
