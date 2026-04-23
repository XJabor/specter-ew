# Technical Reference & Physics Engine

## 1. System Architecture
Specter-EW is a stateless Flask REST API backend paired with a vanilla JavaScript/Leaflet frontend. The core calculation engine relies on a **hybrid empirical-deterministic propagation model**. Rather than relying on a single, flawed master equation, Specter dynamically routes path loss calculations through specialized mathematical models based on frequency band and antenna height.

## 2. Multi-Band Propagation Routing Matrix
Specter intercepts link parameters and routes them to the most physically accurate model using the following matrix:

* **VHF / Tactical UHF (< 150 MHz or Antenna < 30m)**
  * **Model:** Egli (1957) Empirical Model.
  * **Why it works:** Captures the unique ground-wave propagation of lower frequencies. Unlike standard models, Egli applies a $20 \log_{10}(f)$ term, mathematically rewarding lower VHF frequencies with longer ranges (e.g., a 50W 80 MHz dismounted radio accurately pushing ~20+ km).
* **Elevated UHF (150 – 2000 MHz, Antenna ≥ 30m)**
  * **Model (NLOS):** COST-231 Hata. Applies complex corrections for rural, suburban, and dense urban terrain clutter.
  * **Model (LOS):** Two-Ray Ground Reflection. Calculates the interference pattern between the direct line-of-sight wave and the ground-reflected wave ($40 \log_{10}(d)$ decay).
* **SHF / Microwave (> 2000 MHz)**
  * **Model:** FSPL + ITU-R P.833 Foliage Penalty.
  * **Why it works:** At SHF, Fresnel zones are narrow and ground-waves cease to exist. The model switches to pure optical line-of-sight (Free Space Path Loss) but aggressively punishes the signal for environmental clutter (e.g., 36 dB penalty at 3 km through dense forest at 5 GHz).

## 3. Terrain Diffraction & Blocking
Specter does not assume flat earth. It uses the `Open-Topo-Data` API to pull 11 to 90 elevation samples between any two points. 

* **Deygout Multiple Knife-Edge (ITU-R P.526):** For Non-Line-of-Sight (NLOS) paths, the engine recursively finds the dominant obstacle (the highest Fresnel-Kirchhoff $\nu$ parameter), calculates the knife-edge attenuation, and recurses on the sub-paths. This prevents signals from "stepping over" multiple mountain peaks.
* **Earth Bulge:** The LOS check incorporates a 4/3 effective Earth radius ($8500$ km) correction, naturally hiding targets behind the geometric curvature of the earth at long ranges.

## 4. Asymptotic Bounds (Radio Horizon Caps)
To prevent empirical models from generating physically impossible extrapolations (e.g., predicting an 80 km detection range for a 1-meter antenna), Specter enforces strict mathematical ceilings within the engine:
* **VHF/UHF (Egli):** Capped at **3.0x** the geometric radio horizon. This allows the model to calculate realistic over-the-horizon VHF diffraction while preventing runaway math.
* **SHF:** Capped at **1.0x** the geometric radio horizon, strictly enforcing the line-of-sight physical limits of microwaves.

## 5. Advanced Link Budgets
* **Directional Gain:** Antennas can be configured with specific boresight azimuths and half-power beamwidths (HPBW). Gain is calculated per bearing using a Gaussian beam pattern with a realistic -20 dB sidelobe floor.
* **Frequency Hopping (FH) Tax:** For hopping waveforms, Specter applies a mathematical $J/S$ penalty: $10 \log_{10}(\text{Jammer BW} / \text{Target BW})$, realistically modeling the difficulty of suppressing a wide-band hopper with a barrage jammer.
* **Capture Effect Thresholds:** Evaluates the final receiver $J/S$ margin against user-configurable thresholds to determine if the result is "No Effect," "Warbling," or "Complete Jamming."
