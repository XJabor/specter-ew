import math

# Sidelobe attenuation floor below peak gain (dB).
# Based on the 3GPP/ITU simplified horizontal antenna pattern (A_m = 20 dB).
_SIDELOBE_ATT_DB = 20.0


def bearing_deg(lat1, lon1, lat2, lon2):
    """
    Returns the forward azimuth (True North, 0–360°) from (lat1,lon1) to (lat2,lon2).
    Uses the standard spherical formula (same geometry as elevation.py's destination_point).
    """
    lat1r = math.radians(lat1)
    lat2r = math.radians(lat2)
    dlon  = math.radians(lon2 - lon1)
    x = math.sin(dlon) * math.cos(lat2r)
    y = math.cos(lat1r) * math.sin(lat2r) - math.sin(lat1r) * math.cos(lat2r) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def directional_gain_db(peak_gain_dbi, boresight_deg, target_bearing_deg, beamwidth_deg):
    """
    Returns the effective antenna gain (dBi) toward target_bearing_deg using the
    Gaussian beam approximation with a -20 dB sidelobe floor:

        G(θ) = peak_gain - min(12 * (θ / HPBW)², 20)

    where θ is the magnitude of the angular offset from boresight (0–180°).
    The formula gives exactly 3 dB rolloff at half the beamwidth, matching the
    standard half-power beamwidth (HPBW) definition.

    Args:
        peak_gain_dbi:      Max antenna gain at boresight (dBi).
        boresight_deg:      Boresight direction, True North (0–360°).
        target_bearing_deg: Bearing toward target, True North (0–360°).
        beamwidth_deg:      Half-power beamwidth (degrees).  Must be > 0.
    """
    if beamwidth_deg <= 0:
        return peak_gain_dbi  # degenerate config: return peak gain unchanged

    # Angular offset, wrapped to the range [−180, 180] then take magnitude
    delta = (target_bearing_deg - boresight_deg + 180) % 360 - 180
    rolloff = min(12.0 * (delta / beamwidth_deg) ** 2, _SIDELOBE_ATT_DB)
    return peak_gain_dbi - rolloff
