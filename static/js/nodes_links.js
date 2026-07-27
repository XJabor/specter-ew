// Specter-EW — red/blue/black node placement, popups, antenna setters,
// MGRS jump, link creation/removal, and link-all-by-frequency.
// Declarations only: wiring lives in app_init.js.

// ============================================================
// NODE CONSTRUCTORS
// ============================================================
// One constructor per node type, shared by interactive placement and
// scenario reconstruction. Owns marker creation, event handlers, equipment
// application, array registration, popup binding, and elevation fetch.
// Placement-only side effects (dirty marking, selection) stay in placeXNode;
// scenario field mapping stays in makeXNodeFromScenario.

function createRedNode(latlng, opts) {
    const marker = L.marker(latlng, { icon: redIcon, draggable: true }).addTo(map);
    const node = { id: opts.id, name: opts.name || opts.id, marker,
                   esActive: !!opts.esActive, esCircle: null, esLabel: null,
                   esPolygonPoints: null, esRangeKm: null, esSensorName: null, elevationM: null,
                   antennaType: 'omni', antennaAzimuth: 0, antennaBeamwidth: 90, antennaHeightAgl: 1.0,
                   systems: [] };
    applyEquipmentToNode(node, opts.equipment, 'red');
    node.antennaAzimuth = Number(opts.antennaAzimuth || 0);
    node.systems = (opts.systems || []).map((sys, idx) => redSystemFromScenario(sys, idx, node.id));
    marker.on('click', function() { handleNodeClick('red', node.id); });
    marker.on('dragend', function() {
        // Every system polygon is position-derived, so a move invalidates them all.
        clearRedSystemRings(node);
        updateRedSystemsWorkbench();
        fetchAndStoreElevation(node); markDirty('Node moved.'); recalculateAll();
    });
    marker.on('popupclose', function() { bindRedPopup(node.id); });
    redNodes.push(node);
    bindRedPopup(node.id);
    fetchAndStoreElevation(node);
    return node;
}

function createBlueNode(latlng, opts) {
    const marker = L.marker(latlng, { icon: blueIcon, draggable: true }).addTo(map);
    // sensorActive/footprintActive must be set before applyEquipmentToNode,
    // which clears them when the equipment is not receiver/jammer capable.
    const node = { id: opts.id, name: opts.name || opts.id, marker, elevationM: null,
                   antennaType: 'omni', antennaAzimuth: 0, antennaBeamwidth: 90, antennaHeightAgl: 1.0,
                   sensorActive: !!opts.sensorActive, sensorCoverages: [],
                   footprintActive: !!opts.footprintActive, footprintCircle: null,
                   fpLabel: null, footprintPolygonPoints: null };
    applyEquipmentToNode(node, opts.equipment, 'blue');
    node.antennaAzimuth = Number(opts.antennaAzimuth || 0);
    marker.on('click', function() { handleNodeClick('blue', node.id); });
    marker.on('dragend', function() { fetchAndStoreElevation(node); markDirty('Node moved.'); recalculateAll(); scheduleFootprintUpdate(); });
    marker.on('popupclose', function() { bindBluePopup(node.id); });
    blueNodes.push(node);
    bindBluePopup(node.id);
    fetchAndStoreElevation(node);
    return node;
}

function createBlackNode(latlng, opts) {
    const marker = L.marker(latlng, { icon: blackIcon, draggable: true }).addTo(map);
    const node = { id: opts.id, name: opts.name || opts.id, marker };
    marker.on('dragend', function() { markDirty('Marker moved.'); updateMGRSTooltips(); });
    marker.on('popupclose', function() { bindBlackPopup(node.id); });
    blackNodes.push(node);
    bindBlackPopup(node.id);
    return node;
}

// Node-attached equipment from a scenario item, with the legacy top-level
// antenna fields taking precedence over the embedded equipment config.
function scenarioEquipment(item) {
    return {
        ...(item.equipment || {}),
        antenna_type: item.antenna_type || item.equipment?.antenna_type,
        beamwidth_deg: item.antenna_beamwidth || item.equipment?.beamwidth_deg,
        antenna_height_m: item.antenna_height_agl || item.equipment?.antenna_height_m
    };
}

function scenarioLatLng(item) {
    return [Number(item.location.lat), Number(item.location.lon)];
}

function makeRedNodeFromScenario(item) {
    createRedNode(scenarioLatLng(item), {
        id: item.id, name: item.name,
        equipment: scenarioEquipment(item),
        antennaAzimuth: item.antenna_azimuth,
        esActive: item.es_active,
        systems: item.systems
    });
}

function makeBlueNodeFromScenario(item) {
    createBlueNode(scenarioLatLng(item), {
        id: item.id, name: item.name,
        equipment: scenarioEquipment(item),
        antennaAzimuth: item.antenna_azimuth,
        sensorActive: item.sensor_active,
        footprintActive: item.footprint_active
    });
}

function makeBlackNodeFromScenario(item) {
    createBlackNode(scenarioLatLng(item), { id: item.id, name: item.name });
}

// ============================================================
// NODE PLACEMENT
// ============================================================

function libraryNodeName(template, fallbackId) {
    const base = String(template?.name || fallbackId).slice(0, 20);
    const existing = new Set([...redNodes, ...blueNodes].map(n => n.name));
    if (!existing.has(base)) return base;
    for (let i = 2; i < 100; i++) {
        const candidate = `${base.slice(0, 17)} ${i}`.slice(0, 20);
        if (!existing.has(candidate)) return candidate;
    }
    return fallbackId;
}

function placeRedNode(latlng, template = null) {
    redCounter++;
    const id = 'R' + redCounter;
    createRedNode(latlng, {
        id,
        name: template ? libraryNodeName(template, id) : id,
        equipment: template ? equipmentFromTemplate(template) : equipmentFromSidebar('red')
    });
    updateMGRSTooltips();
    updateLinkAllBtn();
    updateRedSystemsWorkbench();
    selectEquipmentNode('red', id);
    markDirty('Enemy node added.');
}

function placeBlueNode(latlng, template = null) {
    blueCounter++;
    const id = 'B' + blueCounter;
    createBlueNode(latlng, {
        id,
        name: template ? libraryNodeName(template, id) : id,
        equipment: template ? equipmentFromTemplate(template) : equipmentFromSidebar('blue')
    });
    updateMGRSTooltips();
    selectEquipmentNode('blue', id);
    markDirty('Friendly node added.');
}

function placeBlackNode(latlng) {
    blackCounter++;
    const id = 'M' + blackCounter;
    createBlackNode(latlng, { id });
    updateMGRSTooltips();
    markDirty('Marker added.');
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
          <input type="number" min="1" max="500" step="0.5" value="${node.antennaHeightAgl}"
            oninput="setNodeAntennaHeight('${team}','${id}',this.value)"
            onchange="recalculateAll()">
        </label>
        <div class="popup-note">Affects LOS/diffraction and path loss model</div>`;
}

// Shared trailer: every node popup ends with the MGRS jump section and
// (except black markers) the antenna configuration section.
function bindNodePopup(node, team, bodyHtml, { antenna = true } = {}) {
    node.marker.bindPopup(
        bodyHtml
        + mgrsInputSection(team, node.id, node)
        + (antenna ? antennaPopupSection(team, node.id, node) : ''),
        { minWidth: 180 }
    );
}

// Re-binds the popup for any node type; replaces per-call-site type chains.
function rebindNodePopup(type, id) {
    const binder = { red: bindRedPopup, blue: bindBluePopup, black: bindBlackPopup, ep: bindEpPopup }[type];
    if (binder) binder(id);
}

function bindRedPopup(id) {
    const node = findNode('red', id);
    if (!node) return;
    const esLabel = node.esActive ? '🚫 Hide Detection Ring' : '📡 Show Detection Ring';
    bindNodePopup(node, 'red',
        `<b>Enemy Node ${node.name}</b><br>
        <button onclick="startEnemyLink('${id}')">🔗 Link Enemy Comms</button><br>
        <button onclick="toggleNodeES('${id}')">${esLabel}</button><br>
        <button onclick="renameNode('red','${id}')">✏️ Rename Node</button><br>
        <button onclick="removeNode('red','${id}')">🗑️ Remove Node</button>`);
}

function bindBluePopup(id) {
    const node = findNode('blue', id);
    if (!node) return;
    const fpLabel = node.footprintActive ? '🚫 Hide Jammer Footprint' : '📡 Show Jammer Footprint';
    const jammerButton = isJammerNode(node, 'blue')
        ? `<button onclick="startJammingLink('${id}')">⚡ Link to Target</button><br>
        <button onclick="toggleNodeFootprint('${id}')">${fpLabel}</button><br>`
        : '';
    const sensorButton = isReceiverCapableNode(node, 'blue')
        ? `<button onclick="toggleNodeSensorCoverage('${id}')">${node.sensorActive ? '🚫 Hide Sensor Coverage' : '📡 Show Sensor Coverage'}</button><br>`
        : '';
    bindNodePopup(node, 'blue',
        `<b>Friendly Node ${node.name}</b><br>
        ${sensorButton}
        ${jammerButton}
        <button onclick="renameNode('blue','${id}')">✏️ Rename Node</button><br>
        <button onclick="removeNode('blue','${id}')">🗑️ Remove Node</button>`);
}

function bindBlackPopup(id) {
    const node = findNode('black', id);
    if (!node) return;
    bindNodePopup(node, 'black',
        `<b>Marker ${node.name}</b><br>
        <button onclick="renameNode('black','${id}')">✏️ Rename</button><br>
        <button onclick="removeNode('black','${id}')">🗑️ Remove</button>`,
        { antenna: false });
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
    rebindNodePopup(type, id);
    node.marker.openPopup();
    updateMGRSTooltips();
    renderResults();
    if (type === 'red') updateRedSystemsWorkbench();
    markDirty('Node renamed.');
}

// ============================================================
// ANTENNA CONFIGURATION
// ============================================================

window.setNodeAntennaType = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaType = value;
    nodeEquipment(node, team).antenna_type = value;
    // Rebind popup so the directional sub-section shows/hides correctly
    rebindNodePopup(team, id);
    node.marker.openPopup();
    markDirty('Antenna settings changed.');
    recalculateAll();
};

window.setNodeAntennaAzimuth = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaAzimuth = ((parseFloat(value) || 0) % 360 + 360) % 360;
    markDirty('Antenna settings changed.');
    // recalculateAll is triggered by onchange on the input (fires on blur/enter)
};

window.setNodeAntennaBeamwidth = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaBeamwidth = Math.max(1, Math.min(360, parseFloat(value) || 90));
    nodeEquipment(node, team).beamwidth_deg = node.antennaBeamwidth;
    markDirty('Antenna settings changed.');
    // recalculateAll is triggered by onchange on the input (fires on blur/enter)
};

window.setNodeAntennaHeight = function(team, id, value) {
    const node = findNode(team, id);
    if (!node) return;
    node.antennaHeightAgl = Math.max(1.0, parseFloat(value) || 1.0);
    nodeEquipment(node, team).antenna_height_m = node.antennaHeightAgl;
    markDirty('Antenna settings changed.');
    // recalculateAll is triggered by onchange on the input (fires on blur/enter)
};

function getNodeDisplayName(type, id) {
    const node = findNode(type, id);
    return node ? node.name : id;
}

window.moveNodeToMGRS = function(type, id, value) {
    if (!value || !value.trim()) return;
    try {
        const [lng, lat] = mgrs.toPoint(value.trim().toUpperCase());
        const node = findNode(type, id);
        if (!node) return;
        node.marker.setLatLng([lat, lng]);
        map.panTo([lat, lng]);
        updateMGRSTooltips();
        if (type === 'red') {
            clearRedSystemRings(node);
            updateRedSystemsWorkbench();
            fetchAndStoreElevation(node);
            markDirty('Node moved.');
            recalculateAll();
        } else if (type === 'blue') {
            fetchAndStoreElevation(node);
            markDirty('Node moved.');
            recalculateAll();
            scheduleFootprintUpdate();
        } else if (type === 'ep') {
            node.lat = lat;
            node.lon = lng;
            clearEpNodeRings(node);
            markDirty('EP node moved.');
            updateEpWorkbench();
        } else {
            markDirty('Marker moved.');
        }
        node.marker.closePopup();
        rebindNodePopup(type, id);
    } catch (e) {
        alert('Invalid MGRS grid string. Example: 18SUJ2345678901');
    }
};

function mgrsInputSection(type, id, node) {
    const currentMGRS = mgrs.forward([node.marker.getLatLng().lng, node.marker.getLatLng().lat]);
    return `<hr class="popup-divider">
        <label class="popup-label">MGRS:
          <div class="popup-mgrs-row">
            <input type="text" id="mgrs-in-${id}" class="popup-mgrs-input" value="${currentMGRS}"
              onclick="this.select()"
              onkeydown="if(event.key==='Enter') moveNodeToMGRS('${type}','${id}',this.value)">
            <button class="popup-mgrs-go"
              onclick="moveNodeToMGRS('${type}','${id}',document.getElementById('mgrs-in-${id}').value)">Go</button>
          </div>
        </label>`;
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
    const node = findNode('blue', blueId);
    if (!node || !isJammerNode(node, 'blue')) return;
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
    } else if (color === 'red' || color === 'blue') {
        selectEquipmentNode(color, id);
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
    markDirty('Enemy link added.');
    recalculateAll();
}

function createJammingLink(blueId, rxId) {
    const linkId = blueId + '-' + rxId;
    if (jammingLinks.find(l => l.id === linkId)) return;

    const blue = findNode('blue', blueId);
    const rx   = findNode('red',  rxId);
    if (!blue || !rx || !isJammerNode(blue, 'blue')) return;
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
    markDirty('Jamming link added.');
    recalculateAll();
}

// ============================================================
// REMOVAL
// ============================================================

window.removeNode = function(color, id) {
    map.closePopup();
    if (selectedEquipmentNode?.type === color && selectedEquipmentNode?.id === id) selectedEquipmentNode = null;
    if (color === 'red') {
        const node = findNode('red', id);
        if (node) {
            map.removeLayer(node.marker);
            clearRedRing(node);
            clearRedSystemRings(node);
        }
        clearSensorCoverageForRed(id);
        redNodes = redNodes.filter(n => n.id !== id);
        updateRedSystemsWorkbench();
        clearOverlapLayer();
        renderOverlapControls();
        enemyLinks.filter(l => l.txId === id || l.rxId === id).forEach(l => map.removeLayer(l.line));
        enemyLinks  = enemyLinks.filter(l => l.txId !== id && l.rxId !== id);
        jammingLinks.filter(l => l.rxId === id).forEach(l => map.removeLayer(l.line));
        jammingLinks = jammingLinks.filter(l => l.rxId !== id);
        markDirty('Enemy node removed.');
    } else if (color === 'blue') {
        const node = findNode('blue', id);
        if (node) {
            map.removeLayer(node.marker);
            clearSensorCoverage(node);
            clearBlueFootprint(node);
        }
        blueNodes = blueNodes.filter(n => n.id !== id);
        if (selectedSensorNodeId === id) selectedSensorNodeId = null;
        jammingLinks.filter(l => l.blueId === id).forEach(l => map.removeLayer(l.line));
        jammingLinks = jammingLinks.filter(l => l.blueId !== id);
        markDirty('Friendly node removed.');
    } else if (color === 'black') {
        const node = findNode('black', id);
        if (node) map.removeLayer(node.marker);
        blackNodes = blackNodes.filter(n => n.id !== id);
        markDirty('Marker removed.');
        return;
    }
    if (!selectedEquipmentNode) {
        const status = document.getElementById('selected-node-status');
        if (status) status.textContent = 'No node selected. Editing defaults for new blank nodes.';
        updateDefaultSidebarContext();
    }
    recalculateAll();
};

function removeEnemyLink(linkId) {
    if (selectedLink?.enemyLinkId === linkId) selectedLink = null;
    const link = enemyLinks.find(l => l.id === linkId);
    if (link) map.removeLayer(link.line);
    enemyLinks = enemyLinks.filter(l => l.id !== linkId);
    markDirty('Enemy link removed.');
    recalculateAll();
}

function removeJammingLink(linkId) {
    if (selectedLink?.jammingLinkId === linkId) selectedLink = null;
    const link = jammingLinks.find(l => l.id === linkId);
    if (link) map.removeLayer(link.line);
    jammingLinks = jammingLinks.filter(l => l.id !== linkId);
    markDirty('Jamming link removed.');
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
// LINK ALL / UNLINK ALL
// ============================================================

const ENEMY_LINK_FREQ_TOLERANCE_MHZ = 0.001;

function nodeCanTransmitComms(node) {
    return nodeEquipment(node, 'red').equipment_type === 'radio';
}

function enemyCommsFrequenciesMatch(a, b) {
    const aFreq = Number(nodeEquipment(a, 'red').frequency_mhz);
    const bFreq = Number(nodeEquipment(b, 'red').frequency_mhz);
    return Number.isFinite(aFreq)
        && Number.isFinite(bFreq)
        && Math.abs(aFreq - bFreq) <= ENEMY_LINK_FREQ_TOLERANCE_MHZ;
}

function compatibleEnemyCommsPairs() {
    const pairs = [];
    redNodes.forEach(tx => {
        redNodes.forEach(rx => {
            if (tx.id === rx.id) return;
            if (!nodeCanTransmitComms(tx)) return;
            if (!enemyCommsFrequenciesMatch(tx, rx)) return;
            pairs.push({ tx, rx });
        });
    });
    return pairs;
}

function allCommsLinked() {
    const pairs = compatibleEnemyCommsPairs();
    return pairs.length > 0 && pairs.every(({ tx, rx }) => enemyLinks.find(l => l.txId === tx.id && l.rxId === rx.id));
}

function updateLinkAllBtn() {
    const btn = document.getElementById('btn-link-all-enemy');
    const canLink = compatibleEnemyCommsPairs().length > 0;
    btn.disabled = !canLink;
    if (canLink && allCommsLinked()) {
        btn.textContent = 'Unlink Enemy Comms';
        btn.classList.add('unlink-btn');
    } else {
        btn.textContent = 'Link Enemy Comms by Frequency';
        btn.classList.remove('unlink-btn');
    }
}

function linkAllEnemyComms() {
    const pairs = compatibleEnemyCommsPairs();
    let created = 0;
    pairs.forEach(({ tx, rx }) => {
        if (enemyLinks.find(l => l.txId === tx.id && l.rxId === rx.id)) return;
        createEnemyLink(tx.id, rx.id);
        created++;
    });
    const candidateCount = redNodes.reduce((total, tx) => {
        if (!nodeCanTransmitComms(tx)) return total;
        return total + redNodes.filter(rx => rx.id !== tx.id).length;
    }, 0);
    const skipped = Math.max(0, candidateCount - pairs.length);
    const status = document.getElementById('link-all-status');
    if (status) status.textContent = `Linked ${created} matching pair(s). Skipped ${skipped} incompatible pair(s).`;
    updateLinkAllBtn();
}

function unlinkAllEnemyComms() {
    if (selectedLink?.type === 'enemy') selectedLink = null;
    enemyLinks.forEach(l => map.removeLayer(l.line));
    enemyLinks = [];
    const status = document.getElementById('link-all-status');
    if (status) status.textContent = '';
    markDirty('Enemy links removed.');
    recalculateAll();
}
