// Specter-EW — calculation engine, ES detection rings, blue sensor
// coverage, jammer footprints, overlap analysis, and results rendering.
// Declarations only: wiring lives in app_init.js.

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
    const esOver = activeSensorCoverages().some(item => item.coverage.rangeKm != null && item.coverage.rangeKm > 50);
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
    scheduleFootprintUpdate();
    updateLinkAllBtn();

    if (jammingLinks.length === 0) {
        updateDistanceWarning();
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

    tasks.forEach(({ jLink, eLink, i }) => {
        const payload = buildEaPayload(jLink, eLink, params);

        calcFetch('/calculate_ea', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(r => r.json())
        .then(data => {
            jLink.results[i] = data.status === 'success'
                ? { ...data, enemyLinkId: eLink.id, record: eaRecord(jLink, eLink, payload, data) }
                : { status: 'error', enemyLinkId: eLink.id };
            jLink.line.setStyle({ color: jammingLineColor(jLink.results), weight: 4 });
            done();
        })
        .catch(() => { jLink.results[i] = { status: 'error', enemyLinkId: eLink.id }; done(); });
    });
}

// /calculate_ea request for one jamming pair, from current node state. Also
// used by the inspector to detect results whose inputs have since changed.
function buildEaPayload(jLink, eLink, params = getParams()) {
    const blue = findNode('blue', jLink.blueId);
    const rx   = findNode('red',  jLink.rxId);
    const tx   = findNode('red',  eLink.txId);
    const txEq = tx ? nodeEquipment(tx, 'red') : {};
    const rxEq = rx ? nodeEquipment(rx, 'red') : {};
    const blueEq = blue ? nodeEquipment(blue, 'blue') : {};
    const dist = (a, b) => (a && b) ? a.marker.getLatLng().distanceTo(b.marker.getLatLng()) / 1000 : null;
    const payload = {
        ...params,
        freq_mhz: txEq.frequency_mhz ?? params.freq_mhz,
        enemy_tx_w: txEq.tx_power_w ?? params.enemy_tx_w,
        enemy_tx_gain: txEq.antenna_gain_dbi ?? params.enemy_tx_gain,
        enemy_rx_gain: rxEq.rx_gain_dbi ?? rxEq.antenna_gain_dbi ?? params.enemy_rx_gain,
        apply_fh: !!txEq.apply_fh,
        enemy_bw_khz: txEq.channel_bw_khz ?? params.enemy_bw_khz,
        jammer_tx_w: blueEq.tx_power_w ?? params.jammer_tx_w,
        jammer_tx_gain: blueEq.antenna_gain_dbi ?? params.jammer_tx_gain,
        jammer_bw_khz: blueEq.jammer_bw_khz ?? params.jammer_bw_khz,
        rx_sensitivity: rxEq.rx_sensitivity_dbm ?? params.rx_sensitivity,
        friendly_rx_gain: blueEq.rx_gain_dbi ?? params.friendly_rx_gain,
        enemy_dist_km: dist(tx, rx),
        jammer_dist_km: dist(blue, rx)
    };
    // Include node coordinates so the backend can perform elevation-aware LOS analysis
    // and bearing-based directional antenna gain calculations
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
        payload.tx_antenna_type      = txEq.antenna_type || tx.antennaType;
        payload.tx_azimuth_deg       = tx.antennaAzimuth;
        payload.tx_beamwidth_deg     = txEq.beamwidth_deg || tx.antennaBeamwidth;
        payload.rx_antenna_type      = rxEq.antenna_type || rx.antennaType;
        payload.rx_azimuth_deg       = rx.antennaAzimuth;
        payload.rx_beamwidth_deg     = rxEq.beamwidth_deg || rx.antennaBeamwidth;
        payload.jammer_antenna_type  = blueEq.antenna_type || blue.antennaType;
        payload.jammer_azimuth_deg   = blue.antennaAzimuth;
        payload.jammer_beamwidth_deg = blueEq.beamwidth_deg || blue.antennaBeamwidth;
        payload.tx_antenna_height_m     = txEq.antenna_height_m || tx.antennaHeightAgl;
        payload.rx_antenna_height_m     = rxEq.antenna_height_m || rx.antennaHeightAgl;
        payload.jammer_antenna_height_m = blueEq.antenna_height_m || blue.antennaHeightAgl;
    }
    return payload;
}

function nodeRef(type, id) {
    const node = findNode(type, id);
    return { id, name: plainNodeName(node ? node.name : id) };
}

function eaRecord(jLink, eLink, payload, data) {
    return SpecterResults.buildLinkResult({
        id: `${jLink.id}|${eLink.id}`,
        subject: {
            jammer: nodeRef('blue', jLink.blueId),
            transmitter: nodeRef('red', eLink.txId),
            target: nodeRef('red', jLink.rxId),
        },
        request: payload,
        response: data,
    });
}

function clearSensorCoverage(node, redId = null) {
    if (!node || !Array.isArray(node.sensorCoverages)) return;
    node.sensorCoverages = node.sensorCoverages.filter(coverage => {
        const shouldRemove = redId == null || coverage.redId === redId;
        if (shouldRemove) {
            if (coverage.layer) map.removeLayer(coverage.layer);
            if (coverage.label) map.removeLayer(coverage.label);
        }
        return !shouldRemove;
    });
}

function clearSensorCoverageForRed(redId) {
    blueNodes.forEach(node => clearSensorCoverage(node, redId));
}

function activeSensorCoverages() {
    const blueCoverages = blueNodes.flatMap(node => (node.sensorCoverages || []).map(coverage => ({ sensor: node, coverage })));
    const redCoverages = redNodes
        .filter(node => node.esActive && node.esPolygonPoints)
        .map(node => ({
            sensor: { id: `red-ring-${node.id}`, name: node.esSensorName || 'Sensor' },
            coverage: {
                redId: node.id,
                rangeKm: node.esRangeKm,
                polygonPoints: node.esPolygonPoints,
                layer: node.esCircle,
                label: node.esLabel
            }
        }));
    // Extra red systems each contribute their own ring. The synthetic sensor id
    // is system-scoped, so the `${sensor.id}:${redId}` overlap key stays unique.
    const redSystemCoverages = redNodes.flatMap(node =>
        (node.systems || []).filter(sys => sys.polygonPoints).map(sys => ({
            // System names are stored raw; every other sensor name here is
            // already HTML-escaped, and the overlap checklist renders them as markup.
            sensor: { id: `red-sys-${sys.id}`, name: escapeHtml(sys.name) },
            coverage: {
                redId: node.id,
                // Marks the entry so KML can route it to its own coloured folder
                // instead of the flat-red ES ring folder.
                redSystem: sys,
                rangeKm: sys.rangeKm,
                polygonPoints: sys.polygonPoints,
                layer: sys.layer,
                label: sys.label
            }
        })));
    return blueCoverages.concat(redCoverages, redSystemCoverages);
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

// Keyboard-reachable inspector entry for a ring listed in the overlap
// checklist (map ring clicks are mouse-only).
function coverageInspectButton(item) {
    const c = item.coverage;
    let ref = null, hasResult = false;
    if (c.redSystem) {
        ref = { kind: 'red-system', nodeId: c.redId, sysId: c.redSystem.id };
        hasResult = !!c.redSystem.result;
    } else if (String(item.sensor.id).startsWith('red-ring-')) {
        ref = { kind: 'es-ring', nodeId: c.redId };
        hasResult = !!findNode('red', c.redId)?.esResult;
    } else {
        ref = { kind: 'sensor-coverage', sensorId: item.sensor.id, redId: c.redId };
        hasResult = !!c.result;
    }
    return hasResult
        ? `<button class="inspect-btn" ${inspectDataAttr(ref)} title="Explain this ring" aria-label="Explain ${item.sensor.name} ring">ⓘ</button>`
        : '';
}

function renderOverlapControls() {
    const checklist = document.getElementById('overlap-checklist');
    const showBtn   = document.getElementById('btn-show-overlap');
    if (!checklist || !showBtn) return;

    const eligible = activeSensorCoverages().filter(item => item.coverage.polygonPoints);

    if (eligible.length === 0) {
        checklist.innerHTML = '<p class="results-empty">No active detection rings.</p>';
        showBtn.disabled = true;
        return;
    }

    // Prune stale IDs no longer eligible
    overlapChecked.forEach(id => {
        if (!eligible.find(item => `${item.sensor.id}:${item.coverage.redId}` === id)) overlapChecked.delete(id);
    });

    let html = '';
    eligible.forEach(item => {
        const id = `${item.sensor.id}:${item.coverage.redId}`;
        const tx = findNode('red', item.coverage.redId);
        const checked = overlapChecked.has(id) ? 'checked' : '';
        html += `<div class="overlap-node-row">
            <input type="checkbox" id="ov-chk-${id}" value="${id}" ${checked}
                onchange="handleOverlapCheck(this)">
            <label for="ov-chk-${id}">${item.sensor.name} / ${tx ? tx.name : item.coverage.redId}</label>
            ${coverageInspectButton(item)}
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
    markDirty('Overlap selection changed.');
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

function computeAndShowOverlap(suppressDirty = false) {
    clearOverlapLayer();
    const statusEl = document.getElementById('overlap-status');

    const selected = activeSensorCoverages()
        .filter(item => overlapChecked.has(`${item.sensor.id}:${item.coverage.redId}`) && item.coverage.polygonPoints);
    if (selected.length < 2) {
        if (statusEl) statusEl.textContent = 'Select at least 2 nodes.';
        return;
    }

    if (statusEl) statusEl.textContent = 'Calculating...';
    calcFetch('/compute_overlap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ polygons: selected.map(item => item.coverage.polygonPoints) })
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
        if (!suppressDirty) markDirty('Overlap overlay updated.');
    })
    .catch(() => { if (statusEl) statusEl.textContent = 'Error computing overlap.'; });
}

// ============================================================
// ES CIRCLES (DETECTION RINGS)
// ============================================================

// Debounced entry point — called from recalculateAll() to avoid rapid-fire API requests
// when the user is dragging nodes or changing parameters quickly.
function scheduleESUpdate() {
    clearTimeout(_esDebounceTimer);
    _esDebounceTimer = setTimeout(updateESCircles, 300);
}

// ============================================================
// JAMMER FOOTPRINT
// ============================================================

window.toggleNodeSensorCoverage = function(id) {
    const node = findNode('blue', id);
    if (!node || !isReceiverCapableNode(node, 'blue')) return;
    node.sensorActive = !node.sensorActive;
    if (!node.sensorActive) {
        clearSensorCoverage(node);
        clearOverlapLayer();
    }
    map.closePopup();
    bindBluePopup(id);
    markDirty('Sensor coverage toggled.');
    updateESCircles();
    renderOverlapControls();
};

// Full teardown of a red node's detection ring: map layers plus the cached
// polygon/range/sensor-name/result fields that drive overlap, serialization,
// the inspector, and reports.
function clearRedRing(node) {
    removeLayerRef(node, 'esCircle', 'esLabel');
    node.esPolygonPoints = null;
    node.esRangeKm = null;
    node.esSensorName = null;
    node.esResult = null;
}

// Full teardown of a blue node's jammer footprint layers, cached polygon, and result.
function clearBlueFootprint(node) {
    removeLayerRef(node, 'footprintCircle', 'fpLabel');
    node.footprintPolygonPoints = null;
    node.fpResult = null;
}

window.toggleNodeES = function(id) {
    const node = findNode('red', id);
    if (!node) return;
    node.esActive = !node.esActive;
    if (!node.esActive) {
        clearRedRing(node);
        clearOverlapLayer();
    }
    map.closePopup();
    bindRedPopup(id);
    markDirty('Detection ring toggled.');
    updateESCircles();
    renderOverlapControls();
};

function compatibleRedTransmitters(sensorEq) {
    return redNodes.filter(node => {
        const eq = nodeEquipment(node, 'red');
        if (eq.equipment_type === 'receiver') return false;
        return frequenciesCompatible(eq.frequency_mhz, sensorEq.frequency_mhz);
    });
}

async function updateBlueSensorCoverages() {
    blueNodes.forEach(node => {
        if (!node.sensorActive || !isReceiverCapableNode(node, 'blue')) {
            clearSensorCoverage(node);
            if (node.sensorActive && !isReceiverCapableNode(node, 'blue')) node.sensorActive = false;
        }
    });

    const activeSensors = blueNodes.filter(node => node.sensorActive && isReceiverCapableNode(node, 'blue'));
    if (activeSensors.length === 0) {
        renderOverlapControls();
        updateDistanceWarning();
        return;
    }

    activeSensors.forEach(node => {
        if (_esAbortControllers[node.id]) _esAbortControllers[node.id].abort();
        _esAbortControllers[node.id] = new AbortController();
        clearSensorCoverage(node);
    });

    for (const sensor of activeSensors) {
        const sensorEq = nodeEquipment(sensor, 'blue');
        const transmitters = compatibleRedTransmitters(sensorEq);
        for (const txNode of transmitters) {
            const ll = txNode.marker.getLatLng();
            const payload = buildSensorCoveragePayload(sensor, txNode);

            try {
                const r = await calcFetch('/calculate_es_terrain', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: _esAbortControllers[sensor.id].signal
                });
                const data = await r.json();
                if (data.status !== 'success') continue;

                const coverage = {
                    redId: txNode.id,
                    rangeKm: data.base_range_km,
                    polygonPoints: data.polygon_points || null,
                    layer: null,
                    label: null,
                    result: SpecterResults.buildFootprintResult({
                        kind: 'sensor-coverage',
                        id: `cov:${sensor.id}:${txNode.id}`,
                        subject: { node: nodeRef('red', txNode.id), sensor: nodeRef('blue', sensor.id) },
                        request: payload,
                        response: data,
                    })
                };
                const label = `${sensor.name} detects ${txNode.name}: ~${data.base_range_km.toFixed(1)} km`;

                if (data.polygon_points) {
                    coverage.layer = L.polygon(data.polygon_points, {
                        ...RING_COLORS.es, weight: 1
                    }).addTo(map);
                    coverage.label = makeEdgeLabel(data.polygon_points, null, null, null, label);
                } else {
                    coverage.polygonPoints = circleToPolygon(ll.lat, ll.lng, data.base_range_km);
                    const radiusMeters = data.base_range_km * 1000;
                    coverage.layer = L.circle(ll, {
                        ...RING_COLORS.es, radius: radiusMeters
                    }).addTo(map);
                    coverage.label = makeEdgeLabel(null, ll.lat, ll.lng, radiusMeters, label);
                }
                bindInspectOnClick(coverage.layer,
                    { kind: 'sensor-coverage', sensorId: sensor.id, redId: txNode.id });

                sensor.sensorCoverages.push(coverage);
            } catch (e) {
                if (e.name !== 'AbortError') { /* network error - leave coverage empty */ }
            }
        }
    }

    renderOverlapControls();
    updateDistanceWarning();
}

function buildSensorCoveragePayload(sensor, txNode) {
    const sensorEq = nodeEquipment(sensor, 'blue');
    const txEq = nodeEquipment(txNode, 'red');
    const ll = txNode.marker.getLatLng();
    return {
        enemy_terrain:       document.getElementById('enemy_terrain').value,
        freq_mhz:            txEq.frequency_mhz,
        enemy_tx_w:          txEq.tx_power_w,
        enemy_tx_gain:       txEq.antenna_gain_dbi,
        rx_sensitivity:      sensorEq.rx_sensitivity_dbm,
        friendly_rx_gain:    sensorEq.rx_gain_dbi,
        enemy_lat:           ll.lat,
        enemy_lon:           ll.lng,
        tx_antenna_type:     txEq.antenna_type || txNode.antennaType,
        tx_azimuth_deg:      txNode.antennaAzimuth,
        tx_beamwidth_deg:    txEq.beamwidth_deg || txNode.antennaBeamwidth,
        tx_antenna_height_m: txEq.antenna_height_m || txNode.antennaHeightAgl,
    };
}

// ES ring request for a red node's own equipment against the reference sensor.
function buildRedRingPayload(node, sensor = selectedSensorReference()) {
    const ll = node.marker.getLatLng();
    const eq = nodeEquipment(node, 'red');
    return {
        enemy_terrain:       document.getElementById('enemy_terrain').value,
        freq_mhz:            eq.frequency_mhz,
        enemy_tx_w:          eq.tx_power_w,
        enemy_tx_gain:       eq.antenna_gain_dbi,
        rx_sensitivity:      sensor.rxSensitivityDbm,
        friendly_rx_gain:    sensor.rxGainDbi,
        enemy_lat:           ll.lat,
        enemy_lon:           ll.lng,
        tx_antenna_type:     eq.antenna_type || node.antennaType,
        tx_azimuth_deg:      node.antennaAzimuth,
        tx_beamwidth_deg:    eq.beamwidth_deg || node.antennaBeamwidth,
        tx_antenna_height_m: eq.antenna_height_m || node.antennaHeightAgl,
    };
}

function selectedSensorReference() {
    const selected = selectedSensorNodeId ? findNode('blue', selectedSensorNodeId) : null;
    if (selected && isReceiverCapableNode(selected, 'blue')) {
        const eq = nodeEquipment(selected, 'blue');
        return {
            id: selected.id,
            name: selected.name,
            rxSensitivityDbm: eq.rx_sensitivity_dbm,
            rxGainDbi: eq.rx_gain_dbi
        };
    }
    return {
        name: 'Generic Friendly Sensor',
        rxSensitivityDbm: DEFAULT_GENERIC_FRIENDLY_SENSOR_SENSITIVITY_DBM,
        rxGainDbi: Number(document.getElementById('friendly_rx_gain')?.value || 0)
    };
}

async function updateRedDetectionRings() {
    redNodes.forEach(node => {
        if (!node.esActive) clearRedRing(node);
    });

    const activeNodes = redNodes.filter(node => node.esActive);
    if (activeNodes.length === 0) return;

    activeNodes.forEach(node => {
        if (_esAbortControllers[node.id]) _esAbortControllers[node.id].abort();
        _esAbortControllers[node.id] = new AbortController();
    });

    const sensor = selectedSensorReference();

    for (const node of activeNodes) {
        const ll = node.marker.getLatLng();
        const payload = buildRedRingPayload(node, sensor);

        try {
            const r = await calcFetch('/calculate_es_terrain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: _esAbortControllers[node.id].signal
            });
            const data = await r.json();
            if (data.status !== 'success') continue;

            node.esRangeKm = data.base_range_km;
            node.esSensorName = sensor.name;
            node.esResult = SpecterResults.buildFootprintResult({
                kind: 'es-ring',
                id: `es:${node.id}`,
                subject: {
                    node: nodeRef('red', node.id),
                    sensor: sensor.id ? nodeRef('blue', sensor.id) : { name: sensor.name },
                },
                request: payload,
                response: data,
            });
            removeLayerRef(node, 'esCircle', 'esLabel');

            const label = `${sensor.name} detects ${node.name}: ~${data.base_range_km.toFixed(1)} km`;
            if (data.polygon_points) {
                node.esPolygonPoints = data.polygon_points;
                node.esCircle = L.polygon(data.polygon_points, {
                    ...RING_COLORS.es, weight: 1
                }).addTo(map);
                node.esLabel = makeEdgeLabel(data.polygon_points, null, null, null, label);
            } else {
                node.esPolygonPoints = circleToPolygon(ll.lat, ll.lng, data.base_range_km);
                const radiusMeters = data.base_range_km * 1000;
                node.esCircle = L.circle(ll, {
                    ...RING_COLORS.es, radius: radiusMeters
                }).addTo(map);
                node.esLabel = makeEdgeLabel(null, ll.lat, ll.lng, radiusMeters, label);
            }
            bindInspectOnClick(node.esCircle, { kind: 'es-ring', nodeId: node.id });
        } catch (e) {
            if (e.name !== 'AbortError') { /* network error - leave existing ring in place */ }
        }
    }
}

async function updateESCircles() {
    await updateRedDetectionRings();
    await updateBlueSensorCoverages();
    renderOverlapControls();
    updateDistanceWarning();
    refreshInspector();
}

window.toggleNodeFootprint = function(id) {
    const node = findNode('blue', id);
    if (!node) return;
    node.footprintActive = !node.footprintActive;
    if (!node.footprintActive) clearBlueFootprint(node);
    map.closePopup();
    bindBluePopup(id);
    markDirty('Jammer footprint toggled.');
    if (node.footprintActive) scheduleFootprintUpdate();
};

function scheduleFootprintUpdate() {
    clearTimeout(_fpDebounceTimer);
    _fpDebounceTimer = setTimeout(updateJammerFootprints, 300);
}

function buildFootprintPayload(node) {
    const ll = node.marker.getLatLng();
    const eq = nodeEquipment(node, 'blue');
    return {
        jammer_terrain:          document.getElementById('jammer_terrain').value,
        freq_mhz:                eq.frequency_mhz,
        jammer_tx_w:             eq.tx_power_w,
        jammer_tx_gain:          eq.antenna_gain_dbi,
        rx_sensitivity:          document.getElementById('footprint_rx_sensitivity').value,
        friendly_rx_gain:        0,
        jammer_lat:              ll.lat,
        jammer_lon:              ll.lng,
        jammer_antenna_type:     eq.antenna_type || node.antennaType,
        jammer_azimuth_deg:      node.antennaAzimuth,
        jammer_beamwidth_deg:    eq.beamwidth_deg || node.antennaBeamwidth,
        jammer_antenna_height_m: eq.antenna_height_m || node.antennaHeightAgl,
    };
}

async function updateJammerFootprints() {
    blueNodes.forEach(n => {
        if (n.footprintActive && !isJammerNode(n, 'blue')) n.footprintActive = false;
        if (!n.footprintActive) clearBlueFootprint(n);
    });

    const activeNodes = blueNodes.filter(n => n.footprintActive && isJammerNode(n, 'blue'));
    if (activeNodes.length === 0) { refreshInspector(); return; }

    activeNodes.forEach(node => {
        if (_fpAbortControllers[node.id]) _fpAbortControllers[node.id].abort();
        _fpAbortControllers[node.id] = new AbortController();
    });

    for (const node of activeNodes) {
        const ll = node.marker.getLatLng();
        const payload = buildFootprintPayload(node);

        try {
            const r = await calcFetch('/calculate_jammer_footprint', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: _fpAbortControllers[node.id].signal
            });
            const data = await r.json();
            if (data.status !== 'success') continue;

            removeLayerRef(node, 'footprintCircle', 'fpLabel');
            node.fpResult = SpecterResults.buildFootprintResult({
                kind: 'jammer-footprint',
                id: `fp:${node.id}`,
                subject: { node: nodeRef('blue', node.id) },
                request: payload,
                response: data,
            });

            if (data.polygon_points) {
                node.footprintPolygonPoints = data.polygon_points;
                const label = `Jammer Coverage: ~${data.base_range_km.toFixed(1)} km (terrain)`;
                node.footprintCircle = L.polygon(data.polygon_points, {
                    ...RING_COLORS.jammer, weight: 1
                }).addTo(map);
                node.fpLabel = makeEdgeLabel(data.polygon_points, null, null, null, label);
            } else {
                node.footprintPolygonPoints = circleToPolygon(ll.lat, ll.lng, data.base_range_km);
                const radiusMeters = data.base_range_km * 1000;
                const label = `Jammer Coverage: ${data.base_range_km.toFixed(2)} km`;
                node.footprintCircle = L.circle(ll, {
                    ...RING_COLORS.jammer, radius: radiusMeters
                }).addTo(map);
                node.fpLabel = makeEdgeLabel(null, ll.lat, ll.lng, radiusMeters, label);
            }
            bindInspectOnClick(node.footprintCircle, { kind: 'jammer-footprint', nodeId: node.id });
        } catch (e) {
            if (e.name !== 'AbortError') { /* network error — leave existing footprint in place */ }
        }
    }
    refreshInspector();
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
                const upper = parseFloat(document.getElementById('upper_threshold').value) || 6;
                const lower = parseFloat(document.getElementById('lower_threshold').value) || -6;
                color = specificResult.margin >= upper ? '#00ee00'
                      : specificResult.margin > lower ? '#ff9900'
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
        refreshInspector();
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

                let margin = '--', effect = 'Pending...', rowClass = '', losBadge = '', enemyLosBadge = '', terrainWarningBadge = '';
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
                                ? '<span class="los-badge los-badge--los">J:LOS</span>'
                                : `<span class="los-badge los-badge--nlos">J:NLOS +${result.jammer_los.diffraction_loss_db}dB</span>`;
                        }
                        if (result.enemy_los != null) {
                            enemyLosBadge = result.enemy_los.is_los
                                ? '<span class="los-badge los-badge--los">E:LOS</span>'
                                : `<span class="los-badge los-badge--nlos">E:NLOS +${result.enemy_los.diffraction_loss_db}dB</span>`;
                        }
                        if (Array.isArray(result.terrain_warnings) && result.terrain_warnings.length > 0) {
                            terrainWarningBadge = '<span class="los-badge los-badge--nlos" title="' + escapeHtml(result.terrain_warnings.join(' ')) + '">Terrain fallback</span>';
                        }
                    }
                }

                const inspectBtn = result?.record
                    ? `<button class="inspect-btn" title="Explain this result" aria-label="Explain J/S result" ${inspectDataAttr({ kind: 'ea-link', jammingLinkId: jLink.id, enemyLinkId: eLink.id })}>ⓘ</button>`
                    : '';
                html += `<tr class="jammer-sub-row ${rowClass}${jammerSel ? ' row-selected' : ''}"
                    onclick="selectLink('jammer', '${jLink.id}', '${eLink.id}')">
                    <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeJammingLinkById('${jLink.id}')">✕</button></td>
                    <td>↳ ${getNodeDisplayName('blue', jLink.blueId)}</td>
                    <td>${margin}</td>
                    <td>${effect} ${losBadge}${enemyLosBadge}${terrainWarningBadge}${inspectBtn}</td>
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
                <td>${getNodeDisplayName('blue', jLink.blueId)}</td>
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
    refreshInspector();
}
