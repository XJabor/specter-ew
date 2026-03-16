import logging
from core.link_budget import watts_to_dbm, calculate_eirp, apply_hopping_tax
from flask import Flask, render_template, request, jsonify
from core.propagation import calculate_path_loss, calculate_received_power, evaluate_jamming_effect, calculate_sensing_distance

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

        # Enemy Math
        enemy_tx_dbm = watts_to_dbm(enemy_tx_w)
        enemy_eirp = calculate_eirp(enemy_tx_dbm, enemy_tx_gain)
        enemy_path_loss = calculate_path_loss(enemy_dist_km, freq_mhz, enemy_terrain)
        enemy_rx_signal = calculate_received_power(enemy_eirp, enemy_path_loss) + enemy_rx_gain

        # Jammer Math
        jammer_tx_dbm = watts_to_dbm(jammer_tx_w)
        jammer_eirp_raw = calculate_eirp(jammer_tx_dbm, jammer_tx_gain)
        
        if apply_fh:
            jammer_eirp_taxed = apply_hopping_tax(jammer_eirp_raw, jammer_bw_khz, enemy_bw_khz)
        else:
            jammer_eirp_taxed = jammer_eirp_raw
            
        jammer_path_loss = calculate_path_loss(jammer_dist_km, freq_mhz, jammer_terrain)
        jammer_rx_signal = calculate_received_power(jammer_eirp_taxed, jammer_path_loss) + enemy_rx_gain

        effect_text = evaluate_jamming_effect(jammer_rx_signal, enemy_rx_signal)
        margin = round(jammer_rx_signal - enemy_rx_signal, 2)

        return jsonify({
            'status': 'success',
            'enemy_rx_signal': enemy_rx_signal,
            'jammer_rx_signal': jammer_rx_signal,
            'margin': margin,
            'effect': effect_text
        })
    except Exception as e:
        app.logger.error("calculate_ea error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})

@app.route('/calculate_es', methods=['POST'])
def calculate_es():
    data = request.json
    try:
        freq_mhz = float(data.get('freq_mhz', 150))
        sensor_terrain = data.get('jammer_terrain', 'free space')
        
        enemy_tx_w = float(data.get('enemy_tx_w', 5))
        enemy_tx_gain = float(data.get('enemy_tx_gain', 0))
        
        rx_sensitivity = float(data.get('rx_sensitivity', -90))
        rx_gain = float(data.get('friendly_rx_gain', 0))
        
        enemy_tx_dbm = watts_to_dbm(enemy_tx_w)
        enemy_eirp = calculate_eirp(enemy_tx_dbm, enemy_tx_gain)
        
        dist_km = calculate_sensing_distance(enemy_eirp, freq_mhz, sensor_terrain, rx_gain, rx_sensitivity)
        
        return jsonify({'status': 'success', 'radius_km': dist_km})
    except Exception as e:
        app.logger.error("calculate_es error: %s", e)
        return jsonify({'status': 'error', 'message': 'Calculation error. Check your inputs.'})

if __name__ == '__main__':
    # host='0.0.0.0' allows you to access this from a tablet on the same Wi-Fi
    app.run(debug=False, host='0.0.0.0', port=5000)