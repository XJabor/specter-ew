import math

# Egli (1957) median path loss is the plane-earth loss scaled by (f/40 MHz)²:
#   Pr/Pt = Gt·Gr·(ht·hr / d²)²·(40 / f_MHz)²
# In dB with d in km and heights in metres:
#   L = 20·log10(f) + 40·log10(d_km) − 20·log10(ht) − 20·log10(hr) + K
#   K = 40·log10(1000) − 20·log10(40) = 120 − 32.04 = 87.96
# (Imperial cross-check: 117 dB for miles/feet − 8.27 − 2×10.32 = 88.09.)
# Before v1.2.0 this was 47.39, from treating the SI constant 76.3 of the
# −10·log10(hm) variant as a miles/feet constant; that under-stated loss by
# ~40 dB and overstated VHF/UHF ranges roughly tenfold.
_EGLI_K = 120.0 - 20.0 * math.log10(40.0)


def _classify_terrain(terrain_type):
    """
    Canonical terrain category from free-text terrain keywords.

    Returns one of 'free_space', 'dense', 'light', 'open'.
    Precedence: free_space > dense > light > open. The UI vocabulary is
    "free space", "rural", "light forest", "dense forest"; substring matching
    keeps legacy synonyms ("urban", "suburban", "air", "open") working.
    """
    t = (terrain_type or '').strip().lower()
    if 'free' in t or 'air' in t:
        return 'free_space'
    if 'suburb' in t:  # before 'urban': 'suburban' contains it
        return 'light'
    if 'dense' in t or 'urban' in t:
        return 'dense'
    if 'light' in t:
        return 'light'
    return 'open'


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
    """
    return {'dense': 20.0, 'light': 8.0}.get(_classify_terrain(terrain_type), 0.0)


def _egli_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m, terrain_type="rural"):
    """
    Egli (1957) empirical path loss (dB), SI form.

    Designed for VHF/UHF tactical propagation at ground-level antenna heights.
    Unlike Two-Ray it includes a frequency term, correctly giving longer range
    at lower VHF frequencies (e.g. a 5 W, 80 MHz, 2 m dismounted radio against
    a −110 dBm receiver reaches ~6.7 km over rural terrain).

    L = 20·log10(f_MHz) + 40·log10(d_km) − 20·log10(ht_m) − 20·log10(hr_m) + 87.96
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

    cat = _classify_terrain(terrain_type)

    # Metropolitan-centre penalty (dense urban only)
    c_m = 3.0 if cat == 'dense' else 0.0

    A = 46.3 + 33.9 * math.log10(f) - 13.82 * math.log10(h_b) - a_hm + c_m
    B = 44.9 - 6.55 * math.log10(h_b)

    urban_loss = A + B * math.log10(max(0.1, distance_km))

    if cat in ('open', 'free_space'):
        loss = urban_loss - 4.78 * math.log10(f) ** 2 + 18.33 * math.log10(f) - 40.94
    elif cat == 'light':
        loss = urban_loss - 2.0 * (math.log10(f / 28.0)) ** 2 - 5.4
    else:
        loss = urban_loss  # urban / dense urban

    # Physical floor: never report less than free-space path loss
    fspl = 20.0 * math.log10(distance_km) + 20.0 * math.log10(f) + 32.44
    return max(fspl, loss)


def _plane_earth_db(distance_km, tx_height_m, rx_height_m):
    """Plane-earth (two-ray, beyond the breakpoint) loss in dB, frequency-independent:
    L = 40·log10(d_m) − 20·log10(ht) − 20·log10(hr), heights floored at 1 m."""
    ht = max(1.0, tx_height_m)
    hr = max(1.0, rx_height_m)
    return (40.0 * math.log10(distance_km * 1000.0)
            - 20.0 * math.log10(ht) - 20.0 * math.log10(hr))


def _two_ray_inverse_km(budget_db, frequency_mhz, tx_height_m, rx_height_m, over_ground=True):
    """Largest distance (km) whose max(FSPL, plane-earth) loss stays within
    budget_db — the smaller of the two inverses, since both terms must fit.
    With over_ground=False only FSPL applies. Returns (distance_km,
    fspl_limited) where fspl_limited means the free-space term set the range
    (target inside the two-ray breakpoint)."""
    d_fspl = 10.0 ** ((budget_db - 20.0 * math.log10(frequency_mhz) - 32.44) / 20.0)
    if not over_ground:
        return d_fspl, False
    ht = max(1.0, tx_height_m)
    hr = max(1.0, rx_height_m)
    d_pe = 10.0 ** ((budget_db + 20.0 * math.log10(ht) + 20.0 * math.log10(hr)) / 40.0) / 1000.0
    return min(d_fspl, d_pe), d_fspl < d_pe


def _two_ray_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m):
    """
    Two-ray ground reflection path loss (dB): max(FSPL, plane-earth).

    Inside the breakpoint d_c = 4π·ht·hr/λ the direct ray dominates and FSPL
    applies; beyond it the ground-reflected ray cancels the direct one and
    loss rises 40 dB/decade independent of frequency.
    """
    fspl = 20.0 * math.log10(distance_km) + 20.0 * math.log10(frequency_mhz) + 32.44
    return max(fspl, _plane_earth_db(distance_km, tx_height_m, rx_height_m))


_SHF_CLUTTER_K = {'light': 2.0, 'dense': 5.0}  # dB per GHz·km


def _shf_path_loss(distance_km, frequency_mhz, terrain_type, tx_height_m=1.0, rx_height_m=1.0):
    """
    SHF model for frequencies > 2000 MHz.

    Ground reflection + ITU-R P.833-inspired linear foliage/clutter absorption:
      L = max(FSPL, plane-earth) + k·f_GHz·d_km
    Over ground the two-ray floor applies beyond the breakpoint (≈1 km for
    2 m antennas at 5.8 GHz); "free space" terrain (aerial paths) has no
    ground and stays on pure FSPL. Open/rural terrain → no clutter term.
    No diffraction component: at SHF, Fresnel zones are centimetres wide
    and knife-edge bending is negligible.

    Clutter coefficients (dB per GHz·km) — calibrated against empirical
    SHF woodland measurements (Tornevik et al. 2001; ITU-R P.833-9):
      suburban/light:  2.0  →  ~10 dB at 2.4 GHz / 2 km
      urban/dense:     5.0  →  ~24 dB at 2.4 GHz / 2 km (12 dB/km)
    """
    category = _classify_terrain(terrain_type)
    if category == 'free_space':
        ground = _fspl_db(distance_km, frequency_mhz)
    else:
        ground = _two_ray_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m)
    k = _SHF_CLUTTER_K.get(category, 0.0)
    return ground + k * (frequency_mhz / 1000.0) * distance_km


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
    return {'dense': 10.0, 'light': 5.0}.get(_classify_terrain(terrain_type), 0.0)


# Model identifiers reported by path_loss_breakdown() / sensing_distance_breakdown().
# The frontend (static/js/calc_results.js MODEL_INFO) maps these to readable
# names; keep the two in sync.
MODEL_SHF = 'shf'
MODEL_FREE_SPACE = 'free_space'
MODEL_UPPER_UHF = 'upper_uhf'
MODEL_TWO_RAY = 'two_ray'
MODEL_COST231_HATA = 'cost231_hata'
MODEL_EGLI = 'egli'


def _fspl_db(distance_km, frequency_mhz):
    return 20.0 * math.log10(distance_km) + 20.0 * math.log10(frequency_mhz) + 32.44


def _select_model(frequency_mhz, tx_height_m, terrain_category, is_los):
    """Routing table shared by path loss and its sensing-distance inverse."""
    if frequency_mhz > 2000.0:
        return MODEL_SHF
    if terrain_category == 'free_space':
        return MODEL_FREE_SPACE
    hata_ok = _cost231_valid(frequency_mhz, tx_height_m)
    # 1–2 GHz with low antennas (COST-231 Hata unavailable): Egli's empirical
    # (f/40)² terrain factor is poorly supported this far above its VHF/UHF
    # calibration data, so use the physical plane-earth two-ray floor plus the
    # flat terrain correction instead.  (Before v1.2.0 this was bare FSPL,
    # which ignores ground reflection and ran ~25–30 dB optimistic at km ranges.)
    if frequency_mhz >= 1000.0 and not hata_ok:
        return MODEL_UPPER_UHF
    if hata_ok:
        return MODEL_TWO_RAY if is_los else MODEL_COST231_HATA
    return MODEL_EGLI


def path_loss_breakdown(distance_km, frequency_mhz, terrain_type="free space",
                        diffraction_loss_db=0.0,
                        tx_height_m=0.0, rx_height_m=0.0, is_los=False):
    """
    Total path loss plus the component terms that produced it.

    calculate_path_loss() returns this dict's 'loss_db', so the diagnostics the
    inspector shows are by construction the numbers the calculation used.

    Routing (checked against raw tx_height_m before any model-internal flooring):

      LOS paths (diffraction not applied):
        freq > 2000 MHz         → SHF (two-ray floor + clutter, no diffraction;
                                  FSPL + clutter for free-space terrain)
        free space              → FSPL
        freq ≥ 1000, Hata n/a   → two-ray floor + flat terrain correction (upper UHF)
        COST-231 valid domain   → Two-Ray Ground Reflection
        tactical exception      → Egli

      NLOS paths (+ Deygout diffraction_loss_db):
        freq > 2000 MHz         → SHF (as LOS + diffraction_loss_db as blockage penalty)
        free space              → FSPL
        freq ≥ 1000, Hata n/a   → two-ray floor + flat terrain correction (upper UHF)
        COST-231 valid domain   → COST-231 Hata
        tactical exception      → Egli

      COST-231 valid = freq_mhz >= 150 AND tx_height_m >= 30

    tx_height_m / rx_height_m : antenna AGL heights (metres)
    is_los                    : from check_line_of_sight(); False when unknown
    diffraction_loss_db       : Deygout sum; 0 when LOS or elevation unavailable

    Returned keys: loss_db, model, terrain_category, is_los, fspl_db,
    base_loss_db (model loss before diffraction), terrain_correction_db,
    clutter_db (SHF distance-proportional), near_ground_penalty_db (SHF),
    diffraction_db (as applied: 0 on LOS paths), fspl_floor_applied.
    """
    category = _classify_terrain(terrain_type)
    out = {
        'loss_db': 0.0, 'model': None, 'terrain_category': category,
        'is_los': bool(is_los), 'fspl_db': None, 'base_loss_db': None,
        'terrain_correction_db': 0.0, 'clutter_db': 0.0,
        'near_ground_penalty_db': 0.0, 'diffraction_db': 0.0,
        'fspl_floor_applied': False,
    }
    if distance_km <= 0:
        return out

    model = _select_model(frequency_mhz, tx_height_m, category, is_los)
    diff = 0.0 if is_los else diffraction_loss_db
    fspl = _fspl_db(distance_km, frequency_mhz)
    out['model'] = model
    out['fspl_db'] = round(fspl, 2)

    if model == MODEL_SHF:
        # SHF doesn't diffract meaningfully, so on NLOS paths diffraction_loss_db
        # represents terrain blockage severity rather than a bending loss.
        ground = (fspl if category == 'free_space'
                  else _two_ray_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m))
        shf = _shf_path_loss(distance_km, frequency_mhz, terrain_type, tx_height_m, rx_height_m)
        penalty = _shf_near_ground_penalty_db(tx_height_m, rx_height_m, terrain_type)
        base_loss = shf + penalty
        out['clutter_db'] = round(shf - ground, 2)
        out['near_ground_penalty_db'] = penalty
        out['fspl_floor_applied'] = category != 'free_space' and ground == fspl
    elif model == MODEL_UPPER_UHF:
        ground = _two_ray_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m)
        correction = _egli_terrain_correction_db(terrain_type)
        base_loss = ground + correction
        out['terrain_correction_db'] = correction
        out['fspl_floor_applied'] = ground == fspl
    elif model == MODEL_FREE_SPACE:
        base_loss = fspl
    elif model == MODEL_TWO_RAY:
        base_loss = _two_ray_path_loss(distance_km, frequency_mhz, tx_height_m, rx_height_m)
        out['fspl_floor_applied'] = base_loss == fspl
    elif model == MODEL_COST231_HATA:
        base_loss = _cost231_hata_path_loss(distance_km, frequency_mhz,
                                            terrain_type, tx_height_m, rx_height_m)
        f_c = max(150.0, min(2000.0, frequency_mhz))
        out['fspl_floor_applied'] = base_loss == _fspl_db(distance_km, f_c)
    else:
        base_loss = _egli_path_loss(distance_km, frequency_mhz,
                                    tx_height_m, rx_height_m, terrain_type)
        out['fspl_floor_applied'] = base_loss == fspl
        if not out['fspl_floor_applied']:
            out['terrain_correction_db'] = _egli_terrain_correction_db(terrain_type)

    out['base_loss_db'] = round(base_loss, 2)
    out['diffraction_db'] = round(diff, 2)
    out['loss_db'] = round(base_loss + diff, 2)
    return out


def calculate_path_loss(distance_km, frequency_mhz, terrain_type="free space",
                        diffraction_loss_db=0.0,
                        tx_height_m=0.0, rx_height_m=0.0, is_los=False):
    """Total path loss (dB) using the hybrid empirical-deterministic model.
    See path_loss_breakdown() for routing and the component terms."""
    return path_loss_breakdown(distance_km, frequency_mhz, terrain_type,
                               diffraction_loss_db, tx_height_m, rx_height_m,
                               is_los)['loss_db']


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


def sensing_distance_breakdown(enemy_eirp, freq_mhz, terrain_type, rx_gain,
                               rx_sensitivity, diffraction_loss_db=0.0,
                               tx_height_m=0.0, rx_height_m=0.0, is_los=False):
    """
    Maximum detection distance (km) for ES mode, plus how it was reached.

    Exact closed-form inverse of calculate_path_loss() for each model branch;
    routing is shared with path_loss_breakdown() via _select_model().

    tx_height_m / rx_height_m : TX and RX AGL heights; 0 uses model minimums.
    is_los                    : from check_line_of_sight(); False when unknown.
    diffraction_loss_db       : Deygout sum already subtracted from the budget.

    Returned keys: distance_km, model, budget_db (eirp + rx_gain − sensitivity,
    before diffraction), uncapped_distance_km, horizon_km (None when this branch
    has no horizon cap), horizon_capped, fspl_floor_limited (range set by the
    free-space floor rather than the empirical model).
    """
    max_loss = enemy_eirp + rx_gain - rx_sensitivity - diffraction_loss_db
    category = _classify_terrain(terrain_type)
    model = _select_model(freq_mhz, tx_height_m, category, is_los)
    horizon_km = None

    fspl_floor_limited = False
    if model == MODEL_SHF:
        k = _SHF_CLUTTER_K.get(category, 0.0) * (freq_mhz / 1000.0)
        over_ground = category != 'free_space'

        # Subtract near-ground penalty from the available link budget before solving for distance.
        shf_penalty = _shf_near_ground_penalty_db(tx_height_m, rx_height_m, terrain_type)
        effective_max_loss = max_loss - shf_penalty

        d_ground, ground_fspl_limited = _two_ray_inverse_km(
            effective_max_loss, freq_mhz, tx_height_m, rx_height_m, over_ground)
        if k == 0.0:
            distance_km = d_ground
            fspl_floor_limited = ground_fspl_limited
        else:
            # Binary search: L(d) = ground(d) + k*d is monotonically increasing in d.
            # Upper bound = the clutter-free inverse (actual range is shorter with clutter).
            d_hi = d_ground
            d_lo = 0.001
            for _ in range(60):
                mid = (d_lo + d_hi) / 2.0
                if _shf_path_loss(mid, freq_mhz, terrain_type, tx_height_m, rx_height_m) < effective_max_loss:
                    d_lo = mid
                else:
                    d_hi = mid
            distance_km = (d_lo + d_hi) / 2.0
            fspl_floor_limited = over_ground and (
                _fspl_db(distance_km, freq_mhz) >= _plane_earth_db(distance_km, tx_height_m, rx_height_m))
    elif model == MODEL_FREE_SPACE:
        log_d = (max_loss - 20.0 * math.log10(freq_mhz) - 32.44) / 20.0
        distance_km = 10.0 ** log_d
    elif model == MODEL_UPPER_UHF:
        distance_km, fspl_floor_limited = _two_ray_inverse_km(
            max_loss - _egli_terrain_correction_db(terrain_type),
            freq_mhz, tx_height_m, rx_height_m)
    elif model == MODEL_TWO_RAY:
        # Two-ray inverse: d_m = 10^((max_loss + 20·log(ht) + 20·log(hr)) / 40)
        ht = max(1.0, tx_height_m)
        hr = max(1.0, rx_height_m)
        log_d_m = (max_loss + 20.0 * math.log10(ht) + 20.0 * math.log10(hr)) / 40.0
        distance_km = (10.0 ** log_d_m) / 1000.0
    elif model == MODEL_COST231_HATA:
        # COST-231 Hata inverse: d = 10^((max_loss - A) / B)
        f_c = max(150.0, min(2000.0, freq_mhz))
        h_b = max(2.0, tx_height_m)
        h_m = max(1.0, rx_height_m)
        a_hm = (1.1 * math.log10(f_c) - 0.7) * h_m - (1.56 * math.log10(f_c) - 0.8)
        c_m  = 3.0 if category == 'dense' else 0.0
        A = 46.3 + 33.9 * math.log10(f_c) - 13.82 * math.log10(h_b) - a_hm + c_m
        B = 44.9 - 6.55 * math.log10(h_b)
        if category in ('open', 'free_space'):
            A += -4.78 * math.log10(f_c) ** 2 + 18.33 * math.log10(f_c) - 40.94
        elif category == 'light':
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

    # Two-Ray, COST-231 Hata and Egli return max(FSPL, model), so the loss
    # stays within budget only while BOTH terms do: the range is the smaller
    # of the two inverses.  (Hata's floor uses its clamped frequency.)
    if model in (MODEL_TWO_RAY, MODEL_COST231_HATA, MODEL_EGLI):
        f_floor = max(150.0, min(2000.0, freq_mhz)) if model == MODEL_COST231_HATA else freq_mhz
        fspl_d = 10.0 ** ((max_loss - 20.0 * math.log10(f_floor) - 32.44) / 20.0)
        if fspl_d < distance_km:
            distance_km = fspl_d
            fspl_floor_limited = True

    uncapped_km = distance_km
    # Strict 1× radio horizon cap for SHF (no over-horizon propagation) and for
    # 1–2 GHz low antennas (ground-wave negligible, signal is horizon-limited).
    # Free-space paths (aerial/drone) are exempt: no Earth surface is involved.
    if model in (MODEL_SHF, MODEL_UPPER_UHF):
        ht = max(1.0, tx_height_m)
        hr = max(1.0, rx_height_m)
        horizon_km = _egli_horizon_km(ht, hr)
        distance_km = min(distance_km, horizon_km)

    return {
        'distance_km': round(max(0.001, distance_km), 3),
        'model': model,
        'budget_db': round(max_loss + diffraction_loss_db, 2),
        'uncapped_distance_km': round(max(0.001, uncapped_km), 3),
        'horizon_km': None if horizon_km is None else round(horizon_km, 3),
        'horizon_capped': horizon_km is not None and uncapped_km > horizon_km,
        'fspl_floor_limited': fspl_floor_limited,
    }


def calculate_sensing_distance(enemy_eirp, freq_mhz, terrain_type, rx_gain,
                               rx_sensitivity, diffraction_loss_db=0.0,
                               tx_height_m=0.0, rx_height_m=0.0, is_los=False):
    """Maximum detection distance (km) for ES mode.
    See sensing_distance_breakdown() for routing and the horizon cap."""
    return sensing_distance_breakdown(
        enemy_eirp, freq_mhz, terrain_type, rx_gain, rx_sensitivity,
        diffraction_loss_db, tx_height_m, rx_height_m, is_los)['distance_km']
