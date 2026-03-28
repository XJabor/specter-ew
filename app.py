import logging
from core.link_budget import watts_to_dbm, calculate_eirp, apply_hopping_tax
from flask import Flask, render_template, request, jsonify
from core.propagation import calculate_path_loss, calculate_received_power, evaluate_jamming_effect, calculate_sensing_distance
from core.elevation import get_elevation_profile, check_line_of_sight, destination_point, get_elevation_profiles_batch

app = Flask(__name__)
logging.basicConfig(level=logging.ERROR)

@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    return response

@app.route('/')
def index():
    # This serves your HTML page when you open the browser
    return render_template('index.html')

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

        jammer_lat = data.get('jammer_lat')
        jammer_lon = data.get('jammer_lon')
        rx_lat     = data.get('rx_lat')
        rx_lon     = data.get('rx_lon')
        tx_lat     = data.get('tx_lat')
        tx_lon     = data.get('tx_lon')

        if all(v is not None for v in [jammer_lat, jammer_lon, rx_lat, rx_lon]):
            try:
                profile = get_elevation_profile(
                    float(jammer_lat), float(jammer_lon),
                    float(rx_lat), float(rx_lon)
                )
                jammer_los = check_line_of_sight(profile, freq_mhz)
            except Exception:
                pass  # fall back to no elevation data

        if all(v is not None for v in [tx_lat, tx_lon, rx_lat, rx_lon]):
            try:
                profile = get_elevation_profile(
                    float(tx_lat), float(tx_lon),
                    float(rx_lat), float(rx_lon)
                )
                enemy_los = check_line_of_sight(profile, freq_mhz)
            except Exception:
                pass

        jammer_diff_db = jammer_los['diffraction_loss_db'] if jammer_los else 0.0
        enemy_diff_db  = enemy_los['diffraction_loss_db']  if enemy_los  else 0.0

        # Enemy Math
        enemy_tx_dbm = watts_to_dbm(enemy_tx_w)
        enemy_eirp = calculate_eirp(enemy_tx_dbm, enemy_tx_gain)
        enemy_path_loss = calculate_path_loss(enemy_dist_km, freq_mhz, enemy_terrain, enemy_diff_db)
        enemy_rx_signal = calculate_received_power(enemy_eirp, enemy_path_loss) + enemy_rx_gain

        # Jammer Math
        jammer_tx_dbm = watts_to_dbm(jammer_tx_w)
        jammer_eirp_raw = calculate_eirp(jammer_tx_dbm, jammer_tx_gain)

        if apply_fh:
            jammer_eirp_taxed = apply_hopping_tax(jammer_eirp_raw, jammer_bw_khz, enemy_bw_khz)
        else:
            jammer_eirp_taxed = jammer_eirp_raw

        jammer_path_loss = calculate_path_loss(jammer_dist_km, freq_mhz, jammer_terrain, jammer_diff_db)
        jammer_rx_signal = calculate_received_power(jammer_eirp_taxed, jammer_path_loss) + enemy_rx_gain

        effect_text = evaluate_jamming_effect(jammer_rx_signal, enemy_rx_signal)
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
        freq_mhz      = float(data.get('freq_mhz', 150))
        sensor_terrain = data.get('enemy_terrain', 'free space')
        enemy_tx_w    = float(data.get('enemy_tx_w', 5))
        enemy_tx_gain = float(data.get('enemy_tx_gain', 0))
        rx_sensitivity = float(data.get('rx_sensitivity', -90))
        rx_gain        = float(data.get('friendly_rx_gain', 0))
        enemy_lat      = float(data['enemy_lat'])
        enemy_lon      = float(data['enemy_lon'])
        num_bearings   = int(data.get('num_bearings', 36))

        if freq_mhz <= 0:
            return jsonify({'status': 'error', 'message': 'Frequency must be greater than zero.'})
        if enemy_tx_w <= 0:
            return jsonify({'status': 'error', 'message': 'Transmit power must be greater than zero.'})

        enemy_tx_dbm = watts_to_dbm(enemy_tx_w)
        enemy_eirp   = calculate_eirp(enemy_tx_dbm, enemy_tx_gain)

        # Free-space baseline range (no terrain correction)
        base_range_km = calculate_sensing_distance(
            enemy_eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity
        )

        # Build one endpoint per bearing at the baseline range
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
                los = check_line_of_sight(profile, freq_mhz)
                diff_db = los['diffraction_loss_db']
                range_km = calculate_sensing_distance(
                    enemy_eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity, diff_db
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


if __name__ == '__main__':
    # host='0.0.0.0' allows you to access this from a tablet on the same Wi-Fi
    app.run(debug=False, host='0.0.0.0', port=5000)