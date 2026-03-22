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
    marker.on('click',   function() { handleNodeClick('red', id); });
    marker.on('dragend', recalculateAll);
    redNodes.push({ id, marker, esActive: false, esCircle: null });
    bindRedPopup(id);
    updateMGRSTooltips();
    updateLinkAllBtn();
}

function placeBlueNode(latlng) {
    blueCounter++;
    const id = 'B' + blueCounter;
    const marker = L.marker(latlng, { icon: blueIcon, draggable: true }).addTo(map);
    marker.on('click',   function() { handleNodeClick('blue', id); });
    marker.on('dragend', recalculateAll);
    blueNodes.push({ id, marker });
    bindBluePopup(id);
    updateMGRSTooltips();
}

// ============================================================
// POPUP BINDING
// ============================================================

function bindRedPopup(id) {
    const node = findNode('red', id);
    if (!node) return;
    const esLabel = node.esActive ? '🚫 Hide Detection Ring' : '📡 Show Detection Ring';
    node.marker.bindPopup(
        `<b>Enemy Node ${id}</b><br>
        <button onclick="startEnemyLink('${id}')">🔗 Link Enemy Comms</button><br>
        <button onclick="toggleNodeES('${id}')">${esLabel}</button><br>
        <button onclick="removeNode('red','${id}')">🗑️ Remove Node</button>`
    );
}

function bindBluePopup(id) {
    const node = findNode('blue', id);
    if (!node) return;
    node.marker.bindPopup(
        `<b>Friendly Node ${id}</b><br>
        <button onclick="startJammingLink('${id}')">⚡ Link to Target</button><br>
        <button onclick="removeNode('blue','${id}')">🗑️ Remove Node</button>`
    );
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
        jammer_tx_w:     document.getElementById('jammer_tx_w').value,
        jammer_tx_gain:  document.getElementById('jammer_tx_gain').value,
        jammer_bw_khz:   document.getElementById('jammer_bw_khz').value,
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
    return best >= 6 ? '#00ee00' : best > -6 ? '#ff9900' : '#ff3333';
}

function recalculateAll() {
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
    updateESCircles();
    updateLinkAllBtn();

    if (jammingLinks.length === 0) {
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

    let pending = tasks.length;
    const done = () => { if (--pending === 0) renderResults(); };

    tasks.forEach(({ jLink, eLink, i, jammerDistKm, enemyDistKm }) => {
        fetch('/calculate_ea', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...params, enemy_dist_km: enemyDistKm, jammer_dist_km: jammerDistKm })
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
        node.marker.bindTooltip(`${node.id} — ${mgrsStr}`, {
            permanent: true, direction: 'top', className: 'mgrs-label'
        });
    });
}

// ============================================================
// ES CIRCLES (DETECTION RINGS)
// ============================================================

window.toggleNodeES = function(id) {
    const node = findNode('red', id);
    if (!node) return;
    node.esActive = !node.esActive;
    map.closePopup();
    bindRedPopup(id);
    updateESCircles();
};

function updateESCircles() {
    const activeESNodes = redNodes.filter(n => n.esActive);

    if (activeESNodes.length === 0) {
        redNodes.forEach(n => {
            if (n.esCircle) { map.removeLayer(n.esCircle); n.esCircle = null; }
        });
        return;
    }

    const esPayload = {
        freq_mhz:         document.getElementById('freq_mhz').value,
        jammer_terrain:   document.getElementById('jammer_terrain').value,
        enemy_tx_w:       document.getElementById('enemy_tx_w').value,
        enemy_tx_gain:    document.getElementById('enemy_tx_gain').value,
        rx_sensitivity:   document.getElementById('rx_sensitivity').value,
        friendly_rx_gain: document.getElementById('friendly_rx_gain').value
    };

    fetch('/calculate_es', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(esPayload)
    })
    .then(r => r.json())
    .then(data => {
        if (data.status !== 'success') return;
        const radiusMeters = data.radius_km * 1000;
        const label = `Detection: ${data.radius_km.toFixed(2)} km`;
        redNodes.forEach(node => {
            if (node.esActive) {
                if (node.esCircle) map.removeLayer(node.esCircle);
                node.esCircle = L.circle(node.marker.getLatLng(), {
                    color: 'red', fillColor: '#f03', fillOpacity: 0.1, radius: radiusMeters
                }).bindTooltip(label, {
                    permanent: true, direction: 'right', className: 'dist-label'
                }).addTo(map);
            } else {
                if (node.esCircle) { map.removeLayer(node.esCircle); node.esCircle = null; }
            }
        });
    });
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
                <td>${eLink.txId}→${eLink.rxId}</td>
                <td>—</td>
                <td class="uncontested">Uncontested</td>
            </tr>`;
        } else {
            html += `<tr class="${enemyRowClass}" onclick="selectLink('enemy', null, '${eLink.id}')">
                <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeEnemyLinkById('${eLink.id}')">✕</button></td>
                <td>${eLink.txId}→${eLink.rxId}</td>
                <td></td><td></td>
            </tr>`;

            assocJLinks.forEach(jLink => {
                shownJammingIds.add(jLink.id);
                const results  = jLink.results || [null];
                const result   = results.find(r => r?.enemyLinkId === eLink.id) ?? results[0];
                const jammerSel = selectedLink?.type === 'jammer'
                    && selectedLink.jammingLinkId === jLink.id
                    && selectedLink.enemyLinkId === eLink.id;

                let margin = '--', effect = 'Pending...', rowClass = '';
                if (result) {
                    if      (result.status === 'no-enemy-link') { effect = 'No enemy link'; rowClass = 'result-unknown'; }
                    else if (result.status === 'error')         { effect = 'Error';          rowClass = 'result-unknown'; }
                    else if (result.status === 'success') {
                        margin = result.margin + ' dB';
                        effect = result.effect;
                        rowClass = result.margin >= 6 ? 'result-complete' : result.margin > -6 ? 'result-warbling' : 'result-none';
                        if (bestMargin === null || result.margin > bestMargin) bestMargin = result.margin;
                    }
                }

                html += `<tr class="jammer-sub-row ${rowClass}${jammerSel ? ' row-selected' : ''}"
                    onclick="selectLink('jammer', '${jLink.id}', '${eLink.id}')">
                    <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeJammingLinkById('${jLink.id}')">✕</button></td>
                    <td>↳ ${jLink.blueId}</td>
                    <td>${margin}</td>
                    <td>${effect}</td>
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
                <td>${jLink.id}</td>
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
