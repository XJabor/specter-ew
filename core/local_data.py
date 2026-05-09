import logging
import math
import os
import re
from pathlib import Path

_logger = logging.getLogger(__name__)

_dted_index = {}     # (lon_int, lat_int) -> Path; highest DTED level wins
_imagery_index = []  # list of {path, bounds:(W,S,E,N)} in WGS84

# Set by app.py before scan_local_data() is called.
# app.py reads LOCAL_DATA_DIR env var / specter_config.json and writes these.
LOCAL_DATA_DIR = Path('local_data')
_locked = False      # True when path is fixed by the LOCAL_DATA_DIR env var

_DTED_LEVEL = {'.dt2': 2}
_SCAN_LIMIT  = 50_000  # abort scan if directory contains more files than this


def scan_local_data():
    """Walk LOCAL_DATA_DIR to build DTED and imagery indexes.

    Uses os.walk with followlinks=False to prevent symlink escapes.
    Aborts after _SCAN_LIMIT files to prevent DoS on runaway paths.
    DTED coverage is derived purely from filenames (no file I/O).
    Imagery bounds are read from GeoTIFF headers (pixel data not loaded).
    """
    global _dted_index, _imagery_index
    _dted_index = {}
    _imagery_index = []

    if not LOCAL_DATA_DIR.exists():
        _logger.info("LOCAL_DATA_DIR '%s' not found; no local geospatial data loaded", LOCAL_DATA_DIR)
        return

    try:
        import rasterio
        from rasterio.warp import transform_bounds
        rasterio_ok = True
    except ImportError:
        _logger.warning("rasterio not installed — local DTED sampling and imagery tiles disabled")
        rasterio_ok = False

    file_count = 0
    truncated  = False

    for dirpath, _dirs, filenames in os.walk(str(LOCAL_DATA_DIR), followlinks=False):
        for filename in filenames:
            file_count += 1
            if file_count > _SCAN_LIMIT:
                truncated = True
                break
            path   = Path(dirpath) / filename
            suffix = path.suffix.lower()

            if suffix in _DTED_LEVEL:
                try:
                    key = _parse_dted_coords(path)
                except ValueError:
                    continue
                existing = _dted_index.get(key)
                if existing is None or _DTED_LEVEL[suffix] > _DTED_LEVEL[existing.suffix.lower()]:
                    _dted_index[key] = path

            elif suffix in ('.tif', '.tiff') and rasterio_ok:
                try:
                    with rasterio.open(path) as ds:
                        bounds = transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds)
                        _imagery_index.append({'path': path, 'bounds': bounds})
                except Exception as exc:
                    _logger.warning("Could not index imagery '%s': %s", filename, exc)

        if truncated:
            _logger.warning(
                "Scan limit (%d files) reached in '%s'; results may be incomplete",
                _SCAN_LIMIT, LOCAL_DATA_DIR,
            )
            break

    _logger.info(
        "Local data scan: %d DTED cells, %d imagery file(s) in '%s'",
        len(_dted_index), len(_imagery_index), LOCAL_DATA_DIR,
    )


def get_status():
    """Return current data directory state for the API status endpoint."""
    return {
        'path':          str(LOCAL_DATA_DIR),
        'dted_cells':    len(_dted_index),
        'imagery_files': len(_imagery_index),
        'locked':        _locked,
    }


def _parse_dted_coords(path):
    """Return (lon_int, lat_int) from a DTED file's parent directory and stem.

    Standard layout: <e|w><lon>/<n|s><lat>.<level>
    Example: w136/N67.DT2 → (-136, 67)
    Raises ValueError if the path does not match the expected pattern.
    """
    stem   = path.stem.upper()         # "N67"
    parent = path.parent.name.upper()  # "W136"

    lat_m = re.fullmatch(r'([NS])(\d+)', stem)
    lon_m = re.fullmatch(r'([EW])(\d+)', parent)
    if not lat_m or not lon_m:
        raise ValueError

    lat = int(lat_m.group(2)) * (1 if lat_m.group(1) == 'N' else -1)
    lon = int(lon_m.group(2)) * (1 if lon_m.group(1) == 'E' else -1)
    return (lon, lat)


def sample_dted(locations):
    """Sample elevations from local DTED for a list of {latitude, longitude} dicts.

    Returns list[float | None].  None means no local DTED covers that point;
    the caller should fall back to the online API for those indices.
    """
    if not _dted_index:
        return [None] * len(locations)

    try:
        import rasterio
        from rasterio.transform import rowcol
    except ImportError:
        return [None] * len(locations)

    results = [None] * len(locations)
    open_ds = {}
    band_arrays = {}  # read each file's band once; reuse for all points in that cell

    try:
        for i, loc in enumerate(locations):
            lat, lon = loc['latitude'], loc['longitude']
            key = (int(math.floor(lon)), int(math.floor(lat)))
            path = _dted_index.get(key)
            if path is None:
                continue
            if path not in open_ds:
                try:
                    open_ds[path] = rasterio.open(path)
                except Exception as exc:
                    _logger.warning("Cannot open DTED '%s': %s", path.name, exc)
                    continue
            ds = open_ds[path]
            if path not in band_arrays:
                band_arrays[path] = ds.read(1)
            try:
                row, col = rowcol(ds.transform, lon, lat)
                row, col = int(row), int(col)
                if 0 <= row < ds.height and 0 <= col < ds.width:
                    val = float(band_arrays[path][row, col])
                    results[i] = 0.0 if val < -32000 else val
            except Exception as exc:
                _logger.debug("DTED sample error at (%.4f, %.4f): %s", lat, lon, exc)
    finally:
        for ds in open_ds.values():
            ds.close()

    return results


def is_locally_covered(lat, lon, radius_km):
    """Return True if every DTED cell within radius_km of (lat, lon) is in the local index."""
    if not _dted_index:
        return False
    dlat = radius_km / 111.32
    dlon = radius_km / (111.32 * math.cos(math.radians(lat)))
    for lat_i in range(int(math.floor(lat - dlat)), int(math.floor(lat + dlat)) + 1):
        for lon_i in range(int(math.floor(lon - dlon)), int(math.floor(lon + dlon)) + 1):
            if (lon_i, lat_i) not in _dted_index:
                return False
    return True


def get_imagery_for_tile(z, x, y):
    """Return a local imagery file Path whose coverage includes XYZ tile (z, x, y), or None."""
    if not _imagery_index:
        return None
    west, south, east, north = _tile_bounds_wgs84(z, x, y)
    for entry in _imagery_index:
        w, s, e, n = entry['bounds']
        if west < e and east > w and south < n and north > s:
            return entry['path']
    return None


def render_tile_png(path, z, x, y):
    """Reproject and render a 256×256 PNG tile from a local GeoTIFF.

    Warps the source data to Web Mercator (EPSG:3857) for the requested tile.
    Returns PNG bytes, or None on any failure so the caller can return HTTP 204.
    """
    try:
        import rasterio
        from rasterio.warp import reproject, Resampling
        from rasterio.transform import from_bounds
        import numpy as np
        from PIL import Image
        import io
    except ImportError as exc:
        _logger.warning("Missing dependency for tile rendering: %s", exc)
        return None

    # Tile bounds in Web Mercator (EPSG:3857)
    HALF = 20037508.342789244
    n_tiles = 2 ** z
    merc_w = x       / n_tiles * 2 * HALF - HALF
    merc_e = (x + 1) / n_tiles * 2 * HALF - HALF
    merc_n = HALF - y       / n_tiles * 2 * HALF
    merc_s = HALF - (y + 1) / n_tiles * 2 * HALF
    dst_transform = from_bounds(merc_w, merc_s, merc_e, merc_n, 256, 256)

    try:
        with rasterio.open(path) as src:
            band_count = min(src.count, 3)
            dst = np.zeros((band_count, 256, 256), dtype=np.uint8)

            for b in range(1, band_count + 1):
                band_f32 = np.zeros((256, 256), dtype=np.float32)
                reproject(
                    source=rasterio.band(src, b),
                    destination=band_f32,
                    dst_transform=dst_transform,
                    dst_crs='EPSG:3857',
                    resampling=Resampling.bilinear,
                )
                src_dtype = src.dtypes[b - 1]
                if src_dtype == 'uint8':
                    dst[b - 1] = band_f32.clip(0, 255).astype(np.uint8)
                elif src_dtype == 'uint16':
                    dst[b - 1] = (band_f32 / 65535.0 * 255).clip(0, 255).astype(np.uint8)
                else:
                    vmax = float(band_f32.max())
                    if vmax > 0:
                        dst[b - 1] = (band_f32 / vmax * 255).clip(0, 255).astype(np.uint8)

            img_array = dst[0] if band_count == 1 else np.moveaxis(dst, 0, -1)
            mode = 'L' if band_count == 1 else 'RGB'
            img = Image.fromarray(img_array, mode=mode)
            if band_count == 1:
                img = img.convert('RGB')

            buf = io.BytesIO()
            img.save(buf, format='PNG')
            return buf.getvalue()

    except Exception as exc:
        _logger.warning("Tile render failed z=%d x=%d y=%d '%s': %s", z, x, y, path.name, exc)
        return None


def _tile_bounds_wgs84(z, x, y):
    """Convert XYZ Web Mercator tile coordinates to WGS84 (west, south, east, north)."""
    n = 2 ** z
    west  = x       / n * 360.0 - 180.0
    east  = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return west, south, east, north
