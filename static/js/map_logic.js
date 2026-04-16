// ============================================================
// MAP INITIALIZATION & LAYERS
// ============================================================

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

// ============================================================
// ICON DEFINITIONS
// ============================================================

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

// ============================================================
// DATA STRUCTURES
// ============================================================

let redNodes    = [];   // { id, marker, esActive, esCircle }
let blueNodes   = [];   // { id, marker }
let enemyLinks  = [];   // { id, txId, rxId, line }
let jammingLinks = [];  // { id, blueId, rxId, line, result }

let activeMode = null;   // null | 'place-red' | 'place-blue' | 'link-enemy' | 'link-jammer'
let linkSource = null;   // { color, id } — holds first node during two-step link creation
let selectedLink = null; // { type: 'enemy'|'jammer', enemyLinkId, jammingLinkId }
let redCounter  = 0;
let blueCounter = 0;

let overlapLayer        = null;   // L.polygon | L.layerGroup | null — yellow intersection overlay
let overlapChecked      = new Set(); // node IDs selected in the overlap checklist
let overlapVertices     = [];     // [[lat,lng],...] — all vertices of the current overlap polygon(s)
let cornerMarkers       = [];     // L.circleMarker[] — MGRS labels at each vertex
let cornersVisible      = false;

// ES terrain ring request management
let _esDebounceTimer       = null;       // debounce handle for scheduleESUpdate()
const _esAbortControllers  = {};         // nodeId → AbortController for in-flight terrain requests

// ============================================================
// MODE MANAGEMENT
// ============================================================

const modeBtnIds = {
    'place-red':  'btn-place-red',
    'place-blue': 'btn-place-blue',
};

const modeLabels = {
    null:          'Pan / Select',
    'place-red':   'Click map to place Enemy Node — ESC to cancel',
    'place-blue':  'Click map to place Friendly Node — ESC to cancel',
    'link-enemy':  'Click the TX Enemy Node — ESC to cancel',
    'link-jammer': 'Click the target Enemy Node — ESC to cancel'
};

function setMode(newMode) {
    // Clicking the active button again cancels the mode
    if (newMode !== null && activeMode === newMode && !linkSource) newMode = null;

    if (linkSource) highlightNode(linkSource.color, linkSource.id, false);
    activeMode = newMode;
    linkSource = null;

    Object.values(modeBtnIds).forEach(id => document.getElementById(id).classList.remove('active'));
    if (newMode && modeBtnIds[newMode]) document.getElementById(modeBtnIds[newMode]).classList.add('active');

    map.getContainer().style.cursor = (newMode === 'place-red' || newMode === 'place-blue') ? 'crosshair' : '';
    document.getElementById('mode-indicator').textContent = modeLabels[newMode] ?? 'Pan / Select';
}

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') setMode(null);
});

// ============================================================
// HELPERS
// ============================================================

function findNode(color, id) {
    return color === 'red'
        ? redNodes.find(n => n.id === id)
        : blueNodes.find(n => n.id === id);
}

function highlightNode(color, id, on) {
    const node = findNode(color, id);
    if (!node) return;
    const el = node.marker.getElement();
    if (el) el.style.filter = on ? 'brightness(2) drop-shadow(0 0 6px white)' : '';
}

// ============================================================
// NODE PLACEMENT
// ============================================================

function placeRedNode(latlng) {
    redCounter++;
    const id = 'R' + redCounter;
    const marker = L.marker(latlng, { icon: redIcon, draggable: true }).addTo(map);
    marker.on('click', function() { handleNodeClick('red', id); });
    const node = { id, name: id, marker, esActive: false, esCircle: null, elevationM: null,
                   antennaType: 'omni', antennaAzimuth: 0, antennaBeamwidth: 90, antennaHeightAgl: 0 };
    marker.on('dragend', function() { fetchAndStoreElevation(node); recalculateAll(); });
    marker.on('popupclose', function() { bindRedPopup(id); });
    redNodes.push(node);
    bindRedPopup(id);
    updateMGRSTooltips();
    updateLinkAllBtn();
    fetchAndStoreElevation(node);
}

function placeBlueNode(latlng) {
    blueCounter++;
    const id = 'B' + blueCounter;
    const marker = L.marker(latlng, { icon: blueIcon, draggable: true }).addTo(map);
    marker.on('click', function() { handleNodeClick('blue', id); });
    const node = { id, name: id, marker, elevationM: null,
                   antennaType: 'omni', antennaAzimuth: 0, antennaBeamwidth: 90, antennaHeightAgl: 0 };
    marker.on('dragend', function() { fetchAndStoreElevation(node); recalculateAll(); });
    marker.on('popupclose', function() { bindBluePopup(id); });
    blueNodes.push(node);
    bindBluePopup(id);
    updateMGRSTooltips();
    fetchAndStoreElevation(node);
}

// ============================================================
// POPUP BINDING
// ============================================================

function antennaPopupSection(team, id, node) {
    const isDir   = node.antennaType === 'directional';
    const dirStyle = isDir ? '' : 'display:none';
    return `<hr class="popup-divider">
        <div class="popup-antenna-row">
          <label class="popup-label">Antenna:
            <select onchange="setNodeAntennaType('${team}','${id}',this.value)">
              <option value="omni"${!isDir ? ' selected' : ''}>Omni</option>
              <option value="directional"${isDir ? ' selected' : ''}>Directional</option>
            </select>
          </label>
        </div>
        <div id="ant-dir-${id}" class="popup-antenna-dir" style="${dirStyle}">
          <label class="popup-label">Azimuth (° True North):
            <input type="number" min="0" max="360" value="${node.antennaAzimuth}"
              oninput="setNodeAntennaAzimuth('${team}','${id}',this.value)"
              onchange="recalculateAll()">
          </label>
          <label class="popup-label">Beamwidth (° HPBW):
            <input type="number" min="1" max="360" value="${node.antennaBeamwidth}"
              oninput="setNodeAntennaBeamwidth('${team}','${id}',this.value)"
              onchange="recalculateAll()">
          </label>
        </div>
        <label class="popup-label">Height AGL (m):
          <input type="number" min="0" max="500" value="${node.antennaHeightAgl}"
            oninput="setNodeAntennaHeight('${team}','${id}',this.value)"
            onchange="recalculateAll()">
        </label>
        <div class="popup-note">Affects LOS/diffraction only<br>path loss uses ground-level model</div>`;
}

function bindRedPopup(id) {
    const node = findNode('red', id);
    if (!node) return;
    const esLabel = node.esActive ? '🚫 Hide Detection Ring' : '📡 Show Detection Ring';
    node.marker.bindPopup(
        `<b>Enemy Node ${node.name}</b><br>
        <button onclick="startEnemyLink('${id}')">🔗 Link Enemy Comms</button><br>
        <button onclick="toggleNodeES('${id}')">${esLabel}</button><br>
        <button onclick="renameNode('red','${id}')">✏️ Rename Node</button><br>
        <button onclick="removeNode('red','${id}')">🗑️ Remove Node</button>` +
        antennaPopupSection('red', id, node)
    );
}

function bindBluePopup(id) {
    const node = findNode('blue', id);
    if (!node) return;
    node.marker.bindPopup(
        `<b>Friendly Node ${node.name}</b><br>
        <button onclick="startJammingLink('${id}')">⚡ Link to Target</button><br>
        <button onclick="renameNode('blue','${id}')">✏️ Rename Node</button><br>
        <button onclick="removeNode('blue','${id}')">🗑️ Remove Node</button>` +
        antennaPopupSection('blue', id, node)
    );
}

// ============================================================
// NODE RENAMING
// ============================================================

function renameNode(type, id) {
    const node = findNode(type, id);
    if (!node) return;
    const input = window.prompt('Enter a new name (max 20 characters):', node.name);
    if (input === null) return; // cancelled
    const trimmed = input.trim();
    if (trimmed.length === 0) {
        alert('Name cannot be empty.');
        return;
    }
    if (trimmed.length > 20) {
        alert('Name must be 20 characters or fewer.');
        return;
    }
    node.name = trimmed
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    if (type === 'red') bindRedPopup(id); else bindBluePopup(id);
    node.marker.openPopup();
    updateMGRSTooltips();
    renderResults();
}

// ============================================================
// ANTENNA CONFIGURATION
// ============================================================

window.setNodeAntennaType = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaType = value;
    // Rebind popup so the directional sub-section shows/hides correctly
    if (team === 'red') bindRedPopup(id); else bindBluePopup(id);
    node.marker.openPopup();
    recalculateAll();
};

window.setNodeAntennaAzimuth = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaAzimuth = ((parseFloat(value) || 0) % 360 + 360) % 360;
    // recalculateAll is triggered by onchange on the input (fires on blur/enter)
};

window.setNodeAntennaBeamwidth = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaBeamwidth = Math.max(1, Math.min(360, parseFloat(value) || 90));
    // recalculateAll is triggered by onchange on the input (fires on blur/enter)
};

window.setNodeAntennaHeight = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaHeightAgl = Math.max(0, parseFloat(value) || 0);
    // recalculateAll is triggered by onchange on the input (fires on blur/enter)
};

function getNodeDisplayName(type, id) {
    const node = findNode(type, id);
    return node ? node.name : id;
}

// ============================================================
// POPUP-INITIATED LINK CREATION
// ============================================================

window.startEnemyLink = function(txId) {
    map.closePopup();
    setMode('link-enemy');
    linkSource = { color: 'red', id: txId };
    highlightNode('red', txId, true);
    document.getElementById('mode-indicator').textContent = 'Click the RX Enemy Node — ESC to cancel';
};

window.startJammingLink = function(blueId) {
    map.closePopup();
    setMode('link-jammer');
    linkSource = { color: 'blue', id: blueId };
    highlightNode('blue', blueId, true);
    document.getElementById('mode-indicator').textContent = 'Click the target Enemy Node — ESC to cancel';
};

// ============================================================
// NODE CLICK HANDLER
// ============================================================

function handleNodeClick(color, id) {
    if (activeMode === 'link-enemy') {
        map.closePopup();
        if (!linkSource) {
            if (color !== 'red') return;
            linkSource = { color: 'red', id };
            highlightNode('red', id, true);
            document.getElementById('mode-indicator').textContent = 'Click the RX Enemy Node — ESC to cancel';
        } else {
            if (color !== 'red' || id === linkSource.id) return;
            const txId = linkSource.id;
            highlightNode('red', txId, false);
            createEnemyLink(txId, id);
            setMode(null);
        }
    } else if (activeMode === 'link-jammer') {
        map.closePopup();
        if (!linkSource) {
            if (color !== 'blue') return;
            linkSource = { color: 'blue', id };
            highlightNode('blue', id, true);
            document.getElementById('mode-indicator').textContent = 'Click the target Enemy Node — ESC to cancel';
        } else {
            if (color !== 'red') return;
            const blueId = linkSource.id;
            highlightNode('blue', blueId, false);
            createJammingLink(blueId, id);
            setMode(null);
        }
    }
    // In normal mode (activeMode === null), Leaflet's bindPopup opens the popup automatically
}

// ============================================================
// LINK CREATION
// ============================================================

function createEnemyLink(txId, rxId) {
    const linkId = txId + '-' + rxId;
    if (enemyLinks.find(l => l.id === linkId)) return;

    const tx = findNode('red', txId);
    const rx = findNode('red', rxId);
    const dist = tx.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000;

    const line = L.polyline(
        [tx.marker.getLatLng(), rx.marker.getLatLng()],
        { color: 'red', dashArray: '5, 5' }
    ).bindTooltip(dist.toFixed(2) + ' km', {
        permanent: true, direction: 'center', className: 'dist-label'
    }).addTo(map);

    // Click the line to remove it
    line.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        if (activeMode) return;
        removeEnemyLink(linkId);
    });

    enemyLinks.push({ id: linkId, txId, rxId, line });
    recalculateAll();
}

function createJammingLink(blueId, rxId) {
    const linkId = blueId + '-' + rxId;
    if (jammingLinks.find(l => l.id === linkId)) return;

    const blue = findNode('blue', blueId);
    const rx   = findNode('red',  rxId);
    const dist = blue.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000;

    const line = L.polyline(
        [blue.marker.getLatLng(), rx.marker.getLatLng()],
        { color: '#555', weight: 4 }
    ).bindTooltip(dist.toFixed(2) + ' km', {
        permanent: true, direction: 'center', className: 'dist-label'
    }).addTo(map);

    // Click the line to remove it
    line.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        if (activeMode) return;
        removeJammingLink(linkId);
    });

    jammingLinks.push({ id: linkId, blueId, rxId, line, results: null });
    recalculateAll();
}

// ============================================================
// REMOVAL
// ============================================================

window.removeNode = function(color, id) {
    map.closePopup();
    if (color === 'red') {
        const node = findNode('red', id);
        if (node) {
            map.removeLayer(node.marker);
            if (node.esCircle) map.removeLayer(node.esCircle);
        }
        redNodes = redNodes.filter(n => n.id !== id);
        clearOverlapLayer();
        renderOverlapControls();
        enemyLinks.filter(l => l.txId === id || l.rxId === id).forEach(l => map.removeLayer(l.line));
        enemyLinks  = enemyLinks.filter(l => l.txId !== id && l.rxId !== id);
        jammingLinks.filter(l => l.rxId === id).forEach(l => map.removeLayer(l.line));
        jammingLinks = jammingLinks.filter(l => l.rxId !== id);
    } else {
        const node = findNode('blue', id);
        if (node) map.removeLayer(node.marker);
        blueNodes = blueNodes.filter(n => n.id !== id);
        jammingLinks.filter(l => l.blueId === id).forEach(l => map.removeLayer(l.line));
        jammingLinks = jammingLinks.filter(l => l.blueId !== id);
    }
    recalculateAll();
};

function removeEnemyLink(linkId) {
    if (selectedLink?.enemyLinkId === linkId) selectedLink = null;
    const link = enemyLinks.find(l => l.id === linkId);
    if (link) map.removeLayer(link.line);
    enemyLinks = enemyLinks.filter(l => l.id !== linkId);
    recalculateAll();
}

function removeJammingLink(linkId) {
    if (selectedLink?.jammingLinkId === linkId) selectedLink = null;
    const link = jammingLinks.find(l => l.id === linkId);
    if (link) map.removeLayer(link.line);
    jammingLinks = jammingLinks.filter(l => l.id !== linkId);
    renderResults();
}

window.removeJammingLinkById = function(id) { removeJammingLink(id); };
window.removeEnemyLinkById   = function(id) { removeEnemyLink(id); };

window.selectLink = function(type, jammingLinkId, enemyLinkId) {
    const isSame = selectedLink
        && selectedLink.type === type
        && selectedLink.jammingLinkId === jammingLinkId
        && selectedLink.enemyLinkId === enemyLinkId;
    selectedLink = isSame ? null : { type, jammingLinkId, enemyLinkId };
    updateMapHighlights();
    renderResults();
};

// ============================================================
// CALCULATION ENGINE
// ============================================================

function getParams() {
    return {
        freq_mhz:        document.getElementById('freq_mhz').value,
        enemy_terrain:   document.getElementById('enemy_terrain').value,
        jammer_terrain:  document.getElementById('jammer_terrain').value,
        enemy_tx_w:      document.getElementById('enemy_tx_w').value,
        enemy_tx_gain:   document.getElementById('enemy_tx_gain').value,
        enemy_rx_gain:   document.getElementById('enemy_rx_gain').value,
        apply_fh:        document.getElementById('fh_toggle').checked,
        enemy_bw_khz:    document.getElementById('enemy_bw_khz').value,
        jammer_tx_w:      document.getElementById('jammer_tx_w').value,
        jammer_tx_gain:   document.getElementById('jammer_tx_gain').value,
        jammer_bw_khz:    document.getElementById('jammer_bw_khz').value,
        lower_threshold:  document.getElementById('lower_threshold').value,
        upper_threshold:  document.getElementById('upper_threshold').value,
    };
}

function updateLineTooltip(line, text) {
    line.setTooltipContent(text);
    const tooltip = line.getTooltip();
    if (tooltip) tooltip.setLatLng(line.getBounds().getCenter());
}

function jammingLineColor(results) {
    const margins = (results || []).filter(r => r?.status === 'success').map(r => r.margin);
    if (margins.length === 0) return '#555';
    const best = Math.max(...margins);
    const upper = parseFloat(document.getElementById('upper_threshold').value) || 6;
    const lower = parseFloat(document.getElementById('lower_threshold').value) || -6;
    return best >= upper ? '#00ee00' : best > lower ? '#ff9900' : '#ff3333';
}

function thresholdsValid() {
    const upper = parseFloat(document.getElementById('upper_threshold').value);
    const lower = parseFloat(document.getElementById('lower_threshold').value);
    const invalid = isNaN(upper) || isNaN(lower) || upper <= lower;
    document.getElementById('threshold-error').style.display = invalid ? 'block' : 'none';
    document.getElementById('upper_threshold').style.borderColor = invalid ? '#ff4444' : '';
    document.getElementById('lower_threshold').style.borderColor = invalid ? '#ff4444' : '';
    return !invalid;
}

function updateDistanceWarning() {
    const jammingOver = jammingLinks.some(jLink => {
        const blue = findNode('blue', jLink.blueId);
        const rx   = findNode('red',  jLink.rxId);
        if (!blue || !rx) return false;
        if (blue.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000 > 50) return true;
        return enemyLinks.some(eLink => {
            if (eLink.rxId !== jLink.rxId) return false;
            const tx = findNode('red', eLink.txId);
            return tx && tx.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000 > 50;
        });
    });
    const esOver = redNodes.some(n => n.esActive && n.esRangeKm != null && n.esRangeKm > 50);
    document.getElementById('distance-warning').style.display = (jammingOver || esOver) ? 'block' : 'none';
}

function recalculateAll() {
    if (!thresholdsValid()) return;
    // Refresh enemy link line positions and distance labels
    enemyLinks.forEach(link => {
        const tx = findNode('red', link.txId);
        const rx = findNode('red', link.rxId);
        if (!tx || !rx) return;
        link.line.setLatLngs([tx.marker.getLatLng(), rx.marker.getLatLng()]);
        const dist = tx.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000;
        updateLineTooltip(link.line, dist.toFixed(2) + ' km');
    });

    updateMGRSTooltips();
    scheduleESUpdate();
    updateLinkAllBtn();

    if (jammingLinks.length === 0) {
        document.getElementById('distance-warning').style.display = 'none';
        renderResults();
        return;
    }

    const params = getParams();

    // Build a flat list of fetch tasks: one per (jammingLink, enemyCommsLink) pair
    const tasks = [];
    jammingLinks.forEach(jLink => {
        const blue = findNode('blue', jLink.blueId);
        const rx   = findNode('red',  jLink.rxId);
        if (!blue || !rx) { jLink.results = []; return; }

        const jammerDistKm = blue.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000;
        jLink.line.setLatLngs([blue.marker.getLatLng(), rx.marker.getLatLng()]);
        updateLineTooltip(jLink.line, jammerDistKm.toFixed(2) + ' km');

        const matchingELinks = enemyLinks.filter(l => l.rxId === jLink.rxId);
        if (matchingELinks.length === 0) {
            jLink.results = [{ status: 'no-enemy-link' }];
            jLink.line.setStyle({ color: '#555', weight: 4 });
            return;
        }

        jLink.results = new Array(matchingELinks.length).fill(null);
        matchingELinks.forEach((eLink, i) => {
            const tx = findNode('red', eLink.txId);
            if (!tx) { jLink.results[i] = { status: 'error', enemyLinkId: eLink.id }; return; }
            const enemyDistKm = tx.marker.getLatLng().distanceTo(rx.marker.getLatLng()) / 1000;
            tasks.push({ jLink, eLink, i, jammerDistKm, enemyDistKm });
        });
    });

    if (tasks.length === 0) {
        renderResults();
        return;
    }

    updateDistanceWarning();

    let pending = tasks.length;
    const done = () => { if (--pending === 0) renderResults(); };

    tasks.forEach(({ jLink, eLink, i, jammerDistKm, enemyDistKm }) => {
        const payload = { ...params, enemy_dist_km: enemyDistKm, jammer_dist_km: jammerDistKm };

        // Include node coordinates so the backend can perform elevation-aware LOS analysis
        // and bearing-based directional antenna gain calculations
        const blue = findNode('blue', jLink.blueId);
        const rx   = findNode('red',  jLink.rxId);
        const tx   = findNode('red',  eLink.txId);
        if (blue && rx && tx) {
            const bll = blue.marker.getLatLng();
            const rll = rx.marker.getLatLng();
            const tll = tx.marker.getLatLng();
            payload.jammer_lat = bll.lat;
            payload.jammer_lon = bll.lng;
            payload.rx_lat     = rll.lat;
            payload.rx_lon     = rll.lng;
            payload.tx_lat     = tll.lat;
            payload.tx_lon     = tll.lng;

            // Per-node antenna parameters
            payload.tx_antenna_type      = tx.antennaType;
            payload.tx_azimuth_deg       = tx.antennaAzimuth;
            payload.tx_beamwidth_deg     = tx.antennaBeamwidth;
            payload.rx_antenna_type      = rx.antennaType;
            payload.rx_azimuth_deg       = rx.antennaAzimuth;
            payload.rx_beamwidth_deg     = rx.antennaBeamwidth;
            payload.jammer_antenna_type  = blue.antennaType;
            payload.jammer_azimuth_deg   = blue.antennaAzimuth;
            payload.jammer_beamwidth_deg = blue.antennaBeamwidth;
            payload.tx_antenna_height_m     = tx.antennaHeightAgl;
            payload.rx_antenna_height_m     = rx.antennaHeightAgl;
            payload.jammer_antenna_height_m = blue.antennaHeightAgl;
        }

        fetch('/calculate_ea', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(r => r.json())
        .then(data => {
            jLink.results[i] = data.status === 'success'
                ? { ...data, enemyLinkId: eLink.id }
                : { status: 'error', enemyLinkId: eLink.id };
            jLink.line.setStyle({ color: jammingLineColor(jLink.results), weight: 4 });
            done();
        })
        .catch(() => { jLink.results[i] = { status: 'error', enemyLinkId: eLink.id }; done(); });
    });
}

// ============================================================
// MGRS TOOLTIPS
// ============================================================

function updateMGRSTooltips() {
    [...redNodes, ...blueNodes].forEach(function(node) {
        const latlng = node.marker.getLatLng();
        const mgrsStr = mgrs.forward([latlng.lng, latlng.lat]);
        const elevStr = (node.elevationM != null) ? ` ${node.elevationM}M` : '';
        node.marker.bindTooltip(`${node.name} — ${mgrsStr}${elevStr}`, {
            permanent: true, direction: 'top', className: 'mgrs-label'
        });
    });
}

async function fetchAndStoreElevation(node) {
    const latlng = node.marker.getLatLng();
    try {
        const resp = await fetch('/get_elevations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ lat: latlng.lat, lon: latlng.lng }])
        });
        const data = await resp.json();
        node.elevationM = data.elevations[0];
    } catch (e) {
        node.elevationM = null;
    }
    updateMGRSTooltips();
}

// ============================================================
// OVERLAP ANALYSIS
// ============================================================

function clearCornerMarkers() {
    cornerMarkers.forEach(m => map.removeLayer(m));
    cornerMarkers = [];
    cornersVisible = false;
    const btn = document.getElementById('btn-toggle-corners');
    if (btn) { btn.style.display = 'none'; btn.textContent = 'Show MGRS Corners'; }
}

function clearOverlapLayer() {
    if (overlapLayer) { map.removeLayer(overlapLayer); overlapLayer = null; }
    overlapVertices = [];
    clearCornerMarkers();
    const clearBtn = document.getElementById('btn-clear-overlap');
    if (clearBtn) clearBtn.style.display = 'none';
    const statusEl = document.getElementById('overlap-status');
    if (statusEl) statusEl.textContent = '';
}

function toggleCornerMarkers() {
    const btn = document.getElementById('btn-toggle-corners');
    if (cornersVisible) {
        cornerMarkers.forEach(m => map.removeLayer(m));
        cornerMarkers = [];
        cornersVisible = false;
        if (btn) btn.textContent = 'Show MGRS Corners';
    } else {
        cornerMarkers = overlapVertices.map(([lat, lng]) => {
            const mgrsStr = mgrs.forward([lng, lat]);
            return L.circleMarker([lat, lng], {
                radius: 4, color: '#ffff00', fillColor: '#ffff00', fillOpacity: 1, weight: 1
            }).bindTooltip(mgrsStr, {
                permanent: true, direction: 'top', className: 'mgrs-corner-label'
            }).addTo(map);
        });
        cornersVisible = true;
        if (btn) btn.textContent = 'Hide MGRS Corners';
    }
}

function renderOverlapControls() {
    const checklist = document.getElementById('overlap-checklist');
    const showBtn   = document.getElementById('btn-show-overlap');
    if (!checklist || !showBtn) return;

    const eligible = redNodes.filter(n => n.esActive && n.esPolygonPoints);

    if (eligible.length === 0) {
        checklist.innerHTML = '<p class="results-empty">No active detection rings.</p>';
        showBtn.disabled = true;
        return;
    }

    // Prune stale IDs no longer eligible
    overlapChecked.forEach(id => {
        if (!eligible.find(n => n.id === id)) overlapChecked.delete(id);
    });

    let html = '';
    eligible.forEach(n => {
        const checked = overlapChecked.has(n.id) ? 'checked' : '';
        html += `<div class="overlap-node-row">
            <input type="checkbox" id="ov-chk-${n.id}" value="${n.id}" ${checked}
                onchange="handleOverlapCheck(this)">
            <label for="ov-chk-${n.id}">${n.name}</label>
        </div>`;
    });
    checklist.innerHTML = html;
    showBtn.disabled = overlapChecked.size < 2;
}

window.handleOverlapCheck = function(checkbox) {
    if (checkbox.checked) {
        overlapChecked.add(checkbox.value);
    } else {
        overlapChecked.delete(checkbox.value);
    }
    clearOverlapLayer();
    document.getElementById('btn-show-overlap').disabled = overlapChecked.size < 2;
};

function circleToPolygon(lat, lng, radiusKm, n = 36) {
    const R = 6371, d = radiusKm / R;
    const lat1 = lat * Math.PI / 180, lng1 = lng * Math.PI / 180;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const b = (i * 2 * Math.PI) / n;
        const lat2 = Math.asin(Math.sin(lat1)*Math.cos(d) + Math.cos(lat1)*Math.sin(d)*Math.cos(b));
        const lng2 = lng1 + Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(lat1), Math.cos(d) - Math.sin(lat1)*Math.sin(lat2));
        pts.push([lat2 * 180/Math.PI, lng2 * 180/Math.PI]);
    }
    return pts;
}

function computeAndShowOverlap() {
    clearOverlapLayer();
    const statusEl = document.getElementById('overlap-status');

    const selected = redNodes.filter(n => overlapChecked.has(n.id) && n.esPolygonPoints);
    if (selected.length < 2) {
        if (statusEl) statusEl.textContent = 'Select at least 2 nodes.';
        return;
    }

    if (statusEl) statusEl.textContent = 'Calculating...';
    fetch('/compute_overlap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ polygons: selected.map(n => n.esPolygonPoints) })
    })
    .then(r => r.json())
    .then(data => {
        if (data.status === 'no-overlap') {
            if (statusEl) statusEl.textContent = 'No common coverage area found.';
            return;
        }
        if (data.status !== 'success') {
            if (statusEl) statusEl.textContent = 'Error computing overlap.';
            return;
        }
        const layers = data.intersection.map(ring =>
            L.polygon(ring, { color: '#ffff00', fillColor: '#ffff00', fillOpacity: 0.35, weight: 2 })
        );
        overlapLayer = L.layerGroup(layers).addTo(map);
        // Collect all vertices across all polygons for MGRS corner display
        overlapVertices = data.intersection.flat();
        if (statusEl) statusEl.textContent = '';
        const clearBtn = document.getElementById('btn-clear-overlap');
        if (clearBtn) clearBtn.style.display = 'block';
        const cornersBtn = document.getElementById('btn-toggle-corners');
        if (cornersBtn) cornersBtn.style.display = 'block';
    })
    .catch(() => { if (statusEl) statusEl.textContent = 'Error computing overlap.'; });
}

// ============================================================
// ES CIRCLES (DETECTION RINGS)
// ============================================================

window.toggleNodeES = function(id) {
    const node = findNode('red', id);
    if (!node) return;
    node.esActive = !node.esActive;
    if (!node.esActive) { node.esPolygonPoints = null; node.esRangeKm = null; clearOverlapLayer(); }
    map.closePopup();
    bindRedPopup(id);
    updateESCircles();
    renderOverlapControls();
};

// Debounced entry point — called from recalculateAll() to avoid rapid-fire API requests
// when the user is dragging nodes or changing parameters quickly.
function scheduleESUpdate() {
    clearTimeout(_esDebounceTimer);
    _esDebounceTimer = setTimeout(updateESCircles, 300);
}

async function updateESCircles() {
    // Remove circles for any node that is no longer active
    redNodes.forEach(n => {
        if (!n.esActive && n.esCircle) { map.removeLayer(n.esCircle); n.esCircle = null; }
    });

    const activeESNodes = redNodes.filter(n => n.esActive);
    if (activeESNodes.length === 0) return;

    // Cancel any in-flight requests and issue fresh controllers before starting the loop.
    // This ensures a new updateESCircles() call (e.g. from a second drag) aborts stale
    // fetches rather than letting an old position's result overwrite the current ring.
    activeESNodes.forEach(node => {
        if (_esAbortControllers[node.id]) _esAbortControllers[node.id].abort();
        _esAbortControllers[node.id] = new AbortController();
    });

    const esParams = {
        freq_mhz:         document.getElementById('freq_mhz').value,
        enemy_terrain:    document.getElementById('enemy_terrain').value,
        jammer_terrain:   document.getElementById('jammer_terrain').value,
        enemy_tx_w:       document.getElementById('enemy_tx_w').value,
        enemy_tx_gain:    document.getElementById('enemy_tx_gain').value,
        rx_sensitivity:   document.getElementById('rx_sensitivity').value,
        friendly_rx_gain: document.getElementById('friendly_rx_gain').value
    };

    // Process nodes sequentially — firing all requests in parallel would exceed the
    // Open-Topo-Data public API rate limit (1 req/sec) when multiple nodes are active.
    for (const node of activeESNodes) {
        const ll = node.marker.getLatLng();
        const payload = {
            ...esParams,
            enemy_lat:           ll.lat,
            enemy_lon:           ll.lng,
            tx_antenna_type:     node.antennaType,
            tx_azimuth_deg:      node.antennaAzimuth,
            tx_beamwidth_deg:    node.antennaBeamwidth,
            tx_antenna_height_m: node.antennaHeightAgl,
        };

        try {
            const r = await fetch('/calculate_es_terrain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: _esAbortControllers[node.id].signal
            });
            const data = await r.json();
            if (data.status !== 'success') continue;

            node.esRangeKm = data.base_range_km;
            if (node.esCircle) map.removeLayer(node.esCircle);

            if (data.polygon_points) {
                // Terrain-aware detection polygon
                node.esPolygonPoints = data.polygon_points;
                const label = `Detection: ~${data.base_range_km.toFixed(1)} km (terrain)`;
                node.esCircle = L.polygon(data.polygon_points, {
                    color: 'red', fillColor: '#f03', fillOpacity: 0.1, weight: 1
                }).bindTooltip(label, {
                    permanent: true, direction: 'right', className: 'dist-label'
                }).addTo(map);
            } else {
                // Fallback: uniform circle when elevation API is unavailable
                node.esPolygonPoints = circleToPolygon(ll.lat, ll.lng, data.base_range_km);
                const radiusMeters = data.base_range_km * 1000;
                const label = `Detection: ${data.base_range_km.toFixed(2)} km`;
                node.esCircle = L.circle(ll, {
                    color: 'red', fillColor: '#f03', fillOpacity: 0.1, radius: radiusMeters
                }).bindTooltip(label, {
                    permanent: true, direction: 'right', className: 'dist-label'
                }).addTo(map);
            }
        } catch (e) {
            if (e.name !== 'AbortError') { /* network error — leave existing ring in place */ }
        }
    }

    // Run once after all nodes are processed rather than after each individual node.
    renderOverlapControls();
    updateDistanceWarning();
}

// ============================================================
// MAP HIGHLIGHT / DIM
// ============================================================

function updateMapHighlights() {
    // Clear stale selection if the referenced link was removed
    if (selectedLink) {
        const enemyGone  = !enemyLinks.find(l => l.id === selectedLink.enemyLinkId);
        const jammerGone = selectedLink.jammingLinkId && !jammingLinks.find(l => l.id === selectedLink.jammingLinkId);
        if (enemyGone && selectedLink.type === 'enemy') selectedLink = null;
        if (jammerGone) selectedLink = null;
    }

    if (!selectedLink) {
        enemyLinks.forEach(l =>
            l.line.setStyle({ color: 'red', dashArray: '5, 5', weight: 2, opacity: 1 }));
        jammingLinks.forEach(l =>
            l.line.setStyle({ color: jammingLineColor(l.results), weight: 4, opacity: 1 }));
        return;
    }

    const selEnemyId  = selectedLink.enemyLinkId;
    const selJammerId = selectedLink.jammingLinkId;

    enemyLinks.forEach(l => {
        if (l.id === selEnemyId) {
            l.line.setStyle({ color: 'red', dashArray: '5, 5', weight: 4, opacity: 1 });
        } else {
            l.line.setStyle({ color: 'red', dashArray: '5, 5', weight: 2, opacity: 0.2 });
        }
    });

    jammingLinks.forEach(l => {
        if (selJammerId && l.id === selJammerId) {
            // Use the color for the specific selected path, not the aggregate best
            const specificResult = (l.results || []).find(r => r?.enemyLinkId === selectedLink.enemyLinkId);
            let color;
            if (specificResult?.status === 'success') {
                color = specificResult.margin >= 6 ? '#00ee00'
                      : specificResult.margin > -6 ? '#ff9900'
                      : '#ff3333';
            } else {
                color = jammingLineColor(l.results);
            }
            l.line.setStyle({ color, weight: 7, opacity: 1 });
        } else {
            l.line.setStyle({ color: jammingLineColor(l.results), weight: 4, opacity: 0.2 });
        }
    });
}

// ============================================================
// RESULTS RENDERING
// ============================================================

function renderResults() {
    const panel = document.getElementById('results-list');

    if (enemyLinks.length === 0 && jammingLinks.length === 0) {
        panel.innerHTML = '<p class="results-empty">No links defined.</p>';
        setMobileResult('--', 'Place nodes...');
        updateMapHighlights();
        return;
    }

    let bestMargin = null;
    let html = `<table class="results-table">
        <thead><tr><th></th><th>Link</th><th>J/S</th><th>Effect</th></tr></thead>
        <tbody>`;

    const shownJammingIds = new Set();

    // Group by enemy comms link
    enemyLinks.forEach(eLink => {
        const assocJLinks = jammingLinks.filter(jl => jl.rxId === eLink.rxId);
        const enemySelected = selectedLink && (
            (selectedLink.type === 'enemy'  && selectedLink.enemyLinkId === eLink.id) ||
            (selectedLink.type === 'jammer' && selectedLink.enemyLinkId === eLink.id)
        );
        const enemyRowClass = 'enemy-link-row' + (enemySelected ? ' row-selected' : '');

        if (assocJLinks.length === 0) {
            html += `<tr class="${enemyRowClass}" onclick="selectLink('enemy', null, '${eLink.id}')">
                <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeEnemyLinkById('${eLink.id}')">✕</button></td>
                <td>${getNodeDisplayName('red', eLink.txId)}→${getNodeDisplayName('red', eLink.rxId)}</td>
                <td>—</td>
                <td class="uncontested">Uncontested</td>
            </tr>`;
        } else {
            html += `<tr class="${enemyRowClass}" onclick="selectLink('enemy', null, '${eLink.id}')">
                <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeEnemyLinkById('${eLink.id}')">✕</button></td>
                <td>${getNodeDisplayName('red', eLink.txId)}→${getNodeDisplayName('red', eLink.rxId)}</td>
                <td></td><td></td>
            </tr>`;

            assocJLinks.forEach(jLink => {
                shownJammingIds.add(jLink.id);
                const results  = jLink.results || [null];
                const result   = results.find(r => r?.enemyLinkId === eLink.id) ?? results[0];
                const jammerSel = selectedLink?.type === 'jammer'
                    && selectedLink.jammingLinkId === jLink.id
                    && selectedLink.enemyLinkId === eLink.id;

                let margin = '--', effect = 'Pending...', rowClass = '', losBadge = '';
                if (result) {
                    if      (result.status === 'no-enemy-link') { effect = 'No enemy link'; rowClass = 'result-unknown'; }
                    else if (result.status === 'error')         { effect = 'Error';          rowClass = 'result-unknown'; }
                    else if (result.status === 'success') {
                        margin = result.margin + ' dB';
                        effect = result.effect;
                        const upper = parseFloat(document.getElementById('upper_threshold').value) || 6;
                        const lower = parseFloat(document.getElementById('lower_threshold').value) || -6;
                        rowClass = result.margin >= upper ? 'result-complete' : result.margin > lower ? 'result-warbling' : 'result-none';
                        if (bestMargin === null || result.margin > bestMargin) bestMargin = result.margin;
                        if (result.jammer_los != null) {
                            losBadge = result.jammer_los.is_los
                                ? '<span class="los-badge los-badge--los">LOS</span>'
                                : `<span class="los-badge los-badge--nlos">NLOS +${result.jammer_los.diffraction_loss_db}dB</span>`;
                        }
                    }
                }

                html += `<tr class="jammer-sub-row ${rowClass}${jammerSel ? ' row-selected' : ''}"
                    onclick="selectLink('jammer', '${jLink.id}', '${eLink.id}')">
                    <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeJammingLinkById('${jLink.id}')">✕</button></td>
                    <td>↳ ${getNodeDisplayName('blue', jLink.blueId)}</td>
                    <td>${margin}</td>
                    <td>${effect} ${losBadge}</td>
                </tr>`;
            });
        }
    });

    // Orphaned jamming links (no enemy comms link defined for their RX)
    const orphaned = jammingLinks.filter(jl => !shownJammingIds.has(jl.id));
    if (orphaned.length > 0) {
        html += `<tr class="section-divider"><td colspan="4">Unlinked Jammers</td></tr>`;
        orphaned.forEach(jLink => {
            const jammerSel = selectedLink?.type === 'jammer' && selectedLink.jammingLinkId === jLink.id;
            html += `<tr class="jammer-sub-row result-unknown${jammerSel ? ' row-selected' : ''}"
                onclick="selectLink('jammer', '${jLink.id}', null)">
                <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeJammingLinkById('${jLink.id}')">✕</button></td>
                <td>${getNodeDisplayName('blue', jLink.id)}</td>
                <td>—</td>
                <td class="uncontested">No enemy link</td>
            </tr>`;
        });
    }

    html += '</tbody></table>';
    panel.innerHTML = html;

    if (bestMargin !== null) {
        const best = jammingLinks.flatMap(l => l.results || []).find(r => r?.margin === bestMargin);
        setMobileResult(bestMargin + ' dB', 'Best: ' + (best?.effect ?? ''));
    } else if (jammingLinks.length > 0) {
        setMobileResult('--', jammingLinks.length + ' link(s)');
    } else {
        setMobileResult('--', 'No jamming links');
    }

    updateMapHighlights();
}

// ============================================================
// MAP CLICK — PLACE NODES
// ============================================================

map.on('click', function(e) {
    if      (activeMode === 'place-red')  placeRedNode(e.latlng);
    else if (activeMode === 'place-blue') placeBlueNode(e.latlng);
});

// ============================================================
// LINK ALL / UNLINK ALL
// ============================================================

function allCommsLinked() {
    if (redNodes.length < 2) return false;
    for (const a of redNodes) {
        for (const b of redNodes) {
            if (a.id === b.id) continue;
            if (!enemyLinks.find(l => l.txId === a.id && l.rxId === b.id)) return false;
        }
    }
    return true;
}

function updateLinkAllBtn() {
    const btn = document.getElementById('btn-link-all-enemy');
    const canLink = redNodes.length >= 2;
    btn.disabled = !canLink;
    if (canLink && allCommsLinked()) {
        btn.textContent = 'Unlink All Enemy Comms';
        btn.classList.add('unlink-btn');
    } else {
        btn.textContent = 'Link All Enemy Comms';
        btn.classList.remove('unlink-btn');
    }
}

function linkAllEnemyComms() {
    redNodes.forEach(a => {
        redNodes.forEach(b => {
            if (a.id === b.id) return;
            const linkId = a.id + '-' + b.id;
            if (enemyLinks.find(l => l.id === linkId)) return;

            const dist = a.marker.getLatLng().distanceTo(b.marker.getLatLng()) / 1000;
            const line = L.polyline(
                [a.marker.getLatLng(), b.marker.getLatLng()],
                { color: 'red', dashArray: '5, 5' }
            ).bindTooltip(dist.toFixed(2) + ' km', {
                permanent: true, direction: 'center', className: 'dist-label'
            }).addTo(map);

            line.on('click', function(e) {
                L.DomEvent.stopPropagation(e);
                if (activeMode) return;
                removeEnemyLink(linkId);
            });

            enemyLinks.push({ id: linkId, txId: a.id, rxId: b.id, line });
        });
    });
    recalculateAll();
}

function unlinkAllEnemyComms() {
    if (selectedLink?.type === 'enemy') selectedLink = null;
    enemyLinks.forEach(l => map.removeLayer(l.line));
    enemyLinks = [];
    recalculateAll();
}

// ============================================================
// WORKBENCH BUTTON EVENTS
// ============================================================

document.getElementById('btn-place-red').addEventListener('click',  () => setMode('place-red'));
document.getElementById('btn-place-blue').addEventListener('click', () => setMode('place-blue'));

document.getElementById('btn-link-all-enemy').addEventListener('click', function() {
    if (allCommsLinked()) unlinkAllEnemyComms();
    else                  linkAllEnemyComms();
});

document.getElementById('btn-minimize-links').addEventListener('click', function() {
    const body = document.getElementById('link-statuses-body');
    const minimized = body.style.display === 'none';
    body.style.display = minimized ? 'block' : 'none';
    this.textContent = minimized ? '▼' : '▶';
});

document.getElementById('btn-show-overlap').addEventListener('click', computeAndShowOverlap);
document.getElementById('btn-clear-overlap').addEventListener('click', clearOverlapLayer);
document.getElementById('btn-toggle-corners').addEventListener('click', toggleCornerMarkers);

// ============================================================
// CLEAR ALL
// ============================================================

document.getElementById('clear-nodes-btn').addEventListener('click', function() {
    setMode(null);
    redNodes.forEach(n => { map.removeLayer(n.marker); if (n.esCircle) map.removeLayer(n.esCircle); });
    blueNodes.forEach(n => map.removeLayer(n.marker));
    enemyLinks.forEach(l => map.removeLayer(l.line));
    jammingLinks.forEach(l => map.removeLayer(l.line));
    redNodes = []; blueNodes = []; enemyLinks = []; jammingLinks = [];
    redCounter = 0; blueCounter = 0;
    selectedLink = null;
    overlapChecked.clear();
    clearOverlapLayer();
    renderOverlapControls();
    renderResults();
});

// ============================================================
// CENTER ON NODES (LEAFLET CONTROL)
// ============================================================

const CenterControl = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function() {
        const btn = L.DomUtil.create('button', 'center-nodes-btn');
        btn.innerText = 'Center on Nodes';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', function() {
            const allNodes = [...redNodes, ...blueNodes];
            if (allNodes.length === 0) return;
            const circles = redNodes.filter(n => n.esCircle).map(n => n.esCircle);
            const bounds = L.latLngBounds([]);
            allNodes.forEach(n => bounds.extend(n.marker.getLatLng()));
            circles.forEach(c => bounds.extend(c.getBounds()));
            // Extra right padding accounts for the 280px workbench panel
            map.fitBounds(bounds, {
                paddingTopLeft:     [80, 80],
                paddingBottomRight: [370, 80],
                maxZoom: 16
            });
        });
        return btn;
    }
});
new CenterControl().addTo(map);

// ============================================================
// PARAMETER CHANGE LISTENERS
// ============================================================

document.querySelectorAll('input, select').forEach(element => {
    element.addEventListener('change', recalculateAll);
});

// ============================================================
// MOBILE SIDEBAR TOGGLE
// ============================================================

function setMobileResult(margin, effect) {
    document.getElementById('mobile-margin').textContent = margin;
    document.getElementById('mobile-effect').textContent = effect;
}

const sidebarToggle  = document.getElementById('sidebar-toggle');
const sidebar        = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

sidebarToggle.addEventListener('click', function() {
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('visible');
});

sidebarOverlay.addEventListener('click', function() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
});

document.getElementById('sidebar-close').addEventListener('click', function() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
});

document.getElementById('workbench-collapse-btn').addEventListener('click', function() {
    const wb = document.getElementById('workbench');
    wb.classList.toggle('collapsed');
    this.textContent = wb.classList.contains('collapsed') ? '\u25b6' : '\u25bc';
});

// ============================================================
// FH TOGGLE
// ============================================================

document.getElementById('fh_toggle').addEventListener('change', function() {
    const displayState = this.checked ? 'block' : 'none';
    document.getElementById('enemy_bw_container').style.display = displayState;
    document.getElementById('jammer_bw_container').style.display = displayState;
    recalculateAll();
});

// ============================================================
// JUMP TO LOCATION
// ============================================================

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
            let isWest  = cleanInput.includes('W');

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
            if (isWest  && lng > 0) lng = -lng;

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

// ============================================================
// KML EXPORT
// ============================================================

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Convert CSS #rrggbb to KML aabbggrr.
// alpha: 0.0–1.0 float (default 1.0 = fully opaque)
function cssToKmlColor(hex, alpha) {
    const a = (alpha === undefined)
        ? 'ff'
        : Math.round(alpha * 255).toString(16).padStart(2, '0');
    const r = hex.slice(1, 3);
    const g = hex.slice(3, 5);
    const b = hex.slice(5, 7);
    return a + b + g + r;
}

function exportKML(includeLabels) {

    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
    lines.push('<Document>');
    lines.push('  <name>Specter-EW Export</name>');

    // --- Styles ---
    // Node icons: use a neutral white circle icon tinted by <color>
    const iconHref = 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png';
    lines.push(`  <Style id="redNode"><IconStyle><color>${cssToKmlColor('#ff2222')}</color><scale>1.2</scale><Icon><href>${iconHref}</href></Icon></IconStyle></Style>`);
    lines.push(`  <Style id="blueNode"><IconStyle><color>${cssToKmlColor('#3399ff')}</color><scale>1.2</scale><Icon><href>${iconHref}</href></Icon></IconStyle></Style>`);

    // Enemy comms link (red solid)
    lines.push(`  <Style id="enemyLink"><LineStyle><color>${cssToKmlColor('#ff0000')}</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>`);

    // Jamming link styles (one per possible color)
    for (const [name, hex] of [['green','#00ee00'],['orange','#ff9900'],['red','#ff3333'],['gray','#555555']]) {
        lines.push(`  <Style id="jamLink-${name}"><LineStyle><color>${cssToKmlColor(hex)}</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>`);
    }

    // Label-only placemark (hidden icon, white text)
    lines.push('  <Style id="linkLabel"><IconStyle><scale>0</scale></IconStyle><LabelStyle><color>ffffffff</color><scale>0.75</scale></LabelStyle></Style>');

    // ES detection ring (red outline, 10% red fill)
    lines.push(`  <Style id="esPoly"><LineStyle><color>${cssToKmlColor('#ff3333')}</color><width>1</width></LineStyle><PolyStyle><color>${cssToKmlColor('#ff3333', 0.10)}</color></PolyStyle></Style>`);

    // Overlap polygon (yellow outline, 35% yellow fill)
    lines.push(`  <Style id="overlapPoly"><LineStyle><color>${cssToKmlColor('#ffff00')}</color><width>2</width></LineStyle><PolyStyle><color>${cssToKmlColor('#ffff00', 0.35)}</color></PolyStyle></Style>`);

    // --- Enemy Nodes ---
    lines.push('  <Folder><name>Enemy Nodes (Red)</name>');
    for (const node of redNodes) {
        const ll = node.marker.getLatLng();
        lines.push('    <Placemark>');
        lines.push(`      <name>${escapeXml(node.name)}</name>`);
        lines.push('      <styleUrl>#redNode</styleUrl>');
        lines.push(`      <Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point>`);
        lines.push('    </Placemark>');
    }
    lines.push('  </Folder>');

    // --- Friendly Nodes ---
    lines.push('  <Folder><name>Friendly Nodes (Blue)</name>');
    for (const node of blueNodes) {
        const ll = node.marker.getLatLng();
        lines.push('    <Placemark>');
        lines.push(`      <name>${escapeXml(node.name)}</name>`);
        lines.push('      <styleUrl>#blueNode</styleUrl>');
        lines.push(`      <Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point>`);
        lines.push('    </Placemark>');
    }
    lines.push('  </Folder>');

    // --- Enemy Comms Links ---
    lines.push('  <Folder><name>Enemy Comms Links</name>');
    for (const link of enemyLinks) {
        const tx = findNode('red', link.txId);
        const rx = findNode('red', link.rxId);
        if (!tx || !rx) continue;
        const p1 = tx.marker.getLatLng();
        const p2 = rx.marker.getLatLng();
        lines.push('    <Placemark>');
        lines.push(`      <name>${escapeXml(link.id)}</name>`);
        lines.push('      <styleUrl>#enemyLink</styleUrl>');
        lines.push('      <LineString><tessellate>1</tessellate>');
        lines.push(`        <coordinates>${p1.lng},${p1.lat},0 ${p2.lng},${p2.lat},0</coordinates>`);
        lines.push('      </LineString>');
        lines.push('    </Placemark>');
        if (includeLabels) {
            const dist = (p1.distanceTo(p2) / 1000).toFixed(2);
            const midLat = (p1.lat + p2.lat) / 2;
            const midLng = (p1.lng + p2.lng) / 2;
            lines.push('    <Placemark>');
            lines.push(`      <name>${dist} km</name>`);
            lines.push('      <styleUrl>#linkLabel</styleUrl>');
            lines.push(`      <Point><coordinates>${midLng},${midLat},0</coordinates></Point>`);
            lines.push('    </Placemark>');
        }
    }
    lines.push('  </Folder>');

    // --- Jamming Links ---
    lines.push('  <Folder><name>Jamming Links</name>');
    for (const link of jammingLinks) {
        const blue = findNode('blue', link.blueId);
        const rx   = findNode('red',  link.rxId);
        if (!blue || !rx) continue;
        const p1 = blue.marker.getLatLng();
        const p2 = rx.marker.getLatLng();

        const cssColor = jammingLineColor(link.results);
        const colorName = cssColor === '#00ee00' ? 'green'
                        : cssColor === '#ff9900' ? 'orange'
                        : cssColor === '#ff3333' ? 'red'
                        : 'gray';

        const margins = (link.results || []).filter(r => r?.status === 'success').map(r => r.margin);
        const marginText = margins.length > 0 ? ` (${Math.max(...margins).toFixed(1)} dB)` : '';

        lines.push('    <Placemark>');
        lines.push(`      <name>${escapeXml(link.id + marginText)}</name>`);
        lines.push(`      <styleUrl>#jamLink-${colorName}</styleUrl>`);
        lines.push('      <LineString><tessellate>1</tessellate>');
        lines.push(`        <coordinates>${p1.lng},${p1.lat},0 ${p2.lng},${p2.lat},0</coordinates>`);
        lines.push('      </LineString>');
        lines.push('    </Placemark>');
        if (includeLabels) {
            const dist = (p1.distanceTo(p2) / 1000).toFixed(2);
            const midLat = (p1.lat + p2.lat) / 2;
            const midLng = (p1.lng + p2.lng) / 2;
            const labelText = marginText ? `${dist} km${marginText}` : `${dist} km`;
            lines.push('    <Placemark>');
            lines.push(`      <name>${escapeXml(labelText)}</name>`);
            lines.push('      <styleUrl>#linkLabel</styleUrl>');
            lines.push(`      <Point><coordinates>${midLng},${midLat},0</coordinates></Point>`);
            lines.push('    </Placemark>');
        }
    }
    lines.push('  </Folder>');

    // --- ES Detection Rings ---
    lines.push('  <Folder><name>ES Detection Rings</name>');
    for (const node of redNodes) {
        if (!node.esActive || !node.esPolygonPoints || node.esPolygonPoints.length < 3) continue;
        // esPolygonPoints is [[lat,lng],...]; KML needs lng,lat,alt; close the ring
        const pts = [...node.esPolygonPoints, node.esPolygonPoints[0]];
        const coordStr = pts.map(pt => `${pt[1]},${pt[0]},0`).join(' ');
        lines.push('    <Placemark>');
        lines.push(`      <name>${escapeXml(node.name)} Detection</name>`);
        lines.push('      <styleUrl>#esPoly</styleUrl>');
        lines.push('      <Polygon><tessellate>1</tessellate>');
        lines.push('        <outerBoundaryIs><LinearRing>');
        lines.push(`          <coordinates>${coordStr}</coordinates>`);
        lines.push('        </LinearRing></outerBoundaryIs>');
        lines.push('      </Polygon>');
        lines.push('    </Placemark>');
        if (includeLabels && node.esRangeKm != null) {
            const ll = node.marker.getLatLng();
            lines.push('    <Placemark>');
            lines.push(`      <name>Detection: ~${node.esRangeKm.toFixed(1)} km</name>`);
            lines.push('      <styleUrl>#linkLabel</styleUrl>');
            lines.push(`      <Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point>`);
            lines.push('    </Placemark>');
        }
    }
    lines.push('  </Folder>');

    // --- Overlap Zones ---
    if (overlapLayer) {
        const overlapLayers = overlapLayer.getLayers();
        if (overlapLayers.length > 0) {
            lines.push('  <Folder><name>Detection Overlap</name>');
            let idx = 1;
            for (const layer of overlapLayers) {
                const raw = layer.getLatLngs();
                // L.polygon.getLatLngs() returns [[L.LatLng,...]] for simple polygons
                const ring = Array.isArray(raw[0]) ? raw[0] : raw;
                const pts  = [...ring, ring[0]];
                const coordStr = pts.map(ll => `${ll.lng},${ll.lat},0`).join(' ');
                lines.push('    <Placemark>');
                lines.push(`      <name>Overlap Zone ${idx++}</name>`);
                lines.push('      <styleUrl>#overlapPoly</styleUrl>');
                lines.push('      <Polygon><tessellate>1</tessellate>');
                lines.push('        <outerBoundaryIs><LinearRing>');
                lines.push(`          <coordinates>${coordStr}</coordinates>`);
                lines.push('        </LinearRing></outerBoundaryIs>');
                lines.push('      </Polygon>');
                lines.push('    </Placemark>');
            }
            lines.push('  </Folder>');
        }
    }

    lines.push('</Document>');
    lines.push('</kml>');

    const kmlString = lines.join('\n');
    const blob = new Blob([kmlString], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'specter-export.kml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}
