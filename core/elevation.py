import contextlib
import contextvars
import logging
import math
import threading
import time
import requests
from core.local_data import sample_dted

_logger = logging.getLogger(__name__)

ELEVATION_API_URL = "https://api.opentopodata.org/v1/srtm30m"
_BATCH_SIZE = 100        # public API hard limit: 100 locations per request
_RATE_LIMIT_DELAY = 1.1  # seconds between requests; public API limit is 1 req/sec
_MAX_RETRIES = 3         # retries of a 429 (rate-limited) response before giving up
_MAX_BACKOFF_S = 10.0    # cap on any single Retry-After / backoff wait

# Process-wide pacing clock for the public API; see _post_rate_limited().
_API_LOCK = threading.Lock()
_last_api_request = float('-inf')  # time.monotonic() of the last request start

EARTH_EFFECTIVE_RADIUS_KM = 8500  # 4/3 Earth model for standard atmosphere

# Module-level cache keyed by rounded coordinates to avoid redundant API calls
_profile_cache = {}
# Per-profile elevation provenance, same keys as _profile_cache:
# {'local': n, 'remote': n, 'void': n}, or None when the source is unknown.
_profile_source = {}

SRTM_VOID_M = -32000  # SRTM/DTED voids are reported as -32768

# Request-scoped provenance accumulator; see elevation_tally().
_tally = contextvars.ContextVar('elevation_tally', default=None)


class _Elevations(list):
    """Elevation list that also records which samples came from the remote API.

    A plain list subclass so callers (and test mocks returning plain lists)
    keep working; `remote` is a parallel list of bools, or absent."""

    def __init__(self, values, remote):
        super().__init__(values)
        self.remote = remote


@contextlib.contextmanager
def elevation_tally():
    """Collect elevation provenance for every profile fetched (or served from
    cache) inside the block.  Yields a dict that elevation_summary() reads."""
    tally = {'local': 0, 'remote': 0, 'void': 0, 'unknown_paths': 0, 'paths': 0}
    token = _tally.set(tally)
    try:
        yield tally
    finally:
        _tally.reset(token)


def _tally_profile(cache_key):
    tally = _tally.get()
    if tally is None:
        return
    tally['paths'] += 1
    source = _profile_source.get(cache_key)
    if source is None:
        tally['unknown_paths'] += 1
        return
    for k in ('local', 'remote', 'void'):
        tally[k] += source[k]


def _record_source(cache_key, elevations, start, end):
    remote = getattr(elevations, 'remote', None)
    if remote is None:
        _profile_source[cache_key] = None
        return
    values = elevations[start:end]
    n_remote = sum(1 for r in remote[start:end] if r)
    _profile_source[cache_key] = {
        'local': len(values) - n_remote,
        'remote': n_remote,
        'void': sum(1 for v in values if v is None or v <= SRTM_VOID_M),
    }


def elevation_summary(tally):
    """Condense an elevation_tally() dict into the diagnostic shape the
    frontend inspector reads."""
    local, remote = tally['local'], tally['remote']
    if tally['paths'] == 0:
        source = 'none'
    elif tally['unknown_paths'] == tally['paths']:
        source = 'unknown'
    elif remote and local:
        source = 'mixed'
    elif remote:
        source = 'remote'
    else:
        source = 'local'
    return {
        'source': source,
        'local_samples': local,
        'remote_samples': remote,
        'void_samples': tally['void'],
        'profiles': tally['paths'],
    }


def _haversine(lat1, lon1, lat2, lon2):
    """Great-circle distance in km."""
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _retry_after_seconds(resp, attempt):
    """Server-requested wait from a 429's Retry-After header (seconds form),
    else exponential backoff from the base rate-limit interval, capped."""
    header = resp.headers.get("Retry-After", "") if resp is not None else ""
    try:
        wait = float(header)
    except (TypeError, ValueError):
        wait = _RATE_LIMIT_DELAY * (2 ** attempt)
    return max(_RATE_LIMIT_DELAY, min(wait, _MAX_BACKOFF_S))


def _post_rate_limited(payload):
    """POST to the elevation API, paced process-wide and retried on 429.

    The public API allows 1 request/second per client. Flask (and each
    Gunicorn worker) serves requests on several threads, and a page load or
    scenario load fires the J/S, ring, footprint and EP calculations at
    once — so pacing inside one call is not enough: concurrent calls each
    hit the API immediately and most get 429 and fall back to flat circles.
    _API_LOCK makes every thread in the process queue behind one pacing
    clock; the lock is held across the request so only one call is ever in
    flight. Separate processes (multiple Gunicorn workers) can still collide
    occasionally, which the 429 retry absorbs.
    """
    global _last_api_request
    with _API_LOCK:
        for attempt in range(_MAX_RETRIES + 1):
            wait = _RATE_LIMIT_DELAY - (time.monotonic() - _last_api_request)
            if wait > 0:
                time.sleep(wait)
            _last_api_request = time.monotonic()
            resp = requests.post(ELEVATION_API_URL, json=payload, timeout=30)
            if resp.status_code != 429 or attempt == _MAX_RETRIES:
                resp.raise_for_status()
                return resp
            backoff = _retry_after_seconds(resp, attempt)
            _logger.info("elevation API rate-limited (429); retrying in %.1fs (attempt %d/%d)",
                         backoff, attempt + 1, _MAX_RETRIES)
            # Push the shared clock forward so the retry (and every queued
            # caller after it) waits out the backoff.
            _last_api_request = time.monotonic() + backoff - _RATE_LIMIT_DELAY


def _fetch_online(locations):
    """POST a list of {latitude, longitude} dicts to Open-Topo-Data in batches.

    Splits requests into chunks of at most _BATCH_SIZE to stay within the
    public API's per-request location limit. Every chunk goes through
    _post_rate_limited(), which paces all API traffic in this process to the
    1 req/sec limit and retries rate-limited requests.

    Returns elevation values (metres) in the same order as the input.
    Raises requests.RequestException on network failure, or ValueError if the
    API returns an error status or an unexpected number of results.
    """
    all_elevations = []

    for i in range(0, len(locations), _BATCH_SIZE):
        chunk = locations[i:i + _BATCH_SIZE]
        loc_string = "|".join(
            f"{loc['latitude']},{loc['longitude']}" for loc in chunk
        )

        resp = _post_rate_limited({"locations": loc_string})

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


def _fetch_elevations(locations):
    """Fetch elevations preferring local DTED, falling back to the online API.

    locations: list of {latitude, longitude} dicts
    Returns: list of elevation values in metres, same order as input.
    Raises requests.RequestException if the API is needed and unreachable.
    """
    local = sample_dted(locations)

    uncovered = [i for i, v in enumerate(local) if v is None]
    n_local = len(locations) - len(uncovered)
    remote = [False] * len(locations)
    if not uncovered:
        _logger.info("elevations: %d/%d from local DTED (all local)", n_local, len(locations))
        return _Elevations(local, remote)

    _logger.info("elevations: %d/%d from local DTED, %d from API", n_local, len(locations), len(uncovered))
    api_locs = [locations[i] for i in uncovered]
    api_results = _fetch_online(api_locs)

    for i, val in zip(uncovered, api_results):
        local[i] = val
        remote[i] = True

    return _Elevations(local, remote)


def get_point_elevations(points):
    """
    Get elevation for a list of {lat, lon} dicts.
    Returns a list of elevation values in metres (integers), same order as input.
    Raises requests.RequestException if the API is unreachable.
    """
    locations = [{"latitude": p["lat"], "longitude": p["lon"]} for p in points]
    return _fetch_elevations(locations)


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
        _tally_profile(cache_key)
        return _profile_cache[cache_key]

    total_km = _haversine(lat1, lon1, lat2, lon2)

    locations = [
        {
            "latitude":  lat1 + (i / (num_samples - 1)) * (lat2 - lat1),
            "longitude": lon1 + (i / (num_samples - 1)) * (lon2 - lon1),
        }
        for i in range(num_samples)
    ]

    elevations = _fetch_elevations(locations)

    profile = []
    for i, (loc, elev) in enumerate(zip(locations, elevations)):
        profile.append({
            "lat":         loc["latitude"],
            "lon":         loc["longitude"],
            "elevation_m": elev if elev > -32000 else 0,  # handle SRTM voids
            "distance_km": (i / (num_samples - 1)) * total_km,
        })

    _profile_cache[cache_key] = profile
    _record_source(cache_key, elevations, 0, num_samples)
    _tally_profile(cache_key)
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

        all_elevations = _fetch_elevations(all_locations)

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
            _record_source(cache_keys[path_idx], all_elevations, start, end)

    for k in cache_keys:
        _tally_profile(k)
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


def _deygout_loss_db(profile, freq_mhz, h_tx_abs, h_rx_abs):
    """
    Dominant-obstruction knife-edge diffraction loss (dB).

    The previous recursive Deygout implementation worked for sparse, discrete
    knife edges but badly over-counted continuous terrain. A smooth hill sampled
    at many points was treated as many independent obstacles, producing 100+ dB
    losses on short VHF links. For this planning tool's sampled terrain profiles,
    using the dominant Fresnel obstruction is a more stable approximation and
    avoids inflating J/S when one side of the link crosses broad terrain.

    profile    : list of {distance_km, elevation_m} ordered TX→RX
    freq_mhz   : link frequency in MHz
    h_tx_abs   : absolute height of TX endpoint (terrain elevation + AGL) in metres
    h_rx_abs   : absolute height of RX endpoint in metres
    """
    if len(profile) < 3:
        return 0.0

    d0 = profile[0]["distance_km"]
    D = profile[-1]["distance_km"] - d0
    if D <= 0:
        return 0.0

    wavelength_m = 3e8 / (freq_mhz * 1e6)

    best_nu = -float("inf")

    for i in range(1, len(profile) - 1):
        d1 = profile[i]["distance_km"] - d0
        d2 = profile[-1]["distance_km"] - profile[i]["distance_km"]
        if d1 <= 0 or d2 <= 0:
            continue

        bulge_m = (d1 * d2 / (2.0 * EARTH_EFFECTIVE_RADIUS_KM)) * 1000.0
        los_h = h_tx_abs + (h_rx_abs - h_tx_abs) * (d1 / D)
        obstruction = (profile[i]["elevation_m"] + bulge_m) - los_h

        d1_m = d1 * 1000.0
        d2_m = d2 * 1000.0
        denom = wavelength_m * d1_m * d2_m
        if denom <= 0:
            continue
        nu = obstruction * math.sqrt(2.0 * (d1_m + d2_m) / denom)

        if nu > best_nu:
            best_nu = nu

    if best_nu <= -0.78:
        return 0.0

    return _knife_edge_loss_db(best_nu)


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
        diffraction_db = _deygout_loss_db(profile, freq_mhz, h1, h2)

    return {
        "is_los":                  is_los,
        "max_obstruction_m":       round(max_obstruction, 1),
        "obstruction_distance_km": round(worst_d1, 3),
        "diffraction_loss_db":     round(diffraction_db, 1),
    }
