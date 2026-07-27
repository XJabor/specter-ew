// Specter-EW — extra frequency systems attached to red (enemy) nodes.
// A red node's own equipment drives one ES ring, links, and J/S pairs; these
// systems are additive, ring-only emitters (no links, no jamming, no sidebar).
// Mirrors the EP per-system pattern in ep_mode.js. Shared palette lives in
// map_core.js. Declarations only: wiring lives in app_init.js.

// ============================================================
// SYSTEM CONSTRUCTION
// ============================================================

// Monotonic per-node index, so deleting a system never lets the next one
// collide with a surviving sibling's id or palette colour.
function nextRedSystemIndex(node) {
    const used = (node.systems || []).map(sys => {
        const m = /_S(\d+)$/.exec(sys.id || '');
        return m ? Number(m[1]) : 0;
    });
    return Math.max(0, ...used) + 1;
}

function newRedSystem(node, idx, fields) {
    return {
        id:               node.id + '_S' + idx,
        name:             'System ' + idx,
        freqMhz:          150,
        txPowerW:         5,
        txGainDbi:        0,
        antennaType:      'omni',
        antennaAzimuth:   0,
        antennaBeamwidth: 360,
        antennaHeightAgl: 1.0,
        color:            RED_SYSTEM_COLORS[(idx - 1) % RED_SYSTEM_COLORS.length],
        layer:            null,
        label:            null,
        polygonPoints:    null,
        rangeKm:          null,
        ringActive:       false,
        ...fields
    };
}

// Runtime system from its persisted snake_case form. Mirrors the EP mapping in
// makeEpNodeFromScenario; runtime-only layer/label/geometry fields stay null.
function redSystemFromScenario(sys, idx, nodeId) {
    return {
        id:               sys.id || nodeId + '_S' + (idx + 1),
        name:             sys.name || 'System ' + (idx + 1),
        freqMhz:          Number(sys.freq_mhz || 150),
        txPowerW:         Number(sys.tx_power_w || 5),
        txGainDbi:        Number(sys.tx_gain_dbi || 0),
        antennaType:      sys.antenna_type || 'omni',
        antennaAzimuth:   Number(sys.antenna_azimuth || 0),
        antennaBeamwidth: Number(sys.antenna_beamwidth || 360),
        antennaHeightAgl: Number(sys.antenna_height_agl || 1.0),
        color:            sys.color || RED_SYSTEM_COLORS[idx % RED_SYSTEM_COLORS.length],
        layer:            null,
        label:            null,
        polygonPoints:    null,
        rangeKm:          null,
        ringActive:       !!sys.ring_active
    };
}

// Persisted form of a system. Keys match the EP system mapper in scenario_io.js.
function redSystemScenarioState(sys) {
    return {
        id:                 sys.id,
        name:               sys.name,
        freq_mhz:           Number(sys.freqMhz),
        tx_power_w:         Number(sys.txPowerW),
        tx_gain_dbi:        Number(sys.txGainDbi),
        antenna_type:       sys.antennaType || 'omni',
        antenna_azimuth:    Number(sys.antennaAzimuth || 0),
        antenna_beamwidth:  Number(sys.antennaBeamwidth || 360),
        antenna_height_agl: Number(sys.antennaHeightAgl || 1.0),
        color:              sys.color,
        ring_active:        !!(sys.layer || sys.polygonPoints)
    };
}

// ============================================================
// TEARDOWN
// ============================================================

function clearRedSystemRings(node) {
    if (!node || !Array.isArray(node.systems)) return;
    node.systems.forEach(sys => {
        removeLayerRef(sys, 'layer', 'label');
        sys.rangeKm       = null;
        sys.polygonPoints = null;
    });
    clearOverlapLayer();
}

// ============================================================
// MUTATORS
// ============================================================
// Every mutator ends the same way: invalidate the rings (any parameter change
// makes the computed polygon stale), re-render the workbench, mark dirty.

window.addSystemToRedNode = function(nodeId) {
    const node = findNode('red', nodeId);
    if (!node) return;
    node.systems.push(newRedSystem(node, nextRedSystemIndex(node)));
    updateRedSystemsWorkbench();
    renderOverlapControls();
    markDirty('Enemy system added.');
};

window.addLibrarySystemToRedNode = function(nodeId) {
    const node = findNode('red', nodeId);
    const select = document.getElementById(`red-library-select-${nodeId}`);
    const template = select && findNodeTemplate(select.value);
    if (!node || !template) return;
    const idx = nextRedSystemIndex(node);
    node.systems.push(newRedSystem(node, idx, {
        name:             template.name || ('System ' + idx),
        freqMhz:          Number(template.frequency_mhz || 150),
        txPowerW:         Number(template.tx_power_w || 5),
        txGainDbi:        Number(template.antenna_gain_dbi || 0),
        antennaType:      template.antenna_type || 'omni',
        antennaBeamwidth: Number(template.beamwidth_deg || 360),
        antennaHeightAgl: Number(template.antenna_height_m || 1.0)
    }));
    updateRedSystemsWorkbench();
    renderOverlapControls();
    markDirty('Enemy library system added.');
};

window.removeSystemFromRedNode = function(nodeId, sysId) {
    const node = findNode('red', nodeId);
    if (!node) return;
    const sys = node.systems.find(s => s.id === sysId);
    if (sys) removeLayerRef(sys, 'layer', 'label');
    node.systems = node.systems.filter(s => s.id !== sysId);
    clearOverlapLayer();
    updateRedSystemsWorkbench();
    renderOverlapControls();
    markDirty('Enemy system removed.');
};

// Free text: no re-render, or the innerHTML rebuild would steal focus mid-typing.
window.redUpdateSysName = function(nodeId, sysId, val) {
    const node = findNode('red', nodeId);
    const sys  = node && node.systems.find(s => s.id === sysId);
    if (sys) { sys.name = val; renderOverlapControls(); markDirty('Enemy system renamed.'); }
};

// Normalizers mirror the EA setters in nodes_links.js so both agree.
const RED_SYS_PARAM_NORMALIZERS = {
    antennaAzimuth:   v => ((parseFloat(v) || 0) % 360 + 360) % 360,
    antennaBeamwidth: v => Math.max(1, Math.min(360, parseFloat(v) || 90))
};

window.redUpdateSysParam = function(nodeId, sysId, param, val) {
    const node = findNode('red', nodeId);
    const sys  = node && node.systems.find(s => s.id === sysId);
    if (!sys) return;
    const normalize = RED_SYS_PARAM_NORMALIZERS[param];
    sys[param] = normalize ? normalize(val) : val;
    // Rings are stale once any input changes; re-render also echoes clamped values back.
    clearRedSystemRings(node);
    updateRedSystemsWorkbench();
    renderOverlapControls();
    markDirty('Enemy system changed.');
};

window.redUpdateSysAntennaType = function(nodeId, sysId, val) {
    const node = findNode('red', nodeId);
    const sys  = node && node.systems.find(s => s.id === sysId);
    if (!sys) return;
    sys.antennaType = val === 'directional' ? 'directional' : 'omni';
    // A 360° "directional" system loses only ~3 dB at 180° off boresight, so it
    // renders as a round ring. Snap the omni default to the EA/backend default.
    if (sys.antennaType === 'directional' && sys.antennaBeamwidth >= 360) {
        sys.antennaBeamwidth = 90;
    }
    clearRedSystemRings(node);
    updateRedSystemsWorkbench();
    renderOverlapControls();
    markDirty('Enemy system antenna changed.');
};

// ============================================================
// CALCULATION
// ============================================================
// Manual, per node: one sequential /calculate_es_terrain call per system keeps
// us inside the OpenTopoData 1 req/sec limit that also shapes calculateEpNode.

window.calculateRedNodeSystems = async function(nodeId) {
    const node = findNode('red', nodeId);
    if (!node || !node.systems || node.systems.length === 0) return;
    markDirty('Enemy system rings updated.');

    const terrain = document.getElementById('enemy_terrain').value;
    // Same reference the node's own ES ring uses, so both answer one question.
    const sensor  = selectedSensorReference();
    const ll      = node.marker.getLatLng();
    clearRedSystemRings(node);

    for (let sysIdx = 0; sysIdx < node.systems.length; sysIdx++) {
        const sys = node.systems[sysIdx];
        // Offset by one slot so system labels stack below the node's own ES label.
        const labelOffset = [0, (sysIdx + 1) * 20];
        const payload = {
            freq_mhz:            sys.freqMhz,
            enemy_terrain:       terrain,
            enemy_tx_w:          sys.txPowerW,
            enemy_tx_gain:       sys.txGainDbi,
            rx_sensitivity:      sensor.rxSensitivityDbm,
            friendly_rx_gain:    sensor.rxGainDbi,
            enemy_lat:           ll.lat,
            enemy_lon:           ll.lng,
            tx_antenna_type:     sys.antennaType,
            tx_azimuth_deg:      sys.antennaAzimuth,
            tx_beamwidth_deg:    sys.antennaBeamwidth,
            tx_antenna_height_m: sys.antennaHeightAgl
        };
        try {
            const r = await fetch('/calculate_es_terrain', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify(payload)
            });
            const data = await r.json();
            if (data.status !== 'success') continue;

            sys.rangeKm = data.base_range_km;
            const style = { color: sys.color, fillColor: sys.color, fillOpacity: 0.13, weight: 2 };
            const label = `${sensor.name} detects ${sys.name}: ~${data.base_range_km.toFixed(1)} km`;

            if (data.polygon_points) {
                sys.polygonPoints = data.polygon_points;
                sys.layer = L.polygon(data.polygon_points, style).addTo(map);
                sys.label = makeEdgeLabel(data.polygon_points, null, null, null, label, labelOffset);
            } else {
                // Always keep a polygon so overlap and KML work on circle fallbacks too.
                sys.polygonPoints = circleToPolygon(ll.lat, ll.lng, data.base_range_km);
                const radiusMeters = data.base_range_km * 1000;
                sys.layer = L.circle(ll, { ...style, radius: radiusMeters }).addTo(map);
                sys.label = makeEdgeLabel(null, ll.lat, ll.lng, radiusMeters, label, labelOffset);
            }
        } catch (e) {
            console.error('Enemy system calculate error for', sys.id, e);
        }
    }
    updateRedSystemsWorkbench();
    renderOverlapControls();
};

// ============================================================
// WORKBENCH
// ============================================================

function updateRedSystemsWorkbench() {
    const container = document.getElementById('red-systems-list');
    if (!container) return;

    if (redNodes.length === 0) {
        container.innerHTML = '<p class="results-empty">No enemy nodes placed.</p>';
        return;
    }

    container.innerHTML = redNodes.map(node => `
        <div class="sys-card red-theme" id="red-sys-card-${node.id}">
            <div class="sys-card-header">
                <span class="sys-card-title" title="Rename from the node popup">${escapeHtml(node.name)}</span>
            </div>
            <div class="sys-library-row">
                <select id="red-library-select-${node.id}">
                    ${epSystemTemplateOptionsHtml()}
                </select>
                <button class="workbench-btn" onclick="addLibrarySystemToRedNode('${node.id}')">Add From Library</button>
            </div>
            ${(node.systems || []).length === 0
                ? '<p class="results-empty" style="margin:2px 0 4px 0;font-size:11px;">No extra systems — click + Add System.</p>'
                : node.systems.map(sys => `
                <div class="sys-row">
                    <span class="sys-color-dot" style="background:${sys.color};"></span>
                    <input type="text" class="sys-name" value="${escapeHtml(sys.name)}"
                        oninput="redUpdateSysName('${node.id}','${sys.id}',this.value)"
                        onclick="this.select()" title="System name">
                    <span class="sys-range">${sys.rangeKm !== null ? '~' + sys.rangeKm.toFixed(1) + ' km' : ''}</span>
                    <button class="sys-delete" onclick="removeSystemFromRedNode('${node.id}','${sys.id}')" title="Remove system">✕</button>
                    <div class="sys-params">
                        <label class="sys-label">Freq (MHz)
                            <input type="number" value="${sys.freqMhz}" min="30" max="40000"
                                onchange="redUpdateSysParam('${node.id}','${sys.id}','freqMhz',+this.value)">
                        </label>
                        <label class="sys-label">Tx Power (W)
                            <input type="number" value="${sys.txPowerW}" min="0.001" step="0.1"
                                onchange="redUpdateSysParam('${node.id}','${sys.id}','txPowerW',+this.value)">
                        </label>
                        <label class="sys-label">Tx Gain (dBi)
                            <input type="number" value="${sys.txGainDbi}" step="0.5"
                                onchange="redUpdateSysParam('${node.id}','${sys.id}','txGainDbi',+this.value)">
                        </label>
                        <label class="sys-label">Height AGL (m)
                            <input type="number" value="${sys.antennaHeightAgl}" min="1" max="500"
                                onchange="redUpdateSysParam('${node.id}','${sys.id}','antennaHeightAgl',+this.value)">
                        </label>
                        <label class="sys-label">Antenna
                            <select onchange="redUpdateSysAntennaType('${node.id}','${sys.id}',this.value)">
                                <option value="omni"${sys.antennaType !== 'directional' ? ' selected' : ''}>Omni</option>
                                <option value="directional"${sys.antennaType === 'directional' ? ' selected' : ''}>Directional</option>
                            </select>
                        </label>
                        <div class="sys-dir"${sys.antennaType === 'directional' ? '' : ' style="display:none"'}>
                            <label class="sys-label">Azimuth (° TN)
                                <input type="number" value="${sys.antennaAzimuth}" min="0" max="360"
                                    onchange="redUpdateSysParam('${node.id}','${sys.id}','antennaAzimuth',this.value)">
                            </label>
                            <label class="sys-label">Beamwidth (° HPBW)
                                <input type="number" value="${sys.antennaBeamwidth}" min="1" max="360"
                                    onchange="redUpdateSysParam('${node.id}','${sys.id}','antennaBeamwidth',this.value)">
                            </label>
                        </div>
                    </div>
                </div>`).join('')}
            <div class="sys-card-actions">
                <button class="workbench-btn" style="border-left:3px solid #ff4444;"
                    onclick="addSystemToRedNode('${node.id}')">+ Add System</button>
                <button class="workbench-btn" style="border-left:3px solid #ff4444; color:#ff6b6b;"
                    onclick="calculateRedNodeSystems('${node.id}')">Calculate</button>
            </div>
        </div>
    `).join('');
}
