"""Terrain-aware coverage footprint shared by the ES detection ring and
jammer footprint endpoints.

Both endpoints answer the same physical question — out to what range, per
azimuth bearing, does a transmitter's signal stay above a receiver
sensitivity threshold given real terrain — so they share one implementation
here and differ only in how the HTTP request fields are named.
"""

import logging

from core.antenna import directional_gain_db
from core.elevation import (
    check_line_of_sight,
    destination_point,
    get_elevation_profiles_batch,
)
from core.link_budget import calculate_eirp, watts_to_dbm
from core.local_data import is_locally_covered
from core.propagation import calculate_path_loss, calculate_sensing_distance

_logger = logging.getLogger(__name__)

# Ring resolution: high when every DTED cell within range is in the local
# index (no rate limits), API-safe otherwise (opentopodata allows 1 req/sec).
LOCAL_RES_BEARINGS = 72
LOCAL_RES_SAMPLES = 25
API_RES_BEARINGS = 36
API_RES_SAMPLES = 11

MIN_RING_RANGE_KM = 0.05


def walk_profile_to_range(profile, freq_mhz, terrain, eirp, rx_gain, rx_sensitivity, tx_height_m):
    """
    Find the detection/sensing range by walking the elevation profile outward.

    For each sample at distance d_i, evaluates path loss using only the
    sub-profile from TX to that point.  Returns the interpolated distance
    where cumulative path loss first exceeds the link budget.

    Deygout diffraction is only applied when terrain physically rises above the
    straight TX-to-sample line of sight (i.e. a genuine terrain obstacle).
    Earth bulge alone does not trigger Deygout because empirical models like
    Egli already capture Earth-curvature effects in their measured rolloff; adding
    Deygout on top would double-count Earth curvature and shrink flat-terrain
    rings by ~10× relative to the simple sensing-distance calculation.
    """
    max_loss = eirp + rx_gain - rx_sensitivity
    prev_d   = 0.0
    prev_pl  = 0.0

    for i in range(1, len(profile)):
        d_i = profile[i]['distance_km']
        if d_i <= 0:
            continue
        sub = profile[:i + 1]

        # Check whether any terrain sample (ignoring Earth bulge) rises above
        # the straight geometric LOS line.  If not, Earth curvature is the only
        # "obstacle" and the empirical model already handles it.
        h_tx = sub[0]['elevation_m'] + tx_height_m
        h_rx = sub[-1]['elevation_m']   # notional ground-level receiver
        terrain_blocked = any(
            pt['elevation_m'] > h_tx + (h_rx - h_tx) * (pt['distance_km'] / d_i) + 1.0
            for pt in sub[1:-1]
            if 0 < pt['distance_km'] < d_i
        )

        if terrain_blocked:
            los    = check_line_of_sight(sub, freq_mhz, tx_height_m, 0.0)
            diff_db  = los['diffraction_loss_db']
            is_los   = los['is_los']
        else:
            diff_db = 0.0
            is_los  = True  # let the empirical model handle Earth curvature

        pl_i = calculate_path_loss(
            d_i, freq_mhz, terrain, diff_db, tx_height_m, 0.0, is_los
        )
        if pl_i > max_loss:
            if prev_d <= 0:
                return max(MIN_RING_RANGE_KM, d_i / 2.0)
            frac = (max_loss - prev_pl) / max(pl_i - prev_pl, 1e-9)
            frac = max(0.0, min(1.0, frac))
            return prev_d + frac * (d_i - prev_d)
        prev_pl = pl_i
        prev_d  = d_i

    return profile[-1]['distance_km']


def compute_terrain_footprint(lat, lon, tx_w, tx_gain, antenna_type,
                              azimuth_deg, beamwidth_deg, antenna_height_m,
                              freq_mhz, terrain, rx_gain, rx_sensitivity,
                              log_label='footprint'):
    """
    Compute a terrain-shaped coverage polygon around a transmitter.

    Returns {'base_range_km': float, 'polygon_points': list | None} where
    polygon_points holds one [lat, lon] per azimuth bearing, or None when
    elevation data is unavailable (callers fall back to a plain circle).
    """
    tx_dbm = watts_to_dbm(tx_w)

    def eirp_at_bearing(b):
        """Returns EIRP (dBm) toward bearing b, accounting for directional TX pattern."""
        if antenna_type == 'directional':
            gain = directional_gain_db(tx_gain, azimuth_deg, b, beamwidth_deg)
        else:
            gain = tx_gain
        return calculate_eirp(tx_dbm, gain)

    # On-boresight (peak) range used for the tooltip label and initial path endpoints.
    # LOS (Two-Ray) is used for the label — it matches what flat terrain will actually show.
    # Profile endpoints use the larger of LOS and NLOS so elevation data always extends
    # to the furthest possible detection distance regardless of actual terrain.
    peak_eirp     = eirp_at_bearing(azimuth_deg if antenna_type == 'directional' else 0)
    base_range_km = calculate_sensing_distance(
        peak_eirp, freq_mhz, terrain, rx_gain, rx_sensitivity,
        tx_height_m=antenna_height_m, is_los=True
    )
    proj_range_km = max(
        base_range_km,
        calculate_sensing_distance(
            peak_eirp, freq_mhz, terrain, rx_gain, rx_sensitivity,
            tx_height_m=antenna_height_m, is_los=False
        )
    )

    if is_locally_covered(lat, lon, proj_range_km):
        num_bearings = LOCAL_RES_BEARINGS
        num_samples  = LOCAL_RES_SAMPLES
    else:
        num_bearings = API_RES_BEARINGS
        num_samples  = API_RES_SAMPLES

    # Build one endpoint per bearing at the projection range
    bearings = [360.0 * i / num_bearings for i in range(num_bearings)]
    paths = []
    for bearing in bearings:
        end_lat, end_lon = destination_point(lat, lon, bearing, proj_range_km)
        paths.append((lat, lon, end_lat, end_lon))

    polygon_points = None
    try:
        profiles = get_elevation_profiles_batch(paths, num_samples=num_samples)
        polygon_points = []
        for bearing, profile in zip(bearings, profiles):
            eirp = eirp_at_bearing(bearing)
            range_km = walk_profile_to_range(
                profile, freq_mhz, terrain,
                eirp, rx_gain, rx_sensitivity, antenna_height_m
            )
            range_km = max(range_km, MIN_RING_RANGE_KM)
            pt_lat, pt_lon = destination_point(lat, lon, bearing, range_km)
            polygon_points.append([pt_lat, pt_lon])
    except Exception as e:
        _logger.warning("%s: elevation API failed, falling back to circle: %s", log_label, e)
        polygon_points = None

    return {'base_range_km': base_range_km, 'polygon_points': polygon_points}
