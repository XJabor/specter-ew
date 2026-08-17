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
        })),
        ringsHidden: !!item.rings_hidden
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
    const node = { id, name: id, lat: latlng.lat, lon: latlng.lng, marker, systems: [], ringsHidden: false };
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
    const ringLabel = node.ringsHidden ? '📡 Show Rings' : '🚫 Hide Rings';
    node.marker.bindPopup(
        `<b>${escapeHtml(node.name)}</b><br>` +
        `<small>Drag to reposition. Rings clear on move.</small><br>` +
        `<button onclick="toggleEpNodeRings('${id}')">${ringLabel}</button><br>` +
        `<button onclick="map.closePopup(); removeEpNode('${id}')">🗑️ Remove Node</button>` +
        mgrsInputSection('ep', id, node),
        { minWidth: 180 }
    );
}

// Cancel the in-flight calculateEpNode() run for a node, if any.
function abortEpCalc(nodeId) {
    if (_epAbortControllers[nodeId]) {
        _epAbortControllers[nodeId].abort();
        delete _epAbortControllers[nodeId];
    }
}

// Full teardown: every ring invalidation path funnels through here, so this is
// also the one place that has to cancel a running calculation — otherwise the
// loop resumes after the await and re-draws rings onto a node that is gone.
function clearEpNodeRings(node) {
    abortEpCalc(node.id);
    node.systems.forEach(s => {
        removeLayerRef(s, 'layer', 'label');
        s.rangeKm       = null;
        s.polygonPoints = null;
    });
}

// Hide/show without discarding geometry: the layer objects stay on the system
// so re-showing costs no API calls. Teardown still goes through
// clearEpNodeRings — map.removeLayer on a detached layer is a no-op.
function setEpRingsHidden(node, hidden) {
    node.ringsHidden = hidden;
    node.systems.forEach(s => ['layer', 'label'].forEach(key => {
        if (!s[key]) return;
        if (hidden) map.removeLayer(s[key]);
        else if (!map.hasLayer(s[key])) s[key].addTo(map);
    }));
}

window.toggleEpNodeRings = function(nodeId) {
    const node = epNodes.find(n => n.id === nodeId);
    if (!node) return;
    setEpRingsHidden(node, !node.ringsHidden);
    map.closePopup();
    bindEpPopup(nodeId);
    updateEpWorkbench();
    markDirty('EP rings toggled.');
};

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
    // Monotonic index (shared with red systems): reusing the array length would
    // hand a deleted system's id to its replacement, and removeSystemFromEpNode
    // filters by id — so the collision would orphan a ring on the map.
    const sysIdx = nextSystemIndex(node);
    node.systems.push({
        id:               nodeId + '_S' + sysIdx,
        name:             'System ' + sysIdx,
        freqMhz:          150,
        txPowerW:         5,
        txGainDbi:        0,
        antennaType:      'omni',
        antennaAzimuth:   0,
        antennaBeamwidth: 360,
        antennaHeightAgl: 1.0,
        color:            EP_COLORS[(sysIdx - 1) % EP_COLORS.length],
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
    const sysIdx = nextSystemIndex(node);
    node.systems.push({
        id:               nodeId + '_S' + sysIdx,
        name:             template.name || ('System ' + sysIdx),
        freqMhz:          Number(template.frequency_mhz || 150),
        txPowerW:         Number(template.tx_power_w || 5),
        txGainDbi:        Number(template.antenna_gain_dbi || 0),
        antennaType:      template.antenna_type || 'omni',
        antennaAzimuth:   0,
        antennaBeamwidth: Number(template.beamwidth_deg || 360),
        antennaHeightAgl: Number(template.antenna_height_m || 1.0),
        color:            EP_COLORS[(sysIdx - 1) % EP_COLORS.length],
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

// Normalizers mirror the EA setters in nodes_links.js so both modes agree.
const EP_PARAM_NORMALIZERS = {
    antennaAzimuth:   v => ((parseFloat(v) || 0) % 360 + 360) % 360,
    antennaBeamwidth: v => Math.max(1, Math.min(360, parseFloat(v) || 90))
};

window.epUpdateSysParam = function(nodeId, sysId, param, val) {
    const node = epNodes.find(n => n.id === nodeId);
    const sys  = node && node.systems.find(s => s.id === sysId);
    if (!sys) return;
    const normalize = EP_PARAM_NORMALIZERS[param];
    sys[param] = normalize ? normalize(val) : val;
    // Rings are stale once any input changes; re-render also echoes clamped values back.
    clearEpNodeRings(node);
    updateEpWorkbench();
    markDirty('EP system changed.');
};

window.epUpdateSysAntennaType = function(nodeId, sysId, val) {
    const node = epNodes.find(n => n.id === nodeId);
    const sys  = node && node.systems.find(s => s.id === sysId);
    if (!sys) return;
    sys.antennaType = val === 'directional' ? 'directional' : 'omni';
    // A 360° "directional" system loses only ~3 dB at 180° off boresight, so it
    // renders as a round ring. Snap the omni default to the EA/backend default.
    if (sys.antennaType === 'directional' && sys.antennaBeamwidth >= 360) {
        sys.antennaBeamwidth = 90;
    }
    clearEpNodeRings(node);
    updateEpWorkbench();
    markDirty('EP system antenna changed.');
};

window.calculateEpNode = async function(nodeId) {
    const node = epNodes.find(n => n.id === nodeId);
    if (!node || node.systems.length === 0) return;
    markDirty('EP rings updated.');

    const terrain = document.getElementById('ep_terrain').value;
    const rxSens  = parseFloat(document.getElementById('ep_rx_sensitivity').value);
    clearEpNodeRings(node);   // also aborts any previous run for this node

    const controller = new AbortController();
    _epAbortControllers[nodeId] = controller;

    // True until this run is superseded by a newer one or the node disappears.
    const stillCurrent = () => _epAbortControllers[nodeId] === controller && epNodes.includes(node);

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
                body:    JSON.stringify(payload),
                signal:  controller.signal
            });
            const data = await r.json();
            // Bail before touching the map: the node may have been deleted or
            // recalculated while these awaits were pending.
            if (!stillCurrent()) return;
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
            // The toggle stays authoritative: a hidden node collects fresh
            // geometry and range readouts without its rings hitting the map.
            if (node.ringsHidden) setEpRingsHidden(node, true);
        } catch(e) {
            if (e.name === 'AbortError' || !stillCurrent()) return;
            console.error('EP calculate error for', sys.id, e);
        }
    }
    if (_epAbortControllers[nodeId] === controller) delete _epAbortControllers[nodeId];
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
        <div class="sys-card ep-theme" id="ep-card-${node.id}">
            <div class="sys-card-header">
                <input type="text" class="sys-card-name-input" value="${escapeHtml(node.name)}"
                    oninput="epUpdateNodeName('${node.id}', this.value)"
                    onclick="this.select()" title="Click to rename node">
                <button class="sys-card-delete-btn" onclick="removeEpNode('${node.id}')" title="Remove node">✕</button>
            </div>
            <div class="sys-library-row">
                <select id="ep-library-select-${node.id}">
                    ${epSystemTemplateOptionsHtml()}
                </select>
                <button class="workbench-btn" onclick="addLibrarySystemToEpNode('${node.id}')">Add From Library</button>
            </div>
            ${node.systems.length === 0
                ? '<p class="results-empty" style="margin:2px 0 4px 0;font-size:11px;">No systems — click + Add System.</p>'
                : node.systems.map(sys => `
                <div class="sys-row">
                    <span class="sys-color-dot" style="background:${sys.color};"></span>
                    <input type="text" class="sys-name" value="${escapeHtml(sys.name)}"
                        oninput="epUpdateSysName('${node.id}','${sys.id}',this.value)"
                        onclick="this.select()" title="System name">
                    <span class="sys-range">${sys.rangeKm !== null ? '~' + sys.rangeKm.toFixed(1) + ' km' : ''}</span>
                    <button class="sys-delete" onclick="removeSystemFromEpNode('${node.id}','${sys.id}')" title="Remove system">✕</button>
                    <div class="sys-params">
                        <label class="sys-label">Freq (MHz)
                            <input type="number" value="${sys.freqMhz}" min="30" max="40000"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','freqMhz',+this.value)">
                        </label>
                        <label class="sys-label">Tx Power (W)
                            <input type="number" value="${sys.txPowerW}" min="0.001" step="0.1"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','txPowerW',+this.value)">
                        </label>
                        <label class="sys-label">Tx Gain (dBi)
                            <input type="number" value="${sys.txGainDbi}" step="0.5"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','txGainDbi',+this.value)">
                        </label>
                        <label class="sys-label">Height AGL (m)
                            <input type="number" value="${sys.antennaHeightAgl}" min="1" max="500"
                                onchange="epUpdateSysParam('${node.id}','${sys.id}','antennaHeightAgl',+this.value)">
                        </label>
                        <label class="sys-label">Antenna
                            <select onchange="epUpdateSysAntennaType('${node.id}','${sys.id}',this.value)">
                                <option value="omni"${sys.antennaType !== 'directional' ? ' selected' : ''}>Omni</option>
                                <option value="directional"${sys.antennaType === 'directional' ? ' selected' : ''}>Directional</option>
                            </select>
                        </label>
                        <div class="sys-dir"${sys.antennaType === 'directional' ? '' : ' style="display:none"'}>
                            <label class="sys-label">Azimuth (° TN)
                                <input type="number" value="${sys.antennaAzimuth}" min="0" max="360"
                                    onchange="epUpdateSysParam('${node.id}','${sys.id}','antennaAzimuth',this.value)">
                            </label>
                            <label class="sys-label">Beamwidth (° HPBW)
                                <input type="number" value="${sys.antennaBeamwidth}" min="1" max="360"
                                    onchange="epUpdateSysParam('${node.id}','${sys.id}','antennaBeamwidth',this.value)">
                            </label>
                        </div>
                    </div>
                </div>`).join('')}
            <div class="sys-card-actions">
                <button class="workbench-btn" style="border-left:3px solid #27ae60;"
                    onclick="addSystemToEpNode('${node.id}')">+ Add System</button>
                <button class="workbench-btn" style="border-left:3px solid #27ae60;"
                    onclick="toggleEpNodeRings('${node.id}')">${node.ringsHidden ? 'Show Rings' : 'Hide Rings'}</button>
                <button class="workbench-btn" style="border-left:3px solid #27ae60; color:#27ae60;"
                    onclick="calculateEpNode('${node.id}')">Calculate</button>
            </div>
        </div>
    `).join('');
}
