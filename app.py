import base64
import json
import logging
import os
import secrets
from pathlib import Path
from core.link_budget import watts_to_dbm, calculate_eirp, apply_hopping_tax
import jwt
from jwt import PyJWKClient
from flask import Flask, render_template, request, jsonify, Response, session, redirect, url_for
from flask_wtf.csrf import CSRFProtect
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.middleware.proxy_fix import ProxyFix
from core.propagation import calculate_path_loss, calculate_received_power, evaluate_jamming_effect, calculate_sensing_distance
from core.elevation import get_elevation_profile, get_point_elevations, check_line_of_sight, destination_point, get_elevation_profiles_batch
import core.local_data as _local_data
from core.local_data import scan_local_data, get_imagery_for_tile, render_tile_png, is_locally_covered, get_status
from core.antenna import bearing_deg, directional_gain_db
from shapely.geometry import Polygon, MultiPolygon

logging.basicConfig(level=logging.INFO, format='%(levelname)s %(name)s: %(message)s')

app = Flask(__name__)
# Tell Flask it is behind one proxy
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

app.config['MAX_CONTENT_LENGTH'] = 1 * 1024 * 1024  # 1 MB
# If authentication is enabled, a stable secret key is required. Without it, each Gunicorn
# worker generates its own random key, so sessions signed by one worker are rejected by
# another — causing random logouts under multi-worker deployments.
if os.environ.get('APP_CREDENTIALS') and not os.environ.get('FLASK_SECRET_KEY'):
    raise RuntimeError(
        "FLASK_SECRET_KEY must be set when APP_CREDENTIALS is configured. "
        "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\""
    )
app.secret_key = os.environ.get('FLASK_SECRET_KEY') or secrets.token_hex(32)

# Set SPECTER_HTTPS=true when the app is served over TLS (e.g. Digital Ocean + nginx/Caddy).
# Leave unset for plain-HTTP LAN deployments — Secure cookies are silently dropped by browsers
# over HTTP and will cause an infinite login redirect loop.
_https = os.environ.get('SPECTER_HTTPS', '').lower() == 'true'
app.config['SESSION_COOKIE_SECURE'] = _https
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

csrf = CSRFProtect(app)
limiter = Limiter(app=app, key_func=get_remote_address, default_limits=[])

# ── Clerk authentication (HTTPS deployments) ──────────────────────────────────
# Set CLERK_PUBLISHABLE_KEY to enable Clerk. The Frontend API URL is derived
# automatically from the key so only one env var is needed.

_CLERK_PK = os.environ.get('CLERK_PUBLISHABLE_KEY', '').strip()

def _derive_clerk_frontend_api(pk: str) -> str:
    """Decode the Frontend API URL embedded in a Clerk publishable key."""
    try:
        encoded = pk.split('_', 2)[2]
        padded = encoded + '=' * (-len(encoded) % 4)
        decoded = base64.urlsafe_b64decode(padded).decode('utf-8').rstrip('$')
        return 'https://' + decoded
    except Exception:
        return ''

_CLERK_FRONTEND_API = (
    os.environ.get('CLERK_FRONTEND_API', '').strip().rstrip('/')
    or _derive_clerk_frontend_api(_CLERK_PK)
)

_clerk_jwks_client: PyJWKClient | None = None

def _get_clerk_jwks_client() -> PyJWKClient:
    global _clerk_jwks_client
    if _clerk_jwks_client is None:
        _clerk_jwks_client = PyJWKClient(
            f"{_CLERK_FRONTEND_API}/.well-known/jwks.json",
            cache_keys=True,
        )
    return _clerk_jwks_client

def _verify_clerk_session(token: str) -> dict:
    client = _get_clerk_jwks_client()
    signing_key = client.get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        options={"verify_aud": False},
    )

def _walk_profile_to_range(profile, freq_mhz, terrain, eirp, rx_gain, rx_sensitivity, tx_height_m):
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
                return max(0.05, d_i / 2.0)
            frac = (max_loss - prev_pl) / max(pl_i - prev_pl, 1e-9)
            frac = max(0.0, min(1.0, frac))
            return prev_d + frac * (d_i - prev_d)
        prev_pl = pl_i
        prev_d  = d_i

    return profile[-1]['distance_km']


def _ea_profile_samples(distance_km):
    """Terrain sample count for point-to-point EA links."""
    if distance_km <= 5.0:
        return 48
    if distance_km <= 15.0:
        return 72
    return 96


@app.before_request
def check_auth():
    # 1. Allow local machine bypass — check the actual connection IP, not the Host header.
    # The Host header is client-controlled and can be spoofed to bypass auth.
    # ProxyFix(x_for=1) ensures request.remote_addr reflects the real client IP.
    if request.remote_addr in ('127.0.0.1', '::1'):
        return

    # 2. Always allow access to the login page and static assets (CSS/JS/images)
    if request.endpoint in ('login', 'static'):
        return

    # 3a. Clerk auth — stateless JWT verification via __session cookie
    if _CLERK_PK:
        token = request.cookies.get('__session')
        if not token:
            return redirect(url_for('login'))
        try:
            _verify_clerk_session(token)
            return
        except Exception:
            return redirect(url_for('login'))

    # 3b. Legacy APP_CREDENTIALS session auth (LAN deployments)
    raw = os.environ.get('APP_CREDENTIALS', '').strip()
    if not raw:
        return
    if not session.get('authenticated'):
        return redirect(url_for('login'))

@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    # response.headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(), camera=(), microphone=()'
    clerk = f" {_CLERK_FRONTEND_API}" if _CLERK_FRONTEND_API else ""
    worker = " blob:" if _CLERK_FRONTEND_API else ""
    response.headers['Content-Security-Policy'] = (
        "default-src 'none'; "
        f"script-src 'self' https://unpkg.com 'unsafe-inline'{clerk}; "
        f"style-src 'self' https://unpkg.com 'unsafe-inline'{clerk}; "
        "img-src 'self' https: data:; "
        f"connect-src 'self'{clerk}; "
        f"font-src 'self'{clerk}; "
        f"worker-src{worker}"
    )
    return response

@app.route('/')
def index():
    return render_template('index.html',
                           clerk_publishable_key=_CLERK_PK,
                           clerk_frontend_api=_CLERK_FRONTEND_API)

@app.route('/login', methods=['GET', 'POST'])
@limiter.limit("10 per minute")
def login():
    # When Clerk is active, the login page only serves the Clerk SignIn component.
    # POST is handled entirely by Clerk's JS; no server-side form processing.
    if _CLERK_PK:
        return render_template('login.html',
                               clerk_publishable_key=_CLERK_PK,
                               clerk_frontend_api=_CLERK_FRONTEND_API,
                               error=None)

    error = None
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        if not username or not password:
            error = "Invalid credentials"
        else:
            # Parse APP_CREDENTIALS env var: "user:pass,user2:pass2"
            raw = os.environ.get('APP_CREDENTIALS', '').strip()
            valid_users = {}
            if raw:
                for pair in raw.split(','):
                    if ':' in pair:
                        u, p = pair.split(':', 1)
                        valid_users[u.strip()] = p.strip()

            if valid_users.get(username) == password:
                session.clear()
                session['authenticated'] = True
                return redirect(url_for('index'))
            else:
                error = "Invalid credentials"

    return render_template('login.html',
                           clerk_publishable_key='',
                           clerk_frontend_api='',
                           error=error)


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))

@csrf.exempt
@app.route('/calculate_ea', methods=['POST'])
def calculate_ea():
    data = request.json
    try:
        freq_mhz = float(data.get('freq_mhz', 150))
        enemy_terrain = data.get('enemy_terrain', 'free space')
        jammer_terrain = data.get('jammer_terrain', 'free space')

        enemy_tx_w = float(data.get('enemy_tx_w', 5))
        enemy_tx_gain = float(data.get('enemy_tx_gain', 0))
        enemy_rx_gain = float(data.get('enemy_rx_gain', 0))
        enemy_dist_km = float(data.get('enemy_dist_km', 1.0))

        jammer_tx_w = float(data.get('jammer_tx_w', 20))
        jammer_tx_gain = float(data.get('jammer_tx_gain', 3))
        jammer_dist_km = float(data.get('jammer_dist_km', 1.0))

        apply_fh = data.get('apply_fh', False)
        enemy_bw_khz = float(data.get('enemy_bw_khz', 25))
        jammer_bw_khz = float(data.get('jammer_bw_khz', 25))

        if freq_mhz <= 0:
            return jsonify({'status': 'error', 'message': 'Frequency must be greater than zero.'})
        if enemy_tx_w <= 0 or jammer_tx_w <= 0:
            return jsonify({'status': 'error', 'message': 'Transmit power must be greater than zero.'})
        if enemy_dist_km <= 0 or jammer_dist_km <= 0:
            return jsonify({'status': 'error', 'message': 'Distance must be greater than zero.'})
        if enemy_bw_khz <= 0 or jammer_bw_khz <= 0:
            return jsonify({'status': 'error', 'message': 'Bandwidth must be greater than zero.'})

        # Optional elevation-aware LOS analysis
        jammer_los = None
        enemy_los = None
        terrain_warnings = []

        # Per-node antenna parameters (all default to omni if absent)
        tx_antenna_type      = data.get('tx_antenna_type', 'omni')
        tx_azimuth_deg       = float(data.get('tx_azimuth_deg', 0))
        tx_beamwidth_deg     = float(data.get('tx_beamwidth_deg', 90))
        rx_antenna_type      = data.get('rx_antenna_type', 'omni')
        rx_azimuth_deg       = float(data.get('rx_azimuth_deg', 0))
        rx_beamwidth_deg     = float(data.get('rx_beamwidth_deg', 90))
        jammer_antenna_type  = data.get('jammer_antenna_type', 'omni')
        jammer_azimuth_deg   = float(data.get('jammer_azimuth_deg', 0))
        jammer_beamwidth_deg = float(data.get('jammer_beamwidth_deg', 90))
        tx_antenna_height_m     = float(data.get('tx_antenna_height_m', 0))
        rx_antenna_height_m     = float(data.get('rx_antenna_height_m', 0))
        jammer_antenna_height_m = float(data.get('jammer_antenna_height_m', 0))
        lower_threshold = float(data.get('lower_threshold', -6.0))
        upper_threshold = float(data.get('upper_threshold',  6.0))
        if upper_threshold <= lower_threshold:
            return jsonify({'status': 'error', 'message': '"Complete Jamming" threshold must be greater than "No Effect" threshold.'})

        jammer_lat = data.get('jammer_lat')
        jammer_lon = data.get('jammer_lon')
        rx_lat     = data.get('rx_lat')
        rx_lon     = data.get('rx_lon')
        tx_lat     = data.get('tx_lat')
        tx_lon     = data.get('tx_lon')

        for lat_val, label in [(jammer_lat, 'jammer_lat'), (rx_lat, 'rx_lat'), (tx_lat, 'tx_lat')]:
            if lat_val is not None and not (-90 <= float(lat_val) <= 90):
                return jsonify({'status': 'error', 'message': f'Invalid latitude: {label}.'})
        for lon_val, label in [(jammer_lon, 'jammer_lon'), (rx_lon, 'rx_lon'), (tx_lon, 'tx_lon')]:
            if lon_val is not None and not (-180 <= float(lon_val) <= 180):
                return jsonify({'status': 'error', 'message': f'Invalid longitude: {label}.'})

        if all(v is not None for v in [jammer_lat, jammer_lon, rx_lat, rx_lon]):
            try:
                profile = get_elevation_profile(
                    float(jammer_lat), float(jammer_lon),
                    float(rx_lat), float(rx_lon),
                    num_samples=_ea_profile_samples(jammer_dist_km)
                )
                jammer_los = check_line_of_sight(profile, freq_mhz, jammer_antenna_height_m, rx_antenna_height_m)
            except Exception as e:
                app.logger.warning("calculate_ea: jammer terrain lookup failed: %s", e)
                terrain_warnings.append("Jammer-to-target terrain data unavailable; used non-terrain path loss.")

        if all(v is not None for v in [tx_lat, tx_lon, rx_lat, rx_lon]):
            try:
                profile = get_elevation_profile(
                    float(tx_lat), float(tx_lon),
                    float(rx_lat), float(rx_lon),
                    num_samples=_ea_profile_samples(enemy_dist_km)
                )
                enemy_los = check_line_of_sight(profile, freq_mhz, tx_antenna_height_m, rx_antenna_height_m)
            except Exception as e:
                app.logger.warning("calculate_ea: enemy terrain lookup failed: %s", e)
                terrain_warnings.append("Enemy-link terrain data unavailable; used non-terrain path loss.")

        jammer_diff_db = jammer_los['diffraction_loss_db'] if jammer_los else 0.0
        enemy_diff_db  = enemy_los['diffraction_loss_db']  if enemy_los  else 0.0

        # Resolve effective antenna gains.
        # When all node coordinates are available, directional nodes apply bearing-based
        # Gaussian gain. Without coordinates we fall back to flat peak gains (omni behaviour).
        all_coords = all(v is not None for v in [tx_lat, tx_lon, rx_lat, rx_lon, jammer_lat, jammer_lon])
        if all_coords:
            tx_lat_f, tx_lon_f     = float(tx_lat),     float(tx_lon)
            rx_lat_f, rx_lon_f     = float(rx_lat),     float(rx_lon)
            jammer_lat_f, jammer_lon_f = float(jammer_lat), float(jammer_lon)

            if tx_antenna_type == 'directional':
                b = bearing_deg(tx_lat_f, tx_lon_f, rx_lat_f, rx_lon_f)
                eff_enemy_tx_gain = directional_gain_db(enemy_tx_gain, tx_azimuth_deg, b, tx_beamwidth_deg)
            else:
                eff_enemy_tx_gain = enemy_tx_gain

            if rx_antenna_type == 'directional':
                b_to_tx     = bearing_deg(rx_lat_f, rx_lon_f, tx_lat_f, tx_lon_f)
                b_to_jammer = bearing_deg(rx_lat_f, rx_lon_f, jammer_lat_f, jammer_lon_f)
                eff_enemy_rx_gain_signal = directional_gain_db(enemy_rx_gain, rx_azimuth_deg, b_to_tx,     rx_beamwidth_deg)
                eff_enemy_rx_gain_jammer = directional_gain_db(enemy_rx_gain, rx_azimuth_deg, b_to_jammer, rx_beamwidth_deg)
            else:
                eff_enemy_rx_gain_signal = enemy_rx_gain
                eff_enemy_rx_gain_jammer = enemy_rx_gain

            if jammer_antenna_type == 'directional':
                b = bearing_deg(jammer_lat_f, jammer_lon_f, rx_lat_f, rx_lon_f)
                eff_jammer_tx_gain = directional_gain_db(jammer_tx_gain, jammer_azimuth_deg, b, jammer_beamwidth_deg)
            else:
                eff_jammer_tx_gain = jammer_tx_gain
        else:
            # No coordinates: treat all antennas as omni regardless of type setting
            eff_enemy_tx_gain        = enemy_tx_gain
            eff_enemy_rx_gain_signal = enemy_rx_gain
            eff_enemy_rx_gain_jammer = enemy_rx_gain
            eff_jammer_tx_gain       = jammer_tx_gain

        # Enemy Math
        enemy_tx_dbm = watts_to_dbm(enemy_tx_w)
        enemy_eirp = calculate_eirp(enemy_tx_dbm, eff_enemy_tx_gain)
        enemy_path_loss = calculate_path_loss(
            enemy_dist_km, freq_mhz, enemy_terrain, enemy_diff_db,
            tx_antenna_height_m, rx_antenna_height_m,
            enemy_los['is_los'] if enemy_los else False
        )
        enemy_rx_signal = calculate_received_power(enemy_eirp, enemy_path_loss) + eff_enemy_rx_gain_signal

        # Jammer Math
        jammer_tx_dbm = watts_to_dbm(jammer_tx_w)
        jammer_eirp_raw = calculate_eirp(jammer_tx_dbm, eff_jammer_tx_gain)

        if apply_fh:
            jammer_eirp_taxed = apply_hopping_tax(jammer_eirp_raw, jammer_bw_khz, enemy_bw_khz)
        else:
            jammer_eirp_taxed = jammer_eirp_raw

        jammer_path_loss = calculate_path_loss(
            jammer_dist_km, freq_mhz, jammer_terrain, jammer_diff_db,
            jammer_antenna_height_m, rx_antenna_height_m,
            jammer_los['is_los'] if jammer_los else False
        )
        jammer_rx_signal = calculate_received_power(jammer_eirp_taxed, jammer_path_loss) + eff_enemy_rx_gain_jammer

        effect_text = evaluate_jamming_effect(jammer_rx_signal, enemy_rx_signal, lower_threshold, upper_threshold)
        margin = round(jammer_rx_signal - enemy_rx_signal, 2)

        return jsonify({
            'status': 'success',
            'enemy_rx_signal': enemy_rx_signal,
            'jammer_rx_signal': jammer_rx_signal,
            'margin': margin,
            'effect': effect_text,
            'jammer_los': jammer_los,
            'enemy_los': enemy_los,
            'terrain_warnings': terrain_warnings,
        })
    except Exception as e:
        app.logger.error("calculate_ea error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})

@csrf.exempt
@app.route('/calculate_es', methods=['POST'])
def calculate_es():
    data = request.json
    try:
        freq_mhz = float(data.get('freq_mhz', 150))
        sensor_terrain = data.get('enemy_terrain', 'free space')

        enemy_tx_w = float(data.get('enemy_tx_w', 5))
        enemy_tx_gain = float(data.get('enemy_tx_gain', 0))

        rx_sensitivity = float(data.get('rx_sensitivity', -90))
        rx_gain = float(data.get('friendly_rx_gain', 0))

        if freq_mhz <= 0:
            return jsonify({'status': 'error', 'message': 'Frequency must be greater than zero.'})
        if enemy_tx_w <= 0:
            return jsonify({'status': 'error', 'message': 'Transmit power must be greater than zero.'})

        enemy_tx_dbm = watts_to_dbm(enemy_tx_w)
        enemy_eirp = calculate_eirp(enemy_tx_dbm, enemy_tx_gain)

        dist_km = calculate_sensing_distance(enemy_eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity)
        
        return jsonify({'status': 'success', 'radius_km': dist_km})
    except Exception as e:
        app.logger.error("calculate_es error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})

@csrf.exempt
@app.route('/calculate_es_terrain', methods=['POST'])
def calculate_es_terrain():
    """
    Terrain-aware ES detection ring.  Returns polygon_points — one lat/lng per
    azimuth bearing — shaped by actual elevation data so the ring shrinks behind
    terrain that blocks detection.  Falls back gracefully if the elevation API
    is unavailable (polygon_points will be null).
    """
    data = request.json
    try:
        freq_mhz       = float(data.get('freq_mhz', 150))
        sensor_terrain = data.get('enemy_terrain', 'free space')
        enemy_tx_w     = float(data.get('enemy_tx_w', 5))
        enemy_tx_gain  = float(data.get('enemy_tx_gain', 0))
        rx_sensitivity = float(data.get('rx_sensitivity', -90))
        rx_gain        = float(data.get('friendly_rx_gain', 0))
        enemy_lat      = float(data['enemy_lat'])
        enemy_lon      = float(data['enemy_lon'])
        num_bearings   = int(data.get('num_bearings', 36))  # 36 × 12 = 432 points, 5 API requests

        # Per-node TX antenna parameters
        tx_antenna_type  = data.get('tx_antenna_type', 'omni')
        tx_azimuth_deg   = float(data.get('tx_azimuth_deg', 0))
        tx_beamwidth_deg = float(data.get('tx_beamwidth_deg', 90))
        tx_antenna_height_m = float(data.get('tx_antenna_height_m', 0))

        if freq_mhz <= 0:
            return jsonify({'status': 'error', 'message': 'Frequency must be greater than zero.'})
        if enemy_tx_w <= 0:
            return jsonify({'status': 'error', 'message': 'Transmit power must be greater than zero.'})
        if not (-90 <= enemy_lat <= 90):
            return jsonify({'status': 'error', 'message': 'Invalid latitude: enemy_lat.'})
        if not (-180 <= enemy_lon <= 180):
            return jsonify({'status': 'error', 'message': 'Invalid longitude: enemy_lon.'})
        if not (1 <= num_bearings <= 360):
            return jsonify({'status': 'error', 'message': 'num_bearings must be between 1 and 360.'})

        enemy_tx_dbm = watts_to_dbm(enemy_tx_w)

        def eirp_at_bearing(b):
            """Returns EIRP (dBm) toward bearing b, accounting for directional TX pattern."""
            if tx_antenna_type == 'directional':
                gain = directional_gain_db(enemy_tx_gain, tx_azimuth_deg, b, tx_beamwidth_deg)
            else:
                gain = enemy_tx_gain
            return calculate_eirp(enemy_tx_dbm, gain)

        # On-boresight (peak) range used for the tooltip label and initial path endpoints.
        # LOS (Two-Ray) is used for the label — it matches what flat terrain will actually show.
        # Profile endpoints use the larger of LOS and NLOS so elevation data always extends
        # to the furthest possible detection distance regardless of actual terrain.
        peak_eirp     = eirp_at_bearing(tx_azimuth_deg if tx_antenna_type == 'directional' else 0)
        base_range_km = calculate_sensing_distance(
            peak_eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity,
            tx_height_m=tx_antenna_height_m, is_los=True
        )
        proj_range_km = max(
            base_range_km,
            calculate_sensing_distance(
                peak_eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity,
                tx_height_m=tx_antenna_height_m, is_los=False
            )
        )

        # Use higher resolution when all terrain data is served from local DTED (no rate limits).
        # Fall back to API-safe values (36 bearings, 11 samples) when the online API is needed.
        if is_locally_covered(enemy_lat, enemy_lon, proj_range_km):
            num_bearings = 72
            num_samples  = 25
        else:
            num_bearings = 36
            num_samples  = 11

        # Build one endpoint per bearing at the projection range
        bearings = [360.0 * i / num_bearings for i in range(num_bearings)]
        paths = []
        for bearing in bearings:
            end_lat, end_lon = destination_point(enemy_lat, enemy_lon, bearing, proj_range_km)
            paths.append((enemy_lat, enemy_lon, end_lat, end_lon))

        polygon_points = None
        try:
            profiles = get_elevation_profiles_batch(paths, num_samples=num_samples)
            polygon_points = []
            for bearing, profile in zip(bearings, profiles):
                eirp = eirp_at_bearing(bearing)
                range_km = _walk_profile_to_range(
                    profile, freq_mhz, sensor_terrain,
                    eirp, rx_gain, rx_sensitivity, tx_antenna_height_m
                )
                range_km = max(range_km, 0.05)
                pt_lat, pt_lon = destination_point(enemy_lat, enemy_lon, bearing, range_km)
                polygon_points.append([pt_lat, pt_lon])
        except Exception as e:
            app.logger.warning("calculate_es_terrain: elevation API failed, falling back to circle: %s", e)
            polygon_points = None

        return jsonify({
            'status': 'success',
            'base_range_km': base_range_km,
            'polygon_points': polygon_points,
        })
    except Exception as e:
        app.logger.error("calculate_es_terrain error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})


@csrf.exempt
@app.route('/calculate_jammer_footprint', methods=['POST'])
def calculate_jammer_footprint():
    """
    Terrain-aware jammer power footprint.  Returns polygon_points — one lat/lng per
    azimuth bearing — shaped by terrain diffraction and the jammer's directional antenna
    pattern.  The boundary represents the range at which the jammer's received signal
    equals rx_sensitivity dBm (same reference used by ES rings).  Falls back to null
    polygon_points when the elevation API is unavailable.
    """
    data = request.json
    try:
        freq_mhz            = float(data.get('freq_mhz', 150))
        jammer_terrain      = data.get('jammer_terrain', 'free space')
        jammer_tx_w         = float(data.get('jammer_tx_w', 5))
        jammer_tx_gain      = float(data.get('jammer_tx_gain', 0))
        rx_sensitivity      = float(data.get('rx_sensitivity', -90))
        rx_gain             = float(data.get('friendly_rx_gain', 0))
        jammer_lat          = float(data['jammer_lat'])
        jammer_lon          = float(data['jammer_lon'])
        num_bearings        = int(data.get('num_bearings', 36))

        jammer_antenna_type  = data.get('jammer_antenna_type', 'omni')
        jammer_azimuth_deg   = float(data.get('jammer_azimuth_deg', 0))
        jammer_beamwidth_deg = float(data.get('jammer_beamwidth_deg', 90))
        jammer_antenna_height_m = float(data.get('jammer_antenna_height_m', 0))

        if freq_mhz <= 0:
            return jsonify({'status': 'error', 'message': 'Frequency must be greater than zero.'})
        if jammer_tx_w <= 0:
            return jsonify({'status': 'error', 'message': 'Transmit power must be greater than zero.'})
        if not (-90 <= jammer_lat <= 90):
            return jsonify({'status': 'error', 'message': 'Invalid latitude: jammer_lat.'})
        if not (-180 <= jammer_lon <= 180):
            return jsonify({'status': 'error', 'message': 'Invalid longitude: jammer_lon.'})
        if not (1 <= num_bearings <= 360):
            return jsonify({'status': 'error', 'message': 'num_bearings must be between 1 and 360.'})

        jammer_tx_dbm = watts_to_dbm(jammer_tx_w)

        def eirp_at_bearing(b):
            if jammer_antenna_type == 'directional':
                gain = directional_gain_db(jammer_tx_gain, jammer_azimuth_deg, b, jammer_beamwidth_deg)
            else:
                gain = jammer_tx_gain
            return calculate_eirp(jammer_tx_dbm, gain)

        peak_eirp     = eirp_at_bearing(jammer_azimuth_deg if jammer_antenna_type == 'directional' else 0)
        base_range_km = calculate_sensing_distance(
            peak_eirp, freq_mhz, jammer_terrain, rx_gain, rx_sensitivity,
            tx_height_m=jammer_antenna_height_m, is_los=True
        )
        proj_range_km = max(
            base_range_km,
            calculate_sensing_distance(
                peak_eirp, freq_mhz, jammer_terrain, rx_gain, rx_sensitivity,
                tx_height_m=jammer_antenna_height_m, is_los=False
            )
        )

        if is_locally_covered(jammer_lat, jammer_lon, proj_range_km):
            num_bearings = 72
            num_samples  = 25
        else:
            num_bearings = 36
            num_samples  = 11

        bearings = [360.0 * i / num_bearings for i in range(num_bearings)]
        paths = []
        for bearing in bearings:
            end_lat, end_lon = destination_point(jammer_lat, jammer_lon, bearing, proj_range_km)
            paths.append((jammer_lat, jammer_lon, end_lat, end_lon))

        polygon_points = None
        try:
            profiles = get_elevation_profiles_batch(paths, num_samples=num_samples)
            polygon_points = []
            for bearing, profile in zip(bearings, profiles):
                eirp = eirp_at_bearing(bearing)
                range_km = _walk_profile_to_range(
                    profile, freq_mhz, jammer_terrain,
                    eirp, rx_gain, rx_sensitivity, jammer_antenna_height_m
                )
                range_km = max(range_km, 0.05)
                pt_lat, pt_lon = destination_point(jammer_lat, jammer_lon, bearing, range_km)
                polygon_points.append([pt_lat, pt_lon])
        except Exception as e:
            app.logger.warning("calculate_jammer_footprint: elevation API failed, falling back to circle: %s", e)
            polygon_points = None

        return jsonify({
            'status': 'success',
            'base_range_km': base_range_km,
            'polygon_points': polygon_points,
        })
    except Exception as e:
        app.logger.error("calculate_jammer_footprint error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})


@csrf.exempt
@app.route('/compute_overlap', methods=['POST'])
def compute_overlap():
    data = request.json
    try:
        polygon_list = data.get('polygons', [])
        if len(polygon_list) < 2:
            return jsonify({'status': 'error', 'message': 'Need at least 2 polygons'})
        # polygon_list is [[[lat,lng],...], ...] — shapely Polygon expects (lng,lat)
        shapes = [Polygon([(lng, lat) for lat, lng in pts]) for pts in polygon_list]
        result = shapes[0]
        for s in shapes[1:]:
            result = result.intersection(s)
        if result.is_empty:
            return jsonify({'status': 'no-overlap'})
        # Normalize to list of polygons to handle MultiPolygon results
        polys = list(result.geoms) if isinstance(result, MultiPolygon) else [result]
        # Convert back to [[lat,lng],...], dropping the closing duplicate point
        intersection = [[[lat, lng] for lng, lat in p.exterior.coords[:-1]] for p in polys]
        return jsonify({'status': 'success', 'intersection': intersection})
    except Exception as e:
        app.logger.error("compute_overlap error: %s", e)
        return jsonify({'status': 'error', 'message': 'Overlap calculation error.'})


@csrf.exempt
@app.route('/get_elevations', methods=['POST'])
def get_elevations():
    points = request.json
    if not isinstance(points, list) or len(points) > 50:
        return jsonify({'elevations': []})
    for p in points:
        if not isinstance(p, dict) or 'lat' not in p or 'lon' not in p:
            return jsonify({'elevations': []})
        try:
            if not (-90 <= float(p['lat']) <= 90) or not (-180 <= float(p['lon']) <= 180):
                return jsonify({'elevations': []})
        except (TypeError, ValueError):
            return jsonify({'elevations': []})
    try:
        elevations = get_point_elevations(points)
        return jsonify({'elevations': elevations})
    except Exception:
        return jsonify({'elevations': [None] * len(points)})


@app.route('/tiles/local/<int:z>/<int:x>/<int:y>.png')
def local_tile(z, x, y):
    path = get_imagery_for_tile(z, x, y)
    if path is None:
        return Response(status=204)
    png = render_tile_png(path, z, x, y)
    if png is None:
        return Response(status=204)
    return Response(png, mimetype='image/png')


# ── Local data directory management (localhost-only) ─────────────────────────

_BLOCKED_DATA_PATHS = {'/', '/proc', '/sys', '/dev', '/etc', '/bin', '/sbin', '/usr'}


def _is_localhost():
    return request.remote_addr in ('127.0.0.1', '::1')


def _validate_data_path(raw):
    p = Path(raw.strip()).resolve()
    if not p.exists() or not p.is_dir():
        raise ValueError("Path does not exist or is not a directory")
    s = str(p)
    if s in _BLOCKED_DATA_PATHS or any(s.startswith(b + '/') for b in _BLOCKED_DATA_PATHS):
        raise ValueError("Path is restricted")
    return p


@app.route('/api/data_dir_status')
def data_dir_status():
    if not _is_localhost():
        return Response(status=403)
    return jsonify(get_status())


@csrf.exempt
@app.route('/api/rescan_data', methods=['POST'])
def rescan_data():
    if not _is_localhost():
        return Response(status=403)
    scan_local_data()
    return jsonify(get_status())


@csrf.exempt
@app.route('/api/set_data_dir', methods=['POST'])
def set_data_dir():
    if not _is_localhost():
        return Response(status=403)
    if _local_data._locked:
        return jsonify({'status': 'error', 'message': 'Path is locked by environment variable'})
    data = request.json or {}
    raw  = data.get('path', '').strip()
    if not raw:
        return jsonify({'status': 'error', 'message': 'Path is required'})
    try:
        p = _validate_data_path(raw)
    except ValueError as exc:
        return jsonify({'status': 'error', 'message': str(exc)})
    _local_data.LOCAL_DATA_DIR = p
    try:
        Path('specter_config.json').write_text(
            json.dumps({'local_data_dir': str(p)}, indent=2)
        )
    except Exception as exc:
        app.logger.warning("Could not save specter_config.json: %s", exc)
    scan_local_data()
    return jsonify({'status': 'success', **get_status()})


# ── Startup: resolve data directory from env var → config file → default ─────

def _init_data_dir():
    env_path = os.environ.get('LOCAL_DATA_DIR', '').strip()
    if env_path:
        _local_data.LOCAL_DATA_DIR = Path(env_path)
        _local_data._locked = True
    else:
        cfg = Path('specter_config.json')
        if cfg.exists():
            try:
                saved = json.loads(cfg.read_text()).get('local_data_dir', '')
                if saved:
                    _local_data.LOCAL_DATA_DIR = Path(saved)
            except Exception as exc:
                app.logger.warning("Could not read specter_config.json: %s", exc)
        _local_data._locked = False
    scan_local_data()


_init_data_dir()

if __name__ == '__main__':
    # host='0.0.0.0' allows you to access this from a tablet on the same Wi-Fi
    app.run(debug=False, host='0.0.0.0', port=5000)
