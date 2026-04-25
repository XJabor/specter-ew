import math

# Egli (1957) SI constant: 76.3 (original) − 8.27 (miles→km) − 10.32×2 (feet→m) = 47.39
_EGLI_K = 47.39


def _cost231_valid(frequency_mhz, tx_height_m):
    """True when parameters fall inside the COST-231 Hata validity domain."""
    return frequency_mhz >= 150.0 and tx_height_m >= 30.0


_RE_EFF_KM = 8500.0  # 4/3 Earth effective radius (km); matches EARTH_EFFECTIVE_RADIUS_KM in elevation.py


def _egli_horizon_km(ht_m, hr_m):
    """Radio horizon (km) for the 4/3-Earth model given AGL heights in metres."""
    return (math.sqrt(2.0 * _RE_EFF_KM * ht_m / 1000.0)
            + math.sqrt(2.0 * _RE_EFF_KM * hr_m / 1000.0))


def _egli_terrain_correction_db(terrain_type):
    """
    Flat additive dB correction to Egli path loss for terrain/clutter type.

    Egli (1957) was calibrated over average rolling terrain (open fields, low
    suburban relief).  Environments that deviate from that baseline carry an
    excess-loss correction (ITU-R P.833 VHF edge effects; military tactical
    VHF field data in vegetation):

      Rural / open / free space  →   0 dB  (Egli's native calibration env)
      Light forest / suburban    →  +8 dB  (~37% range reduction vs. rural)
      Dense forest / urban       → +20 dB  (~70% range reduction vs. rural)

    Keyword matching mirrors _shf_path_loss() and _cost231_hata_path_loss().
    """
    terrain = terrain_type.strip().lower()
    if "dense" in terrain or "urban" in terrain:
        return 20.0
    elif "suburb" in terrain or "light" in terrain:
        return 8.0
    else:
        return 0.0  # rural / open / free space


def _egli_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m, terrain_type="rural"):
    """
    Egli (1957) empirical path loss (dB), SI form.

    Designed for VHF/UHF tactical propagation at ground-level antenna heights.
    Unlike Two-Ray it includes a frequency term, correctly giving longer range
    at lower VHF frequencies (e.g. 80 MHz dismounted radio reaches ~20 km).

    L = 20·log10(f_MHz) + 40·log10(d_km) − 20·log10(ht_m) − 20·log10(hr_m) + 47.39
        + _egli_terrain_correction_db(terrain_type)

    Heights floored at 1 m. Terrain correction applied before the FSPL floor.
    The 40 dB/decade slope is already more conservative than FSPL beyond the
    geometric horizon, so no artificial distance cap is applied — capping d while
    keeping the FSPL floor on actual distance creates a flat-loss dead zone.
    """
    ht = max(1.0, tx_height_m)
    hr = max(1.0, rx_height_m)

    loss = (20.0 * math.log10(frequency_mhz)
            + 40.0 * math.log10(max(0.001, distance_km))
            - 20.0 * math.log10(ht)
            - 20.0 * math.log10(hr)
            + _EGLI_K)

    correction = _egli_terrain_correction_db(terrain_type)
    fspl = 20.0 * math.log10(distance_km) + 20.0 * math.log10(frequency_mhz) + 32.44
    return max(fspl, loss + correction)


def _cost231_hata_path_loss(distance_km, frequency_mhz, terrain_type, tx_height_m, rx_height_m):
    """
    COST-231 Hata empirical path loss (dB).
    Valid range: 150–2000 MHz, tx_height ≥ 30 m. Routed here by _cost231_valid().
    Heights are floored to the model's minimum sensible values.
    Returns at least FSPL so the result is always physically plausible.
    """
    f   = max(150.0, min(2000.0, frequency_mhz))
    h_b = max(2.0, tx_height_m)   # base-station height, floor 2 m
    h_m = max(1.0, rx_height_m)   # mobile height, floor 1 m

    # Small/medium-city mobile antenna correction factor
    a_hm = (1.1 * math.log10(f) - 0.7) * h_m - (1.56 * math.log10(f) - 0.8)

    # Metropolitan-centre penalty (dense urban only)
    c_m = 3.0 if "dense" in terrain_type.lower() else 0.0

    A = 46.3 + 33.9 * math.log10(f) - 13.82 * math.log10(h_b) - a_hm + c_m
    B = 44.9 - 6.55 * math.log10(h_b)

    urban_loss = A + B * math.log10(max(0.1, distance_km))

    terrain = terrain_type.strip().lower()
    if "rural" in terrain or "open" in terrain or "free" in terrain:
        loss = urban_loss - 4.78 * math.log10(f) ** 2 + 18.33 * math.log10(f) - 40.94
    elif "suburb" in terrain or "light" in terrain:
        loss = urban_loss - 2.0 * (math.log10(f / 28.0)) ** 2 - 5.4
    else:
        loss = urban_loss  # urban / dense urban

    # Physical floor: never report less than free-space path loss
    fspl = 20.0 * math.log10(distance_km) + 20.0 * math.log10(f) + 32.44
    return max(fspl, loss)


def _two_ray_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m):
    """
    Two-ray ground reflection path loss (dB).
    L = 40·log10(d_m) − 20·log10(ht) − 20·log10(hr)
    Heights floored at 1 m. Returns at least FSPL.
    """
    ht  = max(1.0, tx_height_m)
    hr  = max(1.0, rx_height_m)
    d_m = distance_km * 1000.0

    loss = 40.0 * math.log10(d_m) - 20.0 * math.log10(ht) - 20.0 * math.log10(hr)

    fspl = 20.0 * math.log10(distance_km) + 20.0 * math.log10(frequency_mhz) + 32.44
    return max(fspl, loss)


def _shf_path_loss(distance_km, frequency_mhz, terrain_type):
    """
    SHF model for frequencies > 2000 MHz.

    FSPL + ITU-R P.833-inspired linear foliage/clutter absorption.
    Open/rural terrain → pure FSPL (no clutter term).
    No diffraction component: at SHF, Fresnel zones are centimetres wide
    and knife-edge bending is negligible.

    Clutter coefficients (dB per GHz·km) — calibrated against empirical
    SHF woodland measurements (Tornevik et al. 2001; ITU-R P.833-9):
      suburban/light:  2.0  →  ~10 dB at 2.4 GHz / 2 km
      urban/dense:     5.0  →  ~24 dB at 2.4 GHz / 2 km (12 dB/km)
    """
    fspl = (20.0 * math.log10(distance_km)
            + 20.0 * math.log10(frequency_mhz) + 32.44)

    terrain = terrain_type.strip().lower()
    f_ghz   = frequency_mhz / 1000.0
    if "suburb" in terrain or "light" in terrain:
        clutter = 2.0 * f_ghz * distance_km
    elif "dense" in terrain or "urban" in terrain:
        clutter = 5.0 * f_ghz * distance_km
    else:
        clutter = 0.0  # open / rural / free space

    return fspl + clutter


def _shf_near_ground_penalty_db(tx_height_m, rx_height_m, terrain_type):
    """
    Additional flat dB penalty for SHF (> 2 GHz) near-ground operation in
    vegetated or cluttered terrain.

    At SHF, the first Fresnel zone at ground level is fully obstructed by
    terrain and low canopy when either antenna is below ~5 m AGL, causing
    phase cancellation and canopy-entry absorption not captured by the
    linear clutter term alone.  Empirical data for 2.4 GHz at 1–2 m height
    in dense forest show an additional 8–15 dB loss vs. elevated terminals
    (Devasirvatham 1990; DeSoto-type pine forest field measurements).

    Threshold: min(tx_height, rx_height) < 5.0 m.
    Open / rural / free space paths are exempt — Fresnel obstruction is
    ground-surface geometry, not vegetation absorption.
    """
    if min(tx_height_m, rx_height_m) >= 5.0:
        return 0.0
    terrain = terrain_type.strip().lower()
    if "dense" in terrain or "urban" in terrain:
        return 10.0
    elif "suburb" in terrain or "light" in terrain:
        return 5.0
    else:
        return 0.0  # open / rural / free space


def calculate_path_loss(distance_km, frequency_mhz, terrain_type="free space",
                        diffraction_loss_db=0.0,
                        tx_height_m=0.0, rx_height_m=0.0, is_los=False):
    """
    Total path loss (dB) using the hybrid empirical-deterministic model.

    Routing (checked against raw tx_height_m before any model-internal flooring):

      LOS paths (diffraction not applied):
        freq > 2000 MHz         → SHF (FSPL + clutter, no diffraction)
        free space              → FSPL
        COST-231 valid domain   → Two-Ray Ground Reflection
        tactical exception      → Egli

      NLOS paths (+ Deygout diffraction_loss_db):
        freq > 2000 MHz         → SHF (FSPL + clutter + diffraction_loss_db as blockage penalty)
        free space              → FSPL
        COST-231 valid domain   → COST-231 Hata
        tactical exception      → Egli

      COST-231 valid = freq_mhz >= 150 AND tx_height_m >= 30

    tx_height_m / rx_height_m : antenna AGL heights (metres)
    is_los                    : from check_line_of_sight(); False when unknown
    diffraction_loss_db       : Deygout sum; 0 when LOS or elevation unavailable
    """
    if distance_km <= 0:
        return 0.0

    is_free_space = "free space" in terrain_type.lower() or "air" in terrain_type.lower()
    hata_ok = _cost231_valid(frequency_mhz, tx_height_m)
    # Egli was calibrated for 40–900 MHz VHF/UHF ground scenarios.  At 1–2 GHz with
    # low antennas (where COST-231 Hata is unavailable) it over-predicts path loss by
    # 20–30 dB relative to measured values.  Use FSPL as the baseline instead.
    upper_uhf = frequency_mhz >= 1000.0 and not hata_ok

    if is_los:
        if frequency_mhz > 2000.0:
            shf_loss = (_shf_path_loss(distance_km, frequency_mhz, terrain_type)
                        + _shf_near_ground_penalty_db(tx_height_m, rx_height_m, terrain_type))
            return round(shf_loss, 2)
        elif is_free_space or upper_uhf:
            base_loss = (20.0 * math.log10(distance_km)
                         + 20.0 * math.log10(frequency_mhz) + 32.44)
            if upper_uhf and not is_free_space:
                base_loss += _egli_terrain_correction_db(terrain_type)
        elif hata_ok:
            base_loss = _two_ray_path_loss(distance_km, frequency_mhz,
                                           tx_height_m, rx_height_m)
        else:
            base_loss = _egli_path_loss(distance_km, frequency_mhz,
                                        tx_height_m, rx_height_m, terrain_type)
        return round(base_loss, 2)
    else:
        if frequency_mhz > 2000.0:
            # SHF doesn't diffract meaningfully, so diffraction_loss_db represents
            # terrain blockage severity rather than a bending loss.
            shf_loss = (_shf_path_loss(distance_km, frequency_mhz, terrain_type)
                        + _shf_near_ground_penalty_db(tx_height_m, rx_height_m, terrain_type)
                        + diffraction_loss_db)
            return round(shf_loss, 2)
        elif is_free_space or upper_uhf:
            base_loss = (20.0 * math.log10(distance_km)
                         + 20.0 * math.log10(frequency_mhz) + 32.44)
            if upper_uhf and not is_free_space:
                base_loss += _egli_terrain_correction_db(terrain_type)
        elif hata_ok:
            base_loss = _cost231_hata_path_loss(distance_km, frequency_mhz,
                                                terrain_type, tx_height_m, rx_height_m)
        else:
            base_loss = _egli_path_loss(distance_km, frequency_mhz,
                                        tx_height_m, rx_height_m, terrain_type)
        return round(base_loss + diffraction_loss_db, 2)


def calculate_received_power(eirp, path_loss):
    """Subtracts path loss from EIRP to find received signal strength (dBm)."""
    return round(eirp - path_loss, 2)


def evaluate_jamming_effect(jammer_rx_dbm, enemy_rx_dbm, lower_threshold=-6.0, upper_threshold=6.0):
    """
    Compares received jamming power to received enemy signal.
    Returns the operational effect based on the Capture Effect cliffs.

    lower_threshold: margin (dB) at or below which the enemy signal captures the receiver
    upper_threshold: margin (dB) at or above which the jammer captures the receiver
    """
    margin = jammer_rx_dbm - enemy_rx_dbm

    if margin <= lower_threshold:
        return "No Effect (Enemy signal captures receiver)"
    elif margin >= upper_threshold:
        return "Complete Jamming (Jammer captures receiver)"
    else:
        return "Warbling / Popcorn (Contested Zone)"


def calculate_sensing_distance(enemy_eirp, freq_mhz, terrain_type, rx_gain,
                               rx_sensitivity, diffraction_loss_db=0.0,
                               tx_height_m=0.0, rx_height_m=0.0, is_los=False):
    """
    Maximum detection distance (km) for ES mode.

    Exact closed-form inverse of calculate_path_loss() for each model branch.
    Routing mirrors calculate_path_loss() exactly.

    tx_height_m / rx_height_m : TX and RX AGL heights; 0 uses model minimums.
    is_los                    : from check_line_of_sight(); False when unknown.
    diffraction_loss_db       : Deygout sum already subtracted from the budget.
    """
    max_loss = enemy_eirp + rx_gain - rx_sensitivity - diffraction_loss_db

    # SHF branch: early return before the LOS/NLOS split (diffraction is negligible at >2 GHz)
    if freq_mhz > 2000.0:
        f_ghz   = freq_mhz / 1000.0
        terrain = terrain_type.strip().lower()
        if "suburb" in terrain or "light" in terrain:
            k = 2.0 * f_ghz
        elif "dense" in terrain or "urban" in terrain:
            k = 5.0 * f_ghz
        else:
            k = 0.0

        # Subtract near-ground penalty from the available link budget before solving for distance.
        shf_penalty = _shf_near_ground_penalty_db(tx_height_m, rx_height_m, terrain_type)
        effective_max_loss = max_loss - shf_penalty

        if k == 0.0:
            log_d = (effective_max_loss - 20.0 * math.log10(freq_mhz) - 32.44) / 20.0
            distance_km = 10.0 ** log_d
        else:
            # Binary search: L(d) = FSPL(d) + k*d is monotonically increasing in d.
            # Upper bound = FSPL-only inverse (actual range is shorter with clutter).
            d_hi = 10.0 ** ((effective_max_loss - 20.0 * math.log10(freq_mhz) - 32.44) / 20.0)
            d_lo = 0.001
            for _ in range(60):
                mid = (d_lo + d_hi) / 2.0
                if _shf_path_loss(mid, freq_mhz, terrain_type) < effective_max_loss:
                    d_lo = mid
                else:
                    d_hi = mid
            distance_km = (d_lo + d_hi) / 2.0

        # Strict 1× radio horizon cap: SHF has no over-horizon propagation (unlike VHF ground-wave).
        ht = max(1.0, tx_height_m)
        hr = max(1.0, rx_height_m)
        distance_km = min(distance_km, _egli_horizon_km(ht, hr))
        return round(max(0.001, distance_km), 3)

    is_free_space = "free space" in terrain_type.lower() or "air" in terrain_type.lower()
    hata_ok = _cost231_valid(freq_mhz, tx_height_m)
    upper_uhf = freq_mhz >= 1000.0 and not hata_ok

    if is_los:
        if is_free_space or upper_uhf:
            uhf_correction = 0.0 if is_free_space else _egli_terrain_correction_db(terrain_type)
            log_d = (max_loss - uhf_correction - 20.0 * math.log10(freq_mhz) - 32.44) / 20.0
            distance_km = 10.0 ** log_d
        elif hata_ok:
            # Two-ray inverse: d_m = 10^((max_loss + 20·log(ht) + 20·log(hr)) / 40)
            ht = max(1.0, tx_height_m)
            hr = max(1.0, rx_height_m)
            log_d_m = (max_loss + 20.0 * math.log10(ht) + 20.0 * math.log10(hr)) / 40.0
            distance_km = (10.0 ** log_d_m) / 1000.0
        else:
            # Egli inverse: d = 10^((max_loss - correction - A_egli) / 40)
            ht = max(1.0, tx_height_m)
            hr = max(1.0, rx_height_m)
            correction = _egli_terrain_correction_db(terrain_type)
            A_egli = (20.0 * math.log10(freq_mhz)
                      - 20.0 * math.log10(ht)
                      - 20.0 * math.log10(hr)
                      + _EGLI_K)
            distance_km = 10.0 ** ((max_loss - correction - A_egli) / 40.0)
    else:
        if is_free_space or upper_uhf:
            uhf_correction = 0.0 if is_free_space else _egli_terrain_correction_db(terrain_type)
            log_d = (max_loss - uhf_correction - 20.0 * math.log10(freq_mhz) - 32.44) / 20.0
            distance_km = 10.0 ** log_d
        elif hata_ok:
            # COST-231 Hata inverse: d = 10^((max_loss - A) / B)
            f_c = max(150.0, min(2000.0, freq_mhz))
            h_b = max(2.0, tx_height_m)
            h_m = max(1.0, rx_height_m)
            a_hm = (1.1 * math.log10(f_c) - 0.7) * h_m - (1.56 * math.log10(f_c) - 0.8)
            c_m  = 3.0 if "dense" in terrain_type.lower() else 0.0
            A = 46.3 + 33.9 * math.log10(f_c) - 13.82 * math.log10(h_b) - a_hm + c_m
            B = 44.9 - 6.55 * math.log10(h_b)
            terrain = terrain_type.strip().lower()
            if "rural" in terrain or "open" in terrain or "free" in terrain:
                A += -4.78 * math.log10(f_c) ** 2 + 18.33 * math.log10(f_c) - 40.94
            elif "suburb" in terrain or "light" in terrain:
                A += -2.0 * (math.log10(f_c / 28.0)) ** 2 - 5.4
            if B <= 0:
                B = 1.0
            distance_km = 10.0 ** ((max_loss - A) / B)
        else:
            # Egli inverse: d = 10^((max_loss - correction - A_egli) / 40)
            ht = max(1.0, tx_height_m)
            hr = max(1.0, rx_height_m)
            correction = _egli_terrain_correction_db(terrain_type)
            A_egli = (20.0 * math.log10(freq_mhz)
                      - 20.0 * math.log10(ht)
                      - 20.0 * math.log10(hr)
                      + _EGLI_K)
            distance_km = 10.0 ** ((max_loss - correction - A_egli) / 40.0)

    # At 1–2 GHz with low antennas, ground-wave is negligible — signal is horizon-limited.
    # Apply the same strict 1× radio horizon cap used by the SHF branch.
    # is_free_space paths (aerial/drone) are exempt: they share the upper_uhf code path
    # but "free space" terrain means no Earth surface is involved.
    if upper_uhf and not is_free_space:
        ht = max(1.0, tx_height_m)
        hr = max(1.0, rx_height_m)
        distance_km = min(distance_km, _egli_horizon_km(ht, hr))

    return round(max(0.001, distance_km), 3)
