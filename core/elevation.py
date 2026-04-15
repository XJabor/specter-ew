import math
import time
import requests

ELEVATION_API_URL = "https://api.opentopodata.org/v1/srtm30m"
_BATCH_SIZE = 100        # public API hard limit: 100 locations per request
_RATE_LIMIT_DELAY = 1.1  # seconds between requests; public API limit is 1 req/sec

EARTH_EFFECTIVE_RADIUS_KM = 8500  # 4/3 Earth model for standard atmosphere

# Module-level cache keyed by rounded coordinates to avoid redundant API calls
_profile_cache = {}


def _haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _fetch_online(locations):
    """POST a list of {latitude, longitude} dicts to Open-Topo-Data in batches.

    Splits requests into chunks of at most _BATCH_SIZE to stay within the
    public API's per-request location limit, sleeping _RATE_LIMIT_DELAY seconds
    between chunks to respect the 1 req/sec rate limit.

    Returns elevation values (metres) in the same order as the input.
    Raises requests.RequestException on network failure, or ValueError if the
    API returns an error status or an unexpected number of results.
    """
    all_elevations = []
    last_request_start = None

    for i in range(0, len(locations), _BATCH_SIZE):
        # Sleep only the remaining time needed since the last request started,
        # so that request latency counts toward the rate-limit window.
        if last_request_start is not None:
            elapsed = time.time() - last_request_start
            if elapsed < _RATE_LIMIT_DELAY:
                time.sleep(_RATE_LIMIT_DELAY - elapsed)

        last_request_start = time.time()
        chunk = locations[i:i + _BATCH_SIZE]
        loc_string = "|".join(
            f"{loc['latitude']},{loc['longitude']}" for loc in chunk
        )

        resp = requests.post(
            ELEVATION_API_URL,
            json={"locations": loc_string},
            timeout=30
        )
        resp.raise_for_status()

        body = resp.json()
        if body.get("status") != "OK":
            raise ValueError(f"Elevation API error: {body.get('error', 'unknown status')}")

        results = body.get("results", [])
        if len(results) != len(chunk):
            raise ValueError(
                f"Elevation API returned {len(results)} results for {len(chunk)} locations"
            )

        all_elevations.extend(r["elevation"] for r in results)

    return all_elevations


def get_point_elevations(points):
    """
    Get elevation for a list of {lat, lon} dicts.
    Returns a list of elevation values in metres (integers), same order as input.
    Raises requests.RequestException if the API is unreachable.
    """
    locations = [{"latitude": p["lat"], "longitude": p["lon"]} for p in points]
    return _fetch_online(locations)


def get_elevation_profile(lat1, lon1, lat2, lon2, num_samples=20):
    """
    Sample elevations along the path from (lat1,lon1) to (lat2,lon2).

    Returns a list of dicts: {lat, lon, elevation_m, distance_km}

    Results are cached by rounded coordinates (~11 m precision) to avoid
    redundant API calls on parameter-only changes (no node movement).

    Raises requests.RequestException if the elevation API is unreachable,
    allowing the caller to fall back to standard path loss calculations.
    """
    cache_key = (round(lat1, 4), round(lon1, 4),
                 round(lat2, 4), round(lon2, 4), num_samples)
    if cache_key in _profile_cache:
        return _profile_cache[cache_key]

    total_km = _haversine(lat1, lon1, lat2, lon2)

    locations = [
        {
            "latitude":  lat1 + (i / (num_samples - 1)) * (lat2 - lat1),
            "longitude": lon1 + (i / (num_samples - 1)) * (lon2 - lon1),
        }
        for i in range(num_samples)
    ]

    elevations = _fetch_online(locations)

    profile = []
    for i, (loc, elev) in enumerate(zip(locations, elevations)):
        profile.append({
            "lat":         loc["latitude"],
            "lon":         loc["longitude"],
            "elevation_m": elev if elev > -32000 else 0,  # handle SRTM voids
            "distance_km": (i / (num_samples - 1)) * total_km,
        })

    _profile_cache[cache_key] = profile
    return profile


def destination_point(lat, lon, bearing_deg, distance_km):
    """
    Compute the (lat, lon) that is distance_km away from (lat, lon)
    along the given bearing (degrees clockwise from north).
    """
    R = 6371.0
    d = distance_km / R
    brng = math.radians(bearing_deg)
    lat1 = math.radians(lat)
    lon1 = math.radians(lon)
    lat2 = math.asin(
        math.sin(lat1) * math.cos(d)
        + math.cos(lat1) * math.sin(d) * math.cos(brng)
    )
    lon2 = lon1 + math.atan2(
        math.sin(brng) * math.sin(d) * math.cos(lat1),
        math.cos(d) - math.sin(lat1) * math.sin(lat2),
    )
    return math.degrees(lat2), math.degrees(lon2)


def get_elevation_profiles_batch(paths, num_samples=12):
    """
    Query elevations for multiple paths in a single Open-Elevation API call.

    paths: list of (lat1, lon1, lat2, lon2) tuples
    num_samples: elevation sample points per path

    Returns a list of profiles (same order as paths), where each profile is
    the same format as get_elevation_profile().  Already-cached paths skip
    the API entirely; newly fetched ones are stored in _profile_cache.

    Raises requests.RequestException if the API call fails.
    """
    cache_keys = [
        (round(lat1, 4), round(lon1, 4), round(lat2, 4), round(lon2, 4), num_samples)
        for lat1, lon1, lat2, lon2 in paths
    ]

    # Separate paths that need a network fetch from those already cached
    uncached_indices = [i for i, k in enumerate(cache_keys) if k not in _profile_cache]

    if uncached_indices:
        # Build one flat list of locations for all un-cached paths
        all_locations = []
        slice_map = []  # (path_index, start, end) for reconstruction

        for idx in uncached_indices:
            lat1, lon1, lat2, lon2 = paths[idx]
            start = len(all_locations)
            for i in range(num_samples):
                t = i / (num_samples - 1)
                all_locations.append({
                    "latitude":  lat1 + t * (lat2 - lat1),
                    "longitude": lon1 + t * (lon2 - lon1),
                })
            slice_map.append((idx, start, start + num_samples))

        all_elevations = _fetch_online(all_locations)

        for path_idx, start, end in slice_map:
            lat1, lon1, lat2, lon2 = paths[path_idx]
            total_km = _haversine(lat1, lon1, lat2, lon2)
            profile = []
            for i, (loc, elev) in enumerate(
                zip(all_locations[start:end], all_elevations[start:end])
            ):
                profile.append({
                    "lat":         loc["latitude"],
                    "lon":         loc["longitude"],
                    "elevation_m": elev if elev > -32000 else 0,
                    "distance_km": (i / (num_samples - 1)) * total_km,
                })
            _profile_cache[cache_keys[path_idx]] = profile

    return [_profile_cache[k] for k in cache_keys]


def _knife_edge_loss_db(nu):
    """
    Knife-edge diffraction attenuation for Fresnel-Kirchhoff parameter ν.
    Returns a positive dB value representing extra attenuation beyond free space.
    Approximation from ITU-R P.526.
    """
    if nu <= -0.78:
        return 0.0
    elif nu <= 0:
        val = 0.5 - 0.62 * nu
    elif nu <= 1:
        val = 0.5 * math.exp(-0.95 * nu)
    elif nu <= 2.4:
        inner = 0.1184 - (0.38 - 0.1 * nu) ** 2
        val = 0.4 - math.sqrt(max(inner, 0.0))
    else:
        val = 0.225 / nu

    if val <= 0:
        return 60.0  # practical maximum (deep shadow zone)
    return max(0.0, -20.0 * math.log10(val))


def check_line_of_sight(profile, freq_mhz, tx_height_agl_m=0.0, rx_height_agl_m=0.0):
    """
    Determine geometric LOS with Earth curvature correction and estimate
    knife-edge diffraction loss for the worst obstruction.

    Args:
        profile: list of {lat, lon, elevation_m, distance_km} from
                 get_elevation_profile()
        freq_mhz: link frequency in MHz
        tx_height_agl_m: transmitter antenna height above ground level (metres)
        rx_height_agl_m: receiver antenna height above ground level (metres)

    Returns:
        {
            "is_los": bool,
            "max_obstruction_m": float,   # > 0 means terrain is above LOS line
            "obstruction_distance_km": float,
            "diffraction_loss_db": float, # 0 when is_los is True
        }
    """
    clear = {"is_los": True, "max_obstruction_m": 0.0,
             "obstruction_distance_km": 0.0, "diffraction_loss_db": 0.0}

    if len(profile) < 2:
        return clear

    h1 = profile[0]["elevation_m"]  + tx_height_agl_m
    h2 = profile[-1]["elevation_m"] + rx_height_agl_m
    D  = profile[-1]["distance_km"]

    if D <= 0:
        return clear

    max_obstruction = -float("inf")
    worst_d1 = 0.0

    for sample in profile[1:-1]:
        d1 = sample["distance_km"]
        d2 = D - d1

        # Earth bulge correction (metres) using 4/3 effective Earth radius
        bulge_m = (d1 * d2 / (2.0 * EARTH_EFFECTIVE_RADIUS_KM)) * 1000.0

        # Height of the straight LOS line at this sample point
        los_h = h1 + (h2 - h1) * (d1 / D)

        # Positive value → terrain (+ bulge) breaches the LOS line
        obstruction = (sample["elevation_m"] + bulge_m) - los_h

        if obstruction > max_obstruction:
            max_obstruction = obstruction
            worst_d1 = d1

    # Treat as LOS when obstruction is below 1 m:
    #   - SRTM vertical accuracy is ~1-2 m, so sub-metre values are noise
    #   - Avoids double-counting the ground-reflection loss already embedded
    #     in the 40-log propagation model
    LOS_THRESHOLD_M = 1.0
    is_los = max_obstruction <= LOS_THRESHOLD_M
    diffraction_db = 0.0

    if not is_los:
        d2_worst  = D - worst_d1
        d1_m      = worst_d1 * 1000.0
        d2_m      = d2_worst * 1000.0
        wavelength = 3e8 / (freq_mhz * 1e6)
        denom = wavelength * d1_m * d2_m
        if denom > 0:
            nu = max_obstruction * math.sqrt(2.0 * (d1_m + d2_m) / denom)
            diffraction_db = _knife_edge_loss_db(nu)

    return {
        "is_los":                  is_los,
        "max_obstruction_m":       round(max_obstruction, 1),
        "obstruction_distance_km": round(worst_d1, 3),
        "diffraction_loss_db":     round(diffraction_db, 1),
    }
