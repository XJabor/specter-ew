# Technical Reference & Physics Engine

## 1. System Architecture
Specter-EW is a stateless Flask REST API backend paired with a vanilla JavaScript/Leaflet frontend. The core calculation engine relies on a **hybrid empirical-deterministic propagation model**. Rather than relying on a single, flawed master equation, Specter dynamically routes path loss calculations through specialized mathematical models based on frequency band and antenna height.

## 2. Multi-Band Propagation Routing Matrix
Specter intercepts link parameters and routes them to the most physically accurate model using the following matrix:

* **VHF / Tactical UHF (< 1000 MHz, Antenna < 30m)**
  * **Model:** Egli (1957) Empirical Model + terrain correction.
  * **Why it works:** Captures the unique ground-wave propagation of lower frequencies. Unlike standard models, Egli applies a $20 \log_{10}(f)$ term, mathematically rewarding lower VHF frequencies with longer ranges (e.g., a 25 W 80 MHz dismounted radio reaching ~43 km in the open). Calibrated for 40–900 MHz; Egli is not used above 1 GHz. Terrain type applies a flat additive correction: rural/open +0 dB (Egli's native calibration environment), light forest/suburban +8 dB (~37% range reduction), dense forest/urban +20 dB (~70% range reduction). Corrections are grounded in ITU-R P.833 VHF vegetation edge-effect data and military tactical VHF field measurements.
* **Upper UHF, low antenna (1000 – 2000 MHz, Antenna < 30m)**
  * **Model:** FSPL (Free Space Path Loss) + terrain correction.
  * **Why it works:** Egli was empirically calibrated for the 40–900 MHz VHF/UHF ground band and over-predicts path loss by 20–30 dB at 1–2 GHz relative to measured data. Using the FSPL floor as the baseline eliminates this artifact and ensures a smooth transition into the SHF band (>2 GHz), which also starts from FSPL. The same flat terrain correction as the Egli branch applies (+0 / +8 / +20 dB for open / light / dense), and a strict radio horizon cap prevents physically impossible over-horizon detection.
* **Elevated UHF (150 – 2000 MHz, Antenna ≥ 30m)**
  * **Model (NLOS):** COST-231 Hata. Applies complex corrections for rural, suburban, and dense urban terrain clutter.
  * **Model (LOS):** Two-Ray Ground Reflection. Calculates the interference pattern between the direct line-of-sight wave and the ground-reflected wave ($40 \log_{10}(d)$ decay).
* **SHF / Microwave (> 2000 MHz)**
  * **Model:** FSPL + distance-proportional clutter absorption + near-ground canopy penalty.
  * **Why it works:** At SHF, Fresnel zones are narrow and ground-waves cease to exist. The model uses pure optical line-of-sight (FSPL) as its baseline with a linear clutter term calibrated against empirical SHF woodland measurements (Tornevik et al. 2001; ITU-R P.833-9): light forest/suburban 2.0 dB/GHz·km, dense forest/urban 5.0 dB/GHz·km (e.g., ~24 dB additional loss at 2.4 GHz / 2 km through dense forest). When either antenna is below 5 m AGL in vegetated terrain, an additional flat penalty (+10 dB dense, +5 dB light) is added to model Fresnel-zone obstruction and canopy-entry absorption — effects that the linear distance term alone does not capture for near-ground SHF links.

## 2a. Terrain Correction Summary Table

| Terrain Type | Egli / upper-UHF FSPL | SHF clutter coefficient | SHF near-ground penalty (< 5 m AGL) |
|---|---|---|---|
| Free Space / Aerial | 0 dB | 0 dB/GHz·km | 0 dB |
| Rural / Open | 0 dB | 0 dB/GHz·km | 0 dB |
| Light Forest / Suburban | +8 dB | 2.0 dB/GHz·km | +5 dB |
| Dense Forest / Urban | +20 dB | 5.0 dB/GHz·km | +10 dB |

*The Egli/upper-UHF corrections are flat (distance-independent); the SHF clutter term scales with both frequency and distance; the near-ground penalty is a flat additive applied before the binary-search range solve.*

## 3. Terrain Diffraction & Blocking
Specter does not assume flat earth. It uses the `Open-Topo-Data` API to pull 11 to 90 elevation samples between any two points. 

* **Deygout Multiple Knife-Edge (ITU-R P.526):** For Non-Line-of-Sight (NLOS) paths, the engine recursively finds the dominant obstacle (the highest Fresnel-Kirchhoff $\nu$ parameter), calculates the knife-edge attenuation, and recurses on the sub-paths. This prevents signals from "stepping over" multiple mountain peaks. For SHF frequencies (>2 GHz), where Fresnel zones are centimetres wide and classical diffraction is negligible, the Deygout loss is applied as a **terrain-blockage penalty** rather than a bending gain — an obstructed 5 GHz path accrues a large additional attenuation rather than being treated as clear.
* **Earth Bulge:** The LOS check incorporates a 4/3 effective Earth radius ($8500$ km) correction, naturally hiding targets behind the geometric curvature of the earth at long ranges.

## 4. Radio Horizon Behaviour
The two frequency regimes are treated differently because their physical propagation mechanisms differ:

* **VHF/UHF (Egli):** No artificial horizon cap is applied. The Egli formula's $40 \log_{10}(d)$ distance exponent already produces steeper-than-free-space rolloff (40 dB/decade vs. FSPL's 20 dB/decade), so the model becomes increasingly conservative beyond the geometric horizon without needing a hard ceiling. A free-space path loss floor ensures the result is always physically plausible.
* **SHF (>2 GHz):** Sensing distance is hard-capped at the geometric radio horizon. At SHF there is no meaningful ground-wave or diffraction mechanism to carry the signal over the Earth's curvature, so any computed range beyond the horizon is physically impossible.

## 5. Advanced Link Budgets
* **Directional Gain:** Antennas can be configured with specific boresight azimuths and half-power beamwidths (HPBW). Gain is calculated per bearing using a Gaussian beam pattern with a realistic -20 dB sidelobe floor.
* **Frequency Hopping (FH) Tax:** For hopping waveforms, Specter applies a mathematical $J/S$ penalty: $10 \log_{10}(\text{Jammer BW} / \text{Target BW})$, realistically modeling the difficulty of suppressing a wide-band hopper with a barrage jammer.
* **Capture Effect Thresholds:** Evaluates the final receiver $J/S$ margin against user-configurable thresholds to determine if the result is "No Effect," "Warbling," or "Complete Jamming."
