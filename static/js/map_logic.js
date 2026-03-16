// --- MAP INITIALIZATION & LAYERS ---

const streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors'
});

const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles © Esri'
});

const map = L.map('map', {
    center: [30.4632, -86.5345],
    zoom: 11,
    layers: [satelliteLayer] 
});

const baseMaps = {
    "Satellite": satelliteLayer,
    "Streets": streetLayer
};
L.control.layers(baseMaps).addTo(map);

let enemyTxMarker = null;
let enemyRxMarker = null;
let jammerMarker = null;
let enemyLinkLine = null;
let jammerLinkLine = null;

let isJammingActive = true; 
let isTxESActive = false; 
let isRxESActive = false; 
let txRangeCircle = null;
let rxRangeCircle = null;

const redIcon = new L.Icon({
    iconUrl: '/static/img/marker-icon-red.png',
    shadowUrl: '/static/img/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34]
});

const blueIcon = new L.Icon({
    iconUrl: '/static/img/marker-icon-blue.png',
    shadowUrl: '/static/img/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34]
});

// --- JUMP TO LOCATION LOGIC ---
document.getElementById('btn_search').addEventListener('click', function() {
    let input = document.getElementById('loc_search').value.trim();
    if (!input) return;

    let cleanInput = input.replace(/\s/g, '').toUpperCase();
    let isMGRS = /^[0-9]{1,2}[C-X][A-Z]{2}[0-9]+$/.test(cleanInput);

    if (isMGRS) {
        try {
            let digits = cleanInput.match(/\d+$/)[0];
            if (digits.length % 2 !== 0) {
                alert("MGRS Error: You have an odd number of Easting/Northing digits (" + digits.length + "). You must have an even pair.");
                return;
            }
            let point = mgrs.toPoint(cleanInput); 
            map.flyTo([point[1], point[0]], 14);
        } catch (e) {
            alert("MGRS Geometry Error: " + e.message + "\n\nDouble-check that your 100km square letters are valid for your UTM Zone.");
        }
    } else {
        let nums = cleanInput.match(/-?\d+(\.\d+)?/g);
        if (nums && (nums.length === 2 || nums.length === 6)) {
            let lat, lng;
            let isSouth = cleanInput.includes('S');
            let isWest = cleanInput.includes('W');

            if (nums.length === 2) {
                lat = parseFloat(nums[0]);
                lng = parseFloat(nums[1]);
            } else if (nums.length === 6) {
                lat = Math.abs(parseFloat(nums[0])) + parseFloat(nums[1])/60 + parseFloat(nums[2])/3600;
                lng = Math.abs(parseFloat(nums[3])) + parseFloat(nums[4])/60 + parseFloat(nums[5])/3600;
                if (parseFloat(nums[0]) < 0) lat = -lat; 
                if (parseFloat(nums[3]) < 0) lng = -lng;
            }

            if (isSouth && lat > 0) lat = -lat;
            if (isWest && lng > 0) lng = -lng;

            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                map.flyTo([lat, lng], 14);
            } else {
                alert("Coordinates out of bounds. Check your numbers.");
            }
        } else {
            alert("Could not parse format. Use Decimal (30.46, -86.53), DMS (31°12'09\"N 89°12'40\"W), or MGRS.");
        }
    }
});

document.getElementById('loc_search').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') document.getElementById('btn_search').click();
});

// --- TARGETING & UI LOGIC ---
function refreshPopups() {
    if (enemyTxMarker) {
        let esBtn = isTxESActive ? 
            `<button onclick="toggleESMode('tx', false)">🚫 Hide Detection Ring</button><br>` : 
            `<button onclick="toggleESMode('tx', true)">📡 Show Detection Ring</button><br>`;
        enemyTxMarker.bindPopup(`<b>Enemy Transmitter</b><br><button onclick="setAsTarget('enemyTx')">🎯 Target this Node</button><br>${esBtn}<button onclick="removeNode('enemyTx')">Remove</button>`);
    }
    if (enemyRxMarker) {
        let esBtn = isRxESActive ? 
            `<button onclick="toggleESMode('rx', false)">🚫 Hide Detection Ring</button><br>` : 
            `<button onclick="toggleESMode('rx', true)">📡 Show Detection Ring</button><br>`;
        enemyRxMarker.bindPopup(`<b>Targeted Receiver 🎯</b><br><i>Currently receiving signal</i><br>${esBtn}<button onclick="removeNode('enemyRx')">Remove</button>`);
    }
    if (jammerMarker) {
        let jamBtn = isJammingActive ? 
            `<button onclick="toggleJamming(false)">🛑 Cease Jamming (Untarget)</button><br>` : 
            `<button onclick="toggleJamming(true)">⚡ Resume Jamming</button><br>`;
        jammerMarker.bindPopup(`<b>Friendly Jammer / Sensor</b><br>${jamBtn}<button onclick="removeNode('jammer')">Remove</button>`);
    }
}

window.toggleJamming = function(state) {
    isJammingActive = state;
    refreshPopups();
    map.closePopup();
    updateTacticalPicture();
};

window.toggleESMode = function(nodeType, state) {
    if (nodeType === 'tx') isTxESActive = state;
    if (nodeType === 'rx') isRxESActive = state;
    refreshPopups();
    map.closePopup();
    updateTacticalPicture();
};

window.setAsTarget = function(currentRole) {
    if (currentRole === 'enemyTx' && enemyTxMarker && enemyRxMarker) {
        let temp = enemyTxMarker;
        enemyTxMarker = enemyRxMarker;
        enemyRxMarker = temp;
        let tempES = isTxESActive;
        isTxESActive = isRxESActive;
        isRxESActive = tempES;
        isJammingActive = true; 
        refreshPopups();
        map.closePopup(); 
        updateTacticalPicture();
    }
};

window.removeNode = function(nodeType) {
    if (nodeType === 'enemyTx') { 
        map.removeLayer(enemyTxMarker); enemyTxMarker = null; 
        isTxESActive = false; if(txRangeCircle) map.removeLayer(txRangeCircle);
    } 
    else if (nodeType === 'enemyRx') { 
        map.removeLayer(enemyRxMarker); enemyRxMarker = null; 
        isRxESActive = false; if(rxRangeCircle) map.removeLayer(rxRangeCircle);
    } 
    else if (nodeType === 'jammer') { 
        map.removeLayer(jammerMarker); jammerMarker = null; 
    }
    map.closePopup();
    updateTacticalPicture(); 
};

document.getElementById('clear-nodes-btn').addEventListener('click', function() {
    if (enemyTxMarker) map.removeLayer(enemyTxMarker);
    if (enemyRxMarker) map.removeLayer(enemyRxMarker);
    if (jammerMarker) map.removeLayer(jammerMarker);
    if (enemyLinkLine) map.removeLayer(enemyLinkLine);
    if (jammerLinkLine) map.removeLayer(jammerLinkLine);
    if (txRangeCircle) map.removeLayer(txRangeCircle);
    if (rxRangeCircle) map.removeLayer(rxRangeCircle);

    enemyTxMarker = null;
    enemyRxMarker = null;
    jammerMarker = null;
    enemyLinkLine = null;
    jammerLinkLine = null;
    txRangeCircle = null;
    rxRangeCircle = null;
    
    isJammingActive = true; 
    isTxESActive = false;
    isRxESActive = false;

    document.getElementById('js_margin').innerText = '--';
    document.getElementById('js_effect').innerText = 'Awaiting Map Placement...';
});

map.on('click', function(e) {
    if (!enemyTxMarker) {
        enemyTxMarker = L.marker(e.latlng, {icon: redIcon, draggable: true}).addTo(map);
        enemyTxMarker.on('dragend', updateTacticalPicture);
    } 
    else if (!enemyRxMarker) {
        enemyRxMarker = L.marker(e.latlng, {icon: redIcon, draggable: true}).addTo(map);
        enemyRxMarker.on('dragend', updateTacticalPicture);
    } 
    else if (!jammerMarker) {
        jammerMarker = L.marker(e.latlng, {icon: blueIcon, draggable: true}).addTo(map);
        jammerMarker.on('dragend', updateTacticalPicture);
    }
    refreshPopups();
    updateTacticalPicture();
});

// --- MGRS TOOLTIPS ---
function updateMGRSTooltips() {
    const markers = [enemyTxMarker, enemyRxMarker, jammerMarker];
    markers.forEach(function(marker) {
        if (!marker) return;
        const latlng = marker.getLatLng();
        const mgrsStr = mgrs.forward([latlng.lng, latlng.lat]);
        marker.bindTooltip(mgrsStr, {permanent: true, direction: 'top', className: 'mgrs-label'});
    });
}

// --- MATH & DRAWING ENGINE ---
function updateTacticalPicture() {
    if (!enemyTxMarker || !enemyRxMarker) {
        if (enemyLinkLine) { map.removeLayer(enemyLinkLine); enemyLinkLine = null; }
    }
    if (!enemyTxMarker || !enemyRxMarker || !jammerMarker || !isJammingActive) {
        if (jammerLinkLine) { map.removeLayer(jammerLinkLine); jammerLinkLine = null; }
        document.getElementById('js_margin').innerText = '--';
        document.getElementById('js_effect').innerText = isJammingActive ? 'Awaiting Map Placement...' : 'Jamming Ceased';
    }

    let enemyDistKm = 0;
    let jammerDistKm = 0;

    if (enemyTxMarker && enemyRxMarker) {
        enemyDistKm = enemyTxMarker.getLatLng().distanceTo(enemyRxMarker.getLatLng()) / 1000;
    }
    if (jammerMarker && enemyRxMarker) {
        jammerDistKm = jammerMarker.getLatLng().distanceTo(enemyRxMarker.getLatLng()) / 1000;
    }

    if (enemyTxMarker && enemyRxMarker) {
        if (enemyLinkLine) map.removeLayer(enemyLinkLine);
        enemyLinkLine = L.polyline([enemyTxMarker.getLatLng(), enemyRxMarker.getLatLng()], {color: 'red', dashArray: '5, 5'})
            .bindTooltip(enemyDistKm.toFixed(2) + " km", {permanent: true, direction: 'center', className: 'dist-label'})
            .addTo(map);
    }

    if (enemyTxMarker && enemyRxMarker && jammerMarker && isJammingActive) {
        const payload = {
            freq_mhz: document.getElementById('freq_mhz').value,
            enemy_terrain: document.getElementById('enemy_terrain').value, 
            jammer_terrain: document.getElementById('jammer_terrain').value, 
            enemy_tx_w: document.getElementById('enemy_tx_w').value,
            enemy_tx_gain: document.getElementById('enemy_tx_gain').value,
            enemy_rx_gain: document.getElementById('enemy_rx_gain').value,
            apply_fh: document.getElementById('fh_toggle').checked,
            enemy_bw_khz: document.getElementById('enemy_bw_khz').value,
            enemy_dist_km: enemyDistKm,
            jammer_tx_w: document.getElementById('jammer_tx_w').value,
            jammer_tx_gain: document.getElementById('jammer_tx_gain').value,
            jammer_bw_khz: document.getElementById('jammer_bw_khz').value,
            jammer_dist_km: jammerDistKm
        };

        fetch('/calculate_ea', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
        })
        .then(response => response.json())
        .then(data => {
            // NEW: Explicit Server Error Handling
            if (data.status === 'error') {
                document.getElementById('js_effect').innerText = 'SERVER ERROR: ' + data.message;
                document.getElementById('js_effect').style.color = 'red';
                return;
            }
            document.getElementById('js_effect').style.color = ''; // Reset color

            if (!jammerMarker || !enemyRxMarker || !isJammingActive) return;

            if(data.status === 'success') {
                document.getElementById('js_margin').innerText = data.margin;
                document.getElementById('js_effect').innerText = data.effect;
                
                let lineColor = 'gray';
                if (data.margin <= -6) lineColor = '#ff3333';        // Strong Red
                else if (data.margin > -6 && data.margin < 6) lineColor = '#ff9900'; // Deep Amber/Orange
                else lineColor = '#00ee00';                      // Distinct Solid Green                     

                if (jammerLinkLine) map.removeLayer(jammerLinkLine);
                jammerLinkLine = L.polyline([jammerMarker.getLatLng(), enemyRxMarker.getLatLng()], {color: lineColor, weight: 4})
                    .bindTooltip(jammerDistKm.toFixed(2) + " km", {permanent: true, direction: 'center', className: 'dist-label'})
                    .addTo(map);
            }
        });
    }

    if ((enemyTxMarker && isTxESActive) || (enemyRxMarker && isRxESActive)) {
        const esPayload = {
            freq_mhz: document.getElementById('freq_mhz').value,
            jammer_terrain: document.getElementById('jammer_terrain').value, 
            enemy_tx_w: document.getElementById('enemy_tx_w').value,
            enemy_tx_gain: document.getElementById('enemy_tx_gain').value,
            rx_sensitivity: document.getElementById('rx_sensitivity').value,
            friendly_rx_gain: document.getElementById('friendly_rx_gain').value
        };

        fetch('/calculate_es', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(esPayload)
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'error') return; // Fail silently on ES to not overwrite EA errors

            if(data.status === 'success') {
                let radiusMeters = data.radius_km * 1000;
                let radiusLabel = `Detection: ${data.radius_km.toFixed(2)} km`;

                if (enemyTxMarker && isTxESActive) {
                    if (txRangeCircle) map.removeLayer(txRangeCircle);
                    txRangeCircle = L.circle(enemyTxMarker.getLatLng(), {
                        color: 'red', fillColor: '#f03', fillOpacity: 0.1, radius: radiusMeters
                    }).bindTooltip(radiusLabel, {permanent: true, direction: 'right', className: 'dist-label'})
                      .addTo(map);
                } else {
                    if (txRangeCircle) { map.removeLayer(txRangeCircle); txRangeCircle = null; }
                }

                if (enemyRxMarker && isRxESActive) {
                    if (rxRangeCircle) map.removeLayer(rxRangeCircle);
                    rxRangeCircle = L.circle(enemyRxMarker.getLatLng(), {
                        color: '#ff4444', fillColor: '#ff4444', fillOpacity: 0.1, radius: radiusMeters
                    }).bindTooltip(radiusLabel, {permanent: true, direction: 'left', className: 'dist-label'})
                      .addTo(map);
                } else {
                    if (rxRangeCircle) { map.removeLayer(rxRangeCircle); rxRangeCircle = null; }
                }
            }
        });
    } else {
        if (txRangeCircle) { map.removeLayer(txRangeCircle); txRangeCircle = null; }
        if (rxRangeCircle) { map.removeLayer(rxRangeCircle); rxRangeCircle = null; }
    }

    updateMGRSTooltips();
}

document.querySelectorAll('input, select').forEach(element => {
    element.addEventListener('change', updateTacticalPicture);
});

// --- TOGGLE FH UI ---
document.getElementById('fh_toggle').addEventListener('change', function() {
    let displayState = this.checked ? 'block' : 'none';
    document.getElementById('enemy_bw_container').style.display = displayState;
    document.getElementById('jammer_bw_container').style.display = displayState;
    updateTacticalPicture(); 
});