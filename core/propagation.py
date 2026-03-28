import math

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
    Calculates Path Loss using the Dual-Slope Model.
    - Uses 20 log (Free Space) for distances < 1 km.
    - Uses 40 log (Ground Plane) for distances >= 1 km.
    diffraction_loss_db: additional knife-edge diffraction loss (dB) from
                         elevation analysis; 0.0 when no elevation data.
    """
    if distance_km <= 0:
        return 0 # Prevent math domain errors for zero distance

    clutter = get_clutter_loss(terrain_type, frequency_mhz)
    freq_loss = 20 * math.log10(frequency_mhz)
    constant = 32.44

    if distance_km >= 1.0:
        # Ground Slope (40 log)
        dist_loss = 40 * math.log10(distance_km)
    else:
        # Free Space (20 log)
        dist_loss = 20 * math.log10(distance_km)

    total_path_loss = dist_loss + freq_loss + constant + clutter + diffraction_loss_db
    return round(total_path_loss, 2)

def calculate_received_power(eirp, path_loss):
    """
    Subtracts the path loss from the EIRP to find the signal strength at the receiver.
    """
    return round(eirp - path_loss, 2)

def evaluate_jamming_effect(jammer_rx_dbm, enemy_rx_dbm):
    """
    Compares the received jamming power to the received enemy signal.
    Returns the operational effect based on the Capture Effect cliffs.
    """
    margin = jammer_rx_dbm - enemy_rx_dbm
    
    if margin <= -6:
        return "No Effect (Enemy signal captures receiver)"
    elif -5 <= margin <= 5:
        return "Warbling / Popcorn (Contested Zone)"
    else: # margin >= 6
        return "Complete Jamming (Jammer captures receiver)"

def calculate_sensing_distance(enemy_eirp, freq_mhz, terrain_type, rx_gain,
                               rx_sensitivity, diffraction_loss_db=0.0):
    """
    Calculates the maximum detection distance (ES Mode).
    Uses the Reverse Path Loss calculation to find the distance where the
    signal exactly matches the receiver's sensitivity threshold.
    diffraction_loss_db: additional terrain-blocking loss (dB) that reduces
                         the effective detection range; 0.0 for free-space.
    """
    # Step 1: Calculate your link budget (Max Allowable Path Loss)
    max_loss_budget = enemy_eirp + rx_gain - rx_sensitivity - diffraction_loss_db
    
    # Step 2: Calculate baseline loss at 1 km (Frequency + Clutter)
    clutter = get_clutter_loss(terrain_type, freq_mhz)
    fspl_1km = 20 * math.log10(freq_mhz) + 32.44
    total_loss_1km = fspl_1km + clutter
    
    # Step 3: Dual-Slope reverse calculation
    if max_loss_budget >= total_loss_1km:
        # Ground Slope (40 log)
        exponent = (max_loss_budget - total_loss_1km) / 40.0
    else:
        # Free Space / Short Range (20 log)
        exponent = (max_loss_budget - total_loss_1km) / 20.0
        
    distance_km = 10 ** exponent
    return round(distance_km, 3)