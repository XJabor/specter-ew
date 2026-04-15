import logging
import os
import secrets 
from core.link_budget import watts_to_dbm, calculate_eirp, apply_hopping_tax
from flask import Flask, render_template, request, jsonify, Response, session, redirect, url_for
from werkzeug.middleware.proxy_fix import ProxyFix
from core.propagation import calculate_path_loss, calculate_received_power, evaluate_jamming_effect, calculate_sensing_distance
from core.elevation import get_elevation_profile, get_point_elevations, check_line_of_sight, destination_point, get_elevation_profiles_batch
from core.antenna import bearing_deg, directional_gain_db
from shapely.geometry import Polygon, MultiPolygon

app = Flask(__name__)
# Tell Flask it is behind one proxy
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

app.config['MAX_CONTENT_LENGTH'] = 1 * 1024 * 1024  # 1 MB
app.secret_key = os.environ.get('FLASK_SECRET_KEY')
if not app.secret_key:
    app.secret_key = secrets.token_hex(32)

# Enforce secure cookies in production
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

@app.before_request
def check_auth():
    # 1. Allow local machine bypass
    if request.host.startswith('localhost:') or request.host.startswith('127.0.0.1:'):
        return

    # 2. Always allow access to the login page and static assets (CSS/JS/images)
    if request.endpoint in ['login', 'static']:
        return

    # 3. If no credentials are set in the environment, leave the app open
    raw = os.environ.get('APP_CREDENTIALS', '').strip()
    if not raw:
        return

    # 4. Check if the user has a valid session
    if not session.get('authenticated'):
        return redirect(url_for('login'))

@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Permissions-Policy'] = 'geolocation=(), camera=(), microphone=()'
    response.headers['Content-Security-Policy'] = (
        "default-src 'none'; "
        "script-src 'self' https://unpkg.com 'unsafe-inline'; "
        "style-src 'self' https://unpkg.com 'unsafe-inline'; "
        "img-src 'self' https: data:; "
        "connect-src 'self'; "
        "font-src 'self'"
    )
    return response

@app.route('/')
def index():
    # This serves your HTML page when you open the browser
    return render_template('index.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        # Parse the existing environment variable
        raw = os.environ.get('APP_CREDENTIALS', '').strip()
        valid_users = {}
        if raw:
            for pair in raw.split(','):
                if ':' in pair:
                    u, p = pair.split(':', 1)
                    valid_users[u.strip()] = p.strip()
        
        if valid_users.get(username) == password:
            session['authenticated'] = True
            return redirect(url_for('index'))
        else:
            error = "Invalid credentials"
            
    return render_template('login.html', error=error)

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
                    float(rx_lat), float(rx_lon)
                )
                jammer_los = check_line_of_sight(profile, freq_mhz, jammer_antenna_height_m, rx_antenna_height_m)
            except Exception:
                pass  # fall back to no elevation data

        if all(v is not None for v in [tx_lat, tx_lon, rx_lat, rx_lon]):
            try:
                profile = get_elevation_profile(
                    float(tx_lat), float(tx_lon),
                    float(rx_lat), float(rx_lon)
                )
                enemy_los = check_line_of_sight(profile, freq_mhz, tx_antenna_height_m, rx_antenna_height_m)
            except Exception:
                pass

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
        enemy_path_loss = calculate_path_loss(enemy_dist_km, freq_mhz, enemy_terrain, enemy_diff_db)
        enemy_rx_signal = calculate_received_power(enemy_eirp, enemy_path_loss) + eff_enemy_rx_gain_signal

        # Jammer Math
        jammer_tx_dbm = watts_to_dbm(jammer_tx_w)
        jammer_eirp_raw = calculate_eirp(jammer_tx_dbm, eff_jammer_tx_gain)

        if apply_fh:
            jammer_eirp_taxed = apply_hopping_tax(jammer_eirp_raw, jammer_bw_khz, enemy_bw_khz)
        else:
            jammer_eirp_taxed = jammer_eirp_raw

        jammer_path_loss = calculate_path_loss(jammer_dist_km, freq_mhz, jammer_terrain, jammer_diff_db)
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
        })
    except Exception as e:
        app.logger.error("calculate_ea error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})

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
        num_bearings   = int(data.get('num_bearings', 36))

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

        # On-boresight (peak) range used for the tooltip label and initial path endpoints
        peak_eirp     = eirp_at_bearing(tx_azimuth_deg if tx_antenna_type == 'directional' else 0)
        base_range_km = calculate_sensing_distance(
            peak_eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity
        )

        # Build one endpoint per bearing at the peak baseline range
        bearings = [360.0 * i / num_bearings for i in range(num_bearings)]
        paths = []
        for bearing in bearings:
            end_lat, end_lon = destination_point(enemy_lat, enemy_lon, bearing, base_range_km)
            paths.append((enemy_lat, enemy_lon, end_lat, end_lon))

        polygon_points = None
        try:
            profiles = get_elevation_profiles_batch(paths, num_samples=12)
            polygon_points = []
            for bearing, profile in zip(bearings, profiles):
                eirp = eirp_at_bearing(bearing)
                los = check_line_of_sight(profile, freq_mhz, tx_antenna_height_m, 0.0)
                diff_db = los['diffraction_loss_db']
                range_km = calculate_sensing_distance(
                    eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity, diff_db
                )
                # Enforce a minimum so the polygon always closes cleanly
                range_km = max(range_km, 0.05)
                pt_lat, pt_lon = destination_point(enemy_lat, enemy_lon, bearing, range_km)
                polygon_points.append([pt_lat, pt_lon])
        except Exception:
            polygon_points = None  # elevation unavailable; caller falls back to circle

        return jsonify({
            'status': 'success',
            'base_range_km': base_range_km,
            'polygon_points': polygon_points,
        })
    except Exception as e:
        app.logger.error("calculate_es_terrain error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})


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


if __name__ == '__main__':
    # host='0.0.0.0' allows you to access this from a tablet on the same Wi-Fi
    app.run(debug=False, host='0.0.0.0', port=5000)