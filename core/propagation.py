import math

# Transition-zone boundaries for the blended dual-slope model.
# Below 0.5 km: pure free-space (n=20).  Above 2.0 km: pure ground-plane (n=40).
# The breakpoints are symmetric in log space around the 1 km crossover.
_LOG_LO = math.log10(0.5)   # -0.30103
_LOG_HI = math.log10(2.0)   #  0.30103
_N_LO   = 20.0
_N_HI   = 40.0


def _blended_exponent(distance_km):
    """
    Returns the path-loss exponent n for a given distance using a log-linear
    blend across the 0.5–2.0 km transition zone.
      d < 0.5 km  : n = 20 (free space)
      0.5–2.0 km  : n interpolates 20→40 linearly in log10(d)
      d > 2.0 km  : n = 40 (ground plane)
    """
    log_d = math.log10(distance_km)
    if log_d <= _LOG_LO:
        return _N_LO
    if log_d >= _LOG_HI:
        return _N_HI
    t = (log_d - _LOG_LO) / (_LOG_HI - _LOG_LO)
    return _N_LO + (_N_HI - _N_LO) * t


def get_clutter_loss(terrain_type, frequency_mhz):
    """
    Returns the clutter penalty based on terrain and frequency band.
    Separates Tactical bands (< 500 MHz) from Drone/Data bands (> 1000 MHz).
    """
    # Normalize input string
    terrain = terrain_type.strip().lower()
    
    # Determine the frequency column
    is_tactical = frequency_mhz < 500
    
    if "free space" in terrain or "air" in terrain:
        return 0
    elif "rural" in terrain or "open" in terrain:
        return 10 if is_tactical else 20
    elif "light" in terrain or "suburb" in terrain:
        return 20 if is_tactical else 30
    elif "dense" in terrain or "urban" in terrain or "heavy" in terrain:
        return 30 if is_tactical else 40
    else:
        # Default to a safe/conservative estimate if terrain isn't recognized
        return 20 

def calculate_path_loss(distance_km, frequency_mhz, terrain_type="free space",
                        diffraction_loss_db=0.0):
    """
    Calculates Path Loss using the Blended Dual-Slope Model.
    - Uses n=20 (Free Space) for distances < 0.5 km.
    - Blends n linearly from 20→40 across the 0.5–2.0 km transition zone.
    - Uses n=40 (Ground Plane) for distances > 2.0 km.
    diffraction_loss_db: additional knife-edge diffraction loss (dB) from
                         elevation analysis; 0.0 when no elevation data.
    """
    if distance_km <= 0:
        return 0 # Prevent math domain errors for zero distance

    clutter = get_clutter_loss(terrain_type, frequency_mhz)
    freq_loss = 20 * math.log10(frequency_mhz)
    constant = 32.44

    n = _blended_exponent(distance_km)
    dist_loss = n * math.log10(distance_km)

    total_path_loss = dist_loss + freq_loss + constant + clutter + diffraction_loss_db
    return round(total_path_loss, 2)

def calculate_received_power(eirp, path_loss):
    """
    Subtracts the path loss from the EIRP to find the signal strength at the receiver.
    """
    return round(eirp - path_loss, 2)

def evaluate_jamming_effect(jammer_rx_dbm, enemy_rx_dbm, lower_threshold=-6.0, upper_threshold=6.0):
    """
    Compares the received jamming power to the received enemy signal.
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
                               rx_sensitivity, diffraction_loss_db=0.0):
    """
    Calculates the maximum detection distance (ES Mode).
    Uses the Reverse Path Loss calculation to find the distance where the
    signal exactly matches the receiver's sensitivity threshold.
    Mirrors the blended dual-slope forward model in calculate_path_loss().
    diffraction_loss_db: additional terrain-blocking loss (dB) that reduces
                         the effective detection range; 0.0 for free-space.
    """
    # Step 1: Calculate your link budget (Max Allowable Path Loss)
    max_loss_budget = enemy_eirp + rx_gain - rx_sensitivity - diffraction_loss_db

    # Step 2: Calculate baseline loss at 1 km (Frequency + Clutter).
    # At 1 km, dist_loss = n * log10(1) = 0, so total_loss_1km is purely
    # the fixed terms.  dist_loss_budget is what remains for the distance term.
    clutter = get_clutter_loss(terrain_type, freq_mhz)
    fspl_1km = 20 * math.log10(freq_mhz) + 32.44
    total_loss_1km = fspl_1km + clutter
    dist_loss_budget = max_loss_budget - total_loss_1km

    # Step 3: Blended dual-slope inverse calculation.
    # Zone boundaries expressed as dist_loss values at d=0.5 km and d=2.0 km.
    budget_lo = _N_LO * _LOG_LO   # ~-6.02 dB  (d = 0.5 km)
    budget_hi = _N_HI * _LOG_HI   # ~+12.04 dB (d = 2.0 km)

    if dist_loss_budget <= budget_lo:
        # Free-space zone (d <= 0.5 km): dist_loss = N_LO * x
        log_d = dist_loss_budget / _N_LO
    elif dist_loss_budget >= budget_hi:
        # Ground-plane zone (d >= 2.0 km): dist_loss = N_HI * x
        log_d = dist_loss_budget / _N_HI
    else:
        # Transition zone (0.5 km < d < 2.0 km).
        # Forward model expands to: a*x^2 + 30*x = dist_loss_budget
        # where a = N_LO / (LOG_HI - LOG_LO).  b=30 is exact by symmetry of
        # log10(0.5) and log10(2).  Solve for the positive root.
        _w = _LOG_HI - _LOG_LO
        _a = _N_LO / _w           # ~33.2193
        _b = 30.0
        discriminant = _b ** 2 + 4.0 * _a * dist_loss_budget
        log_d = (-_b + math.sqrt(discriminant)) / (2.0 * _a)

    distance_km = 10 ** log_d
    return round(distance_km, 3)