// Specter-EW — EP (Electronic Protection) mode: EP nodes, per-system
// rings, and the EP workbench. EP state itself lives in map_core.js.
// Declarations only: wiring lives in app_init.js.

function makeEpNodeFromScenario(item) {
    const ll = [Number(item.location.lat), Number(item.location.lon)];
    const icon = L.divIcon({
        className: '',
        html: '<div class="ep-marker-dot"></div>',
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
    const marker = L.marker(ll, { icon, draggable: true }).addTo(map);
    const node = {
        id: item.id,
        name: item.name || item.id,
        lat: ll[0],
        lon: ll[1],
        marker,
        systems: (item.systems || []).map((sys, idx) => ({
            id: sys.id || item.id + '_S' + (idx + 1),
            name: sys.name || 'System ' + (idx + 1),
            freqMhz: Number(sys.freq_mhz || 150),
            txPowerW: Number(sys.tx_power_w || 5),
            txGainDbi: Number(sys.tx_gain_dbi || 0),
            antennaType: sys.antenna_type || 'omni',
            antennaAzimuth: Number(sys.antenna_azimuth || 0),
            antennaBeamwidth: Number(sys.antenna_beamwidth || 360),
            antennaHeightAgl: Number(sys.antenna_height_agl || 1.0),
            color: sys.color || EP_COLORS[idx % EP_COLORS.length],
            layer: null,
            label: null,
            polygonPoints: null,
            rangeKm: null,
            ringActive: !!sys.ring_active
        }))
    };
    marker.on('dragend', function(e) {
        node.lat = e.target.getLatLng().lat;
        node.lon = e.target.getLatLng().lng;
        clearEpNodeRings(node);
        markDirty('EP node moved.');
        updateMGRSTooltips();
        updateEpWorkbench();
    });
    epNodes.push(node);
    bindEpPopup(node.id);
    marker.on('popupclose', function() { bindEpPopup(node.id); });
}

// ============================================================
// EP MODE & MAP CLICK — PLACE NODES
// ============================================================

function toggleEpMode() {
    epModeActive = !epModeActive;
    document.body.classList.toggle('ep-mode', epModeActive);
    document.getElementById('ea-workbench').style.display  = epModeActive ? 'none' : '';
    document.getElementById('ep-workbench').style.display  = epModeActive ? ''     : 'none';
    const btn = document.getElementById('btn-ep-mode');
    btn.classList.toggle('active', epModeActive);
    btn.title = epModeActive ? 'Switch to EA/ES Mode' : 'Switch to EP Mode';
    if (epModeActive) setMode(null);
    markDirty('Mode changed.');
}

function placeEpNode(latlng) {
    const id   = 'EP' + (++epNodeCounter);
    const icon = L.divIcon({
        className:  '',
        html:       '<div class="ep-marker-dot"></div>',
        iconSize:   [24, 24],
        iconAnchor: [12, 12]
    });
    const marker = L.marker(latlng, { icon, draggable: true }).addTo(map);
    const node = { id, name: id, lat: latlng.lat, lon: latlng.lng, marker, systems: [] };
    epNodes.push(node);

    marker.on('dragend', function(e) {
        node.lat = e.target.getLatLng().lat;
        node.lon = e.target.getLatLng().lng;
        clearEpNodeRings(node);
        markDirty('EP node moved.');
        updateMGRSTooltips();
        updateEpWorkbench();
    });
    bindEpPopup(id);
    marker.on('popupclose', function() { bindEpPopup(id); });
    updateMGRSTooltips();
    updateEpWorkbench();
    markDirty('EP node added.');
}

function bindEpPopup(id) {
    const node = epNodes.find(n => n.id === id);
    if (!node) return;
    node.marker.bindPopup(
        `<b>${escapeHtml(node.name)}</b><br>` +
        `<small>Drag to reposition. Rings clear on move.</small><br>` +
        `<button onclick="map.closePopup(); removeEpNode('${id}')">🗑️ Remove Node</button>` +
        mgrsInputSection('ep', id, node),
        { minWidth: 180 }
    );
}

function clearEpNodeRings(node) {
    node.systems.forEach(s => {
        removeLayerRef(s, 'layer', 'label');
        s.rangeKm       = null;
        s.polygonPoints = null;
    });
}

window.removeEpNode = function(nodeId) {
    const idx = epNodes.findIndex(n => n.id === nodeId);
    if (idx === -1) return;
    const node = epNodes[idx];
    clearEpNodeRings(node);
    map.removeLayer(node.marker);
    epNodes.splice(idx, 1);
    updateEpWorkbench();
    markDirty('EP node removed.');
};

window.addSystemToEpNode = function(nodeId) {
    const node = epNodes.find(n => n.id === nodeId);
    if (!node) return;
    const sysIdx = node.systems.length;
    node.systems.push({
        id:               nodeId + '_S' + (sysIdx + 1),
        name:             'System ' + (sysIdx + 1),
        freqMhz:          150,
        txPowerW:         5,
        txGainDbi:        0,
        antennaType:      'omni',
        antennaAzimuth:   0,
        antennaBeamwidth: 360,
        antennaHeightAgl: 1.0,
        color:            EP_COLORS[sysIdx % EP_COLORS.length],
        layer:            null,
        label:            null,
        polygonPoints:    null,
        rangeKm:          null
    });
    updateEpWorkbench();
    markDirty('EP system added.');
};

window.addLibrarySystemToEpNode = function(nodeId) {
    const node = epNodes.find(n => n.id === nodeId);
    const select = document.getElementById(`ep-library-select-${nodeId}`);
    const template = select && findNodeTemplate(select.value);
    if (!node || !template) return;
    const sysIdx = node.systems.length;
    node.systems.push({
        id:               nodeId + '_S' + (sysIdx + 1),
        name:             template.name || ('System ' + (sysIdx + 1)),
        freqMhz:          Number(template.frequency_mhz || 150),
        txPowerW:         Number(template.tx_power_w || 5),
        txGainDbi:        Number(template.antenna_gain_dbi || 0),
        antennaType:      template.antenna_type || 'omni',
        antennaAzimuth:   0,
        antennaBeamwidth: Number(template.beamwidth_deg || 360),
        antennaHeightAgl: Number(template.antenna_height_m || 1.0),
        color:            EP_COLORS[sysIdx % EP_COLORS.length],
        layer:            null,
        label:            null,
        polygonPoints:    null,
        rangeKm:          null
    });
    clearEpNodeRings(node);
    updateEpWorkbench();
    markDirty('EP library system added.');
};

window.removeSystemFromEpNode = function(nodeId, sysId) {
    const node = epNodes.find(n => n.id === nodeId);
    if (!node) return;
    const sys = node.systems.find(s => s.id === sysId);
    if (sys) removeLayerRef(sys, 'layer', 'label');
    node.systems = node.systems.filter(s => s.id !== sysId);
    updateEpWorkbench();
    markDirty('EP system removed.');
};

window.epUpdateNodeName = function(nodeId, val) {
    const node = epNodes.find(n => n.id === nodeId);
    if (node) { node.name = val; updateMGRSTooltips(); markDirty('EP node renamed.'); }
};

window.epUpdateSysName = function(nodeId, sysId, val) {
    const node = epNodes.find(n => n.id === nodeId);
    const sys  = node && node.systems.find(s => s.id === sysId);
    if (sys) { sys.name = val; markDirty('EP system renamed.'); }
};

window.epUpdateSysParam = function(nodeId, sysId, param, val) {
    const node = epNodes.find(n => n.id === nodeId);
    const sys  = node && node.systems.find(s => s.id === sysId);
    if (sys) { sys[param] = val; markDirty('EP system changed.'); }
};

window.calculateEpNode = async function(nodeId) {
    const node = epNodes.find(n => n.id === nodeId);
    if (!node || node.systems.length === 0) return;
    markDirty('EP rings updated.');

    const terrain = document.getElementById('ep_terrain').value;
    const rxSens  = parseFloat(document.getElementById('ep_rx_sensitivity').value);
    clearEpNodeRings(node);

    for (let sysIdx = 0; sysIdx < node.systems.length; sysIdx++) {
        const sys = node.systems[sysIdx];
        const labelOffset = [0, sysIdx * 20];
        const payload = {
            freq_mhz:            sys.freqMhz,
            enemy_terrain:       terrain,
            enemy_tx_w:          sys.txPowerW,
            enemy_tx_gain:       sys.txGainDbi,
            rx_sensitivity:      rxSens,
            friendly_rx_gain:    0,
            enemy_lat:           node.lat,
            enemy_lon:           node.lon,
            tx_antenna_type:     sys.antennaType,
            tx_azimuth_deg:      sys.antennaAzimuth,
            tx_beamwidth_deg:    sys.antennaBeamwidth,
            tx_antenna_height_m: sys.antennaHeightAgl
        };
        try {
            const r    = await fetch('/calculate_es_terrain', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload)
            });
            const data = await r.json();
            if (data.status !== 'success') continue;

            sys.rangeKm       = data.base_range_km;
            sys.polygonPoints = data.polygon_points;
            const label = `${sys.name}: ~${data.base_range_km.toFixed(1)} km`;

            if (data.polygon_points) {
                sys.layer = L.polygon(data.polygon_points, {
                    color: sys.color, fillColor: sys.color, fillOpacity: 0.13, weight: 2
                }).addTo(map);
                sys.label = makeEdgeLabel(data.polygon_points, null, null, null, label, labelOffset);
            } else {
                const radiusMeters = data.base_range_km * 1000;
                sys.layer = L.circle([node.lat, node.lon], {
                    radius: radiusMeters,
                    color: sys.color, fillColor: sys.color, fillOpacity: 0.13, weight: 2
                }).addTo(map);
                sys.label = makeEdgeLabel(null, node.lat, node.lon, radiusMeters, label, labelOffset);
            }
        } catch(e) {
            console.error('EP calculate error for', sys.id, e);
        }
    }
    updateEpWorkbench();
};

function updateEpWorkbench() {
    const container = document.getElementById('ep-nodes-list');
    if (!container) return;

    if (epNodes.length === 0) {
        container.innerHTML = '<p class="results-empty">No EP nodes placed.</p>';
        return;
    }

    container.innerHTML = epNodes.map(node => `
        <div class="ep-node-card" id="ep-card-${node.id}">
            <div class="ep-node-header">
                <input type="text" class="ep-node-name-input" value="${escapeHtml(node.name)}"
                    oninput="epUpdateNodeName('${node.id}', this.value)"
                    onclick="this.select()" title="Click to rename node">
                <button class="ep-node-delete-btn" onclick="removeEpNode('${node.id}')" title="Remove node">✕</button>
            </div>
            <div class="ep-library-row">
                <select id="ep-library-select-${node.id}">
                    ${epSystemTemplateOptionsHtml()}
                </select>
                <button class="workbench-btn" onclick="addLibrarySystemToEpNode('${node.id}')">Add From Library</button>
            </div>
            ${node.systems.length === 0
                ? '<p class="results-empty" style="margin:2px 0 4px 0;font-size:11px;">No systems — click + Add System.</p>'
                : node.systems.map(sys => `
                <div class="ep-system-row">
                    <span class="ep-system-color-dot" style="background:${sys.color};"></span>
                    <input type="text" class="ep-sys-name" value="${escapeHtml(sys.name)}"
                        oninput="epUpdateSysName('${node.id}','${sys.id}',this.value)"
                        onclick="this.select()" title="System name">
                    <span class="ep-sys-range">${sys.rangeKm !== null ? '~' + sys.rangeKm.toFixed(1) + ' km' : ''}</span>
                    <button class="ep-sys-delete" onclick="removeSystemFromEpNode('${node.id}','${sys.id}')" title="Remove system">✕</button>
                    <div class="ep-sys-params">
                        <label class="ep-sys-label">Freq (MHz)
                            <input type="number" value="${sys.freqMhz}" min="30" max="40000"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','freqMhz',+this.value)">
                        </label>
                        <label class="ep-sys-label">Tx Power (W)
                            <input type="number" value="${sys.txPowerW}" min="0.001" step="0.1"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','txPowerW',+this.value)">
                        </label>
                        <label class="ep-sys-label">Tx Gain (dBi)
                            <input type="number" value="${sys.txGainDbi}" step="0.5"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','txGainDbi',+this.value)">
                        </label>
                        <label class="ep-sys-label">Height AGL (m)
                            <input type="number" value="${sys.antennaHeightAgl}" min="1" max="500"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','antennaHeightAgl',+this.value)">
                        </label>
                    </div>
                </div>`).join('')}
            <div class="ep-node-actions">
                <button class="workbench-btn" style="border-left:3px solid #27ae60;"
                    onclick="addSystemToEpNode('${node.id}')">+ Add System</button>
                <button class="workbench-btn" style="border-left:3px solid #27ae60; color:#27ae60;"
                    onclick="calculateEpNode('${node.id}')">Calculate</button>
            </div>
        </div>
    `).join('');
}
