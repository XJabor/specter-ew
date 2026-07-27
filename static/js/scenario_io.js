// Specter-EW — scenario persistence: dirty tracking, autosave,
// serialize/load, .specter.json download, and KML export.
// Declarations only (plus the window.SpecterScenario export):
// initScenarioControls() is called from app_init.js.

// ============================================================
// SCENARIO SAVE / LOAD
// ============================================================

const SCENARIO_SETTING_IDS = [
    'freq_mhz',
    'fh_toggle',
    'enemy_bw_khz',
    'jammer_bw_khz',
    'enemy_terrain',
    'jammer_terrain',
    'enemy_tx_w',
    'enemy_tx_gain',
    'enemy_rx_gain',
    'jammer_tx_w',
    'jammer_tx_gain',
    'footprint_rx_sensitivity',
    'rx_sensitivity',
    'friendly_rx_gain',
    'lower_threshold',
    'upper_threshold',
    'ep_terrain',
    'ep_rx_sensitivity'
];

let scenarioDirty = false;
let scenarioLoading = false;
let scenarioCreatedAt = new Date().toISOString();
let scenarioUpdatedAt = scenarioCreatedAt;
let scenarioAutosaveTimer = null;
let scenarioRestorePrompted = false;

function getScenarioName() {
    const input = document.getElementById('scenario-name');
    return input ? input.value.trim() : '';
}

function setScenarioName(name) {
    const input = document.getElementById('scenario-name');
    if (input) input.value = name || '';
}

function scenarioStatus(message, isError = false) {
    const el = document.getElementById('scenario-status');
    if (!el) return;
    el.style.color = isError ? '#ff7777' : '#aaa';
    el.textContent = message || '';
}

function updateScenarioDirtyUi() {
    const el = document.getElementById('scenario-dirty-indicator');
    if (!el) return;
    el.textContent = scenarioDirty ? 'Unsaved' : 'Saved';
    el.classList.toggle('dirty', scenarioDirty);
}

function currentScenarioAutosaveKey() {
    const clerkUserId = window.Clerk?.user?.id;
    return clerkUserId
        ? `specter-ew:scenario-autosave:${clerkUserId}`
        : 'specter-ew:scenario-autosave';
}

function currentScenarioCleanKey() {
    const clerkUserId = window.Clerk?.user?.id;
    return clerkUserId
        ? `specter-ew:scenario-clean:${clerkUserId}`
        : 'specter-ew:scenario-clean';
}

function getLastCleanTime() {
    try {
        return localStorage.getItem(currentScenarioCleanKey()) || '';
    } catch (e) {
        return '';
    }
}

function setLastCleanTime(value) {
    try {
        localStorage.setItem(currentScenarioCleanKey(), value);
    } catch (e) {
        /* localStorage may be unavailable in private contexts */
    }
}

function markDirty(message) {
    if (scenarioLoading) return;
    scenarioDirty = true;
    scenarioUpdatedAt = scenarioNow();
    updateScenarioDirtyUi();
    if (message) scenarioStatus(message);
    scheduleAutosave();
}

function markClean(message) {
    scenarioDirty = false;
    scenarioUpdatedAt = scenarioNow();
    updateScenarioDirtyUi();
    setLastCleanTime(scenarioUpdatedAt);
    try {
        localStorage.removeItem(currentScenarioAutosaveKey());
    } catch (e) {
        /* ignore */
    }
    if (message) scenarioStatus(message);
}

function scheduleAutosave() {
    if (scenarioLoading) return;
    clearTimeout(scenarioAutosaveTimer);
    scenarioAutosaveTimer = setTimeout(() => {
        try {
            const scenario = serializeScenario();
            localStorage.setItem(currentScenarioAutosaveKey(), JSON.stringify({
                saved_at: scenarioNow(),
                scenario
            }));
        } catch (e) {
            console.warn('Scenario autosave failed', e);
        }
    }, 700);
}

function nodeAntennaState(node) {
    return {
        antenna_type: node.antennaType || 'omni',
        antenna_azimuth: Number(node.antennaAzimuth || 0),
        antenna_beamwidth: Number(node.antennaBeamwidth || 90),
        antenna_height_agl: Number(node.antennaHeightAgl || 1.0)
    };
}

function settingsState() {
    const settings = {};
    SCENARIO_SETTING_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        settings[id] = el.type === 'checkbox' ? el.checked : el.value;
    });
    return settings;
}

function serializeScenario() {
    const center = map.getCenter();
    const scenarioName = getScenarioName();
    const now = scenarioNow();
    return {
        schema_version: SCENARIO_SCHEMA_VERSION,
        app_version: SPECTER_APP_VERSION,
        created_at: scenarioCreatedAt || now,
        updated_at: now,
        scenario_name: scenarioName,
        map_view: {
            center: latLngToPlain(center),
            zoom: map.getZoom(),
            base_layer: activeBaseLayerName(),
            overlays: {
                local_imagery: map.hasLayer(localImageryLayer)
            }
        },
        settings: settingsState(),
        nodes: {
            red: redNodes.map(node => ({
                id: node.id,
                name: node.name,
                location: latLngToPlain(node.marker.getLatLng()),
                equipment: equipmentScenarioState(node, 'red'),
                ...nodeAntennaState(node),
                es_active: !!node.esActive,
                systems: (node.systems || []).map(redSystemScenarioState)
            })),
            blue: blueNodes.map(node => ({
                id: node.id,
                name: node.name,
                location: latLngToPlain(node.marker.getLatLng()),
                equipment: equipmentScenarioState(node, 'blue'),
                ...nodeAntennaState(node),
                footprint_active: !!node.footprintActive,
                sensor_active: !!node.sensorActive
            })),
            black: blackNodes.map(node => ({
                id: node.id,
                name: node.name,
                location: latLngToPlain(node.marker.getLatLng())
            })),
            ep: epNodes.map(node => ({
                id: node.id,
                name: node.name,
                location: latLngToPlain(node.marker.getLatLng()),
                systems: node.systems.map(sys => ({
                    id: sys.id,
                    name: sys.name,
                    freq_mhz: Number(sys.freqMhz),
                    tx_power_w: Number(sys.txPowerW),
                    tx_gain_dbi: Number(sys.txGainDbi),
                    antenna_type: sys.antennaType || 'omni',
                    antenna_azimuth: Number(sys.antennaAzimuth || 0),
                    antenna_beamwidth: Number(sys.antennaBeamwidth || 360),
                    antenna_height_agl: Number(sys.antennaHeightAgl || 1.0),
                    color: sys.color,
                    ring_active: !!(sys.layer || sys.polygonPoints)
                }))
            }))
        },
        links: {
            enemy: enemyLinks.map(link => ({ tx_id: link.txId, rx_id: link.rxId })),
            jamming: jammingLinks.map(link => ({ blue_id: link.blueId, rx_id: link.rxId }))
        },
        profile_library: scenarioProfileLibraryState(),
        overlays: {
            ep_mode_active: epModeActive,
            overlap_checked: Array.from(overlapChecked),
            overlap_visible: !!overlapLayer
        }
    };
}

function applyScenarioSettings(settings) {
    Object.entries(settings || {}).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.type === 'checkbox') el.checked = !!value;
        else el.value = value;
    });
    updateFrequencyHoppingControls();
}

function applyScenarioMapView(mapView) {
    if (!mapView || !mapView.center) return;
    const baseName = mapView.base_layer === 'Streets' ? 'Streets' : 'Satellite';
    if (baseName === 'Streets') {
        if (map.hasLayer(satelliteLayer)) map.removeLayer(satelliteLayer);
        if (!map.hasLayer(streetLayer)) map.addLayer(streetLayer);
    } else {
        if (map.hasLayer(streetLayer)) map.removeLayer(streetLayer);
        if (!map.hasLayer(satelliteLayer)) map.addLayer(satelliteLayer);
    }
    const wantsLocalImagery = !!mapView.overlays?.local_imagery;
    if (wantsLocalImagery && !map.hasLayer(localImageryLayer)) map.addLayer(localImageryLayer);
    if (!wantsLocalImagery && map.hasLayer(localImageryLayer)) map.removeLayer(localImageryLayer);
    map.setView([Number(mapView.center.lat), Number(mapView.center.lon)], Number(mapView.zoom || map.getZoom()));
}

function resetScenarioState() {
    setMode(null);
    Object.values(_esAbortControllers).forEach(controller => controller.abort());
    Object.keys(_esAbortControllers).forEach(id => delete _esAbortControllers[id]);
    Object.values(_fpAbortControllers).forEach(controller => controller.abort());
    Object.keys(_fpAbortControllers).forEach(id => delete _fpAbortControllers[id]);
    redNodes.forEach(n => {
        map.removeLayer(n.marker);
        clearRedRing(n);
        clearRedSystemRings(n);
    });
    blueNodes.forEach(n => {
        map.removeLayer(n.marker);
        clearSensorCoverage(n);
        clearBlueFootprint(n);
    });
    blackNodes.forEach(n => { map.removeLayer(n.marker); });
    enemyLinks.forEach(l => map.removeLayer(l.line));
    jammingLinks.forEach(l => map.removeLayer(l.line));
    epNodes.forEach(n => {
        n.systems.forEach(s => { if (s.layer) map.removeLayer(s.layer); if (s.label) map.removeLayer(s.label); });
        map.removeLayer(n.marker);
    });
    redNodes = []; blueNodes = []; blackNodes = []; enemyLinks = []; jammingLinks = [];
    redCounter = 0; blueCounter = 0; blackCounter = 0;
    epNodes.length = 0; epNodeCounter = 0;
    selectedLink = null;
    selectedEquipmentNode = null;
    selectedSensorNodeId = null;
    const status = document.getElementById('selected-node-status');
    if (status) status.textContent = 'No node selected. Editing defaults for new blank nodes.';
    updateDefaultSidebarContext();
    overlapChecked.clear();
    clearOverlapLayer();
    renderOverlapControls();
    renderResults();
    updateEpWorkbench();
    updateRedSystemsWorkbench();
    updateMGRSTooltips();
}

async function loadScenario(data) {
    const scenario = migrateScenario(data);
    if (scenario.profile_library?.packs) {
        mergeUserProfilePacks(scenario.profile_library.packs);
    }
    scenarioLoading = true;
    try {
        resetScenarioState();
        scenarioCreatedAt = scenario.created_at || scenarioNow();
        scenarioUpdatedAt = scenario.updated_at || scenarioCreatedAt;
        setScenarioName(scenario.scenario_name || '');
        applyScenarioSettings(scenario.settings || {});

        (scenario.nodes?.red || []).forEach(makeRedNodeFromScenario);
        (scenario.nodes?.blue || []).forEach(makeBlueNodeFromScenario);
        (scenario.nodes?.black || []).forEach(makeBlackNodeFromScenario);
        (scenario.nodes?.ep || []).forEach(makeEpNodeFromScenario);

        redCounter = setCounterFromIds(redNodes.map(n => n.id), 'R');
        blueCounter = setCounterFromIds(blueNodes.map(n => n.id), 'B');
        blackCounter = setCounterFromIds(blackNodes.map(n => n.id), 'M');
        epNodeCounter = setCounterFromIds(epNodes.map(n => n.id), 'EP');

        (scenario.links?.enemy || []).forEach(link => {
            if (findNode('red', link.tx_id) && findNode('red', link.rx_id)) createEnemyLink(link.tx_id, link.rx_id);
        });
        (scenario.links?.jamming || []).forEach(link => {
            if (findNode('blue', link.blue_id) && findNode('red', link.rx_id)) createJammingLink(link.blue_id, link.rx_id);
        });

        const wantsEpMode = !!scenario.overlays?.ep_mode_active;
        if (epModeActive !== wantsEpMode) toggleEpMode();
        (scenario.overlays?.overlap_checked || []).forEach(id => overlapChecked.add(id));
        applyScenarioMapView(scenario.map_view);
        updateMGRSTooltips();
        updateEpWorkbench();
        updateRedSystemsWorkbench();
        renderOverlapControls();
        recalculateAll();
        const epNodesToCalculate = epNodes.filter(node => node.systems.some(sys => sys.ringActive));
        for (const node of epNodesToCalculate) {
            await calculateEpNode(node.id);
        }
        const redNodesToCalculate = redNodes.filter(node => (node.systems || []).some(sys => sys.ringActive));
        for (const node of redNodesToCalculate) {
            await calculateRedNodeSystems(node.id);
        }
        if (scenario.overlays?.overlap_visible) {
            setTimeout(() => computeAndShowOverlap(true), 1200);
        }
    } finally {
        scenarioLoading = false;
    }
    markClean('Scenario loaded.');
}

function scenarioIsEmpty() {
    return redNodes.length === 0
        && blueNodes.length === 0
        && blackNodes.length === 0
        && epNodes.length === 0
        && enemyLinks.length === 0
        && jammingLinks.length === 0;
}

function downloadScenario(markAsSaved) {
    try {
        const scenario = serializeScenario();
        const blob = new Blob([JSON.stringify(scenario, null, 2) + '\n'], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = safeScenarioFilename(scenario.scenario_name);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        if (markAsSaved) markClean('Scenario saved.');
        else scenarioStatus('Scenario copy downloaded.');
    } catch (e) {
        scenarioStatus('Could not save scenario.', true);
        alert('Could not save scenario: ' + e.message);
    }
}

function restoreAutosaveIfPresent() {
    if (scenarioRestorePrompted) return;
    try {
        const raw = localStorage.getItem(currentScenarioAutosaveKey());
        if (!raw) return;
        const recovery = JSON.parse(raw);
        if (!recovery?.scenario || !recovery.saved_at) return;
        const cleanAt = getLastCleanTime();
        if (cleanAt && recovery.saved_at <= cleanAt) return;
        scenarioRestorePrompted = true;
        const label = recovery.scenario.scenario_name || 'Untitled scenario';
        if (confirm(`Recover unsaved scenario "${label}" from ${new Date(recovery.saved_at).toLocaleString()}?`)) {
            loadScenario(recovery.scenario);
        } else {
            localStorage.removeItem(currentScenarioAutosaveKey());
        }
    } catch (e) {
        console.warn('Scenario autosave restore failed', e);
    }
}

function initScenarioControls() {
    const nameInput = document.getElementById('scenario-name');
    const fileInput = document.getElementById('scenario-file-input');
    document.getElementById('btn-save-scenario').addEventListener('click', () => downloadScenario(true));
    document.getElementById('btn-save-copy').addEventListener('click', () => downloadScenario(false));
    document.getElementById('btn-load-scenario').addEventListener('click', () => fileInput.click());
    document.getElementById('btn-new-scenario').addEventListener('click', () => {
        if ((scenarioDirty || !scenarioIsEmpty()) && !confirm('Clear the current scenario and start a new one?')) return;
        scenarioLoading = true;
        resetScenarioState();
        setScenarioName('');
        scenarioCreatedAt = scenarioNow();
        scenarioLoading = false;
        markClean('New scenario ready.');
    });
    nameInput.addEventListener('input', () => markDirty('Scenario renamed.'));
    fileInput.addEventListener('change', () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (!file) return;
        if ((scenarioDirty || !scenarioIsEmpty()) && !confirm('Load this scenario and replace the current map?')) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const data = JSON.parse(reader.result);
                await loadScenario(data);
            } catch (e) {
                scenarioStatus('Scenario import failed.', true);
                alert('Could not load scenario: ' + e.message);
            }
        };
        reader.onerror = () => {
            scenarioStatus('Could not read scenario file.', true);
            alert('Could not read scenario file.');
        };
        reader.readAsText(file);
    });
    map.on('baselayerchange overlayadd overlayremove', () => markDirty('Map layer changed.'));
    map.on('moveend zoomend', () => markDirty('Map view changed.'));
    updateScenarioDirtyUi();
    restoreAutosaveIfPresent();
    setTimeout(restoreAutosaveIfPresent, 1600);
}

window.SpecterScenario = {
    serializeScenario,
    loadScenario,
    validateScenario,
    migrateScenario,
    resetScenarioState,
    markDirty,
    markClean,
    restoreAutosaveIfPresent
};

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

    // Enemy system rings — one style per palette entry, matching the map colors
    RED_SYSTEM_COLORS.forEach((hex, i) => {
        lines.push(`  <Style id="redSysRing-${i}"><LineStyle><color>${cssToKmlColor(hex)}</color><width>2</width></LineStyle><PolyStyle><color>${cssToKmlColor(hex, 0.15)}</color></PolyStyle></Style>`);
    });

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
    for (const { sensor, coverage } of activeSensorCoverages()) {
        if (!coverage.polygonPoints || coverage.polygonPoints.length < 3) continue;
        if (coverage.redSystem) continue; // exported below with its own color
        const tx = findNode('red', coverage.redId);
        // esPolygonPoints is [[lat,lng],...]; KML needs lng,lat,alt; close the ring
        const pts = [...coverage.polygonPoints, coverage.polygonPoints[0]];
        const coordStr = pts.map(pt => `${pt[1]},${pt[0]},0`).join(' ');
        lines.push('    <Placemark>');
        lines.push(`      <name>${escapeXml(sensor.name + ' detects ' + (tx ? tx.name : coverage.redId))}</name>`);
        lines.push('      <styleUrl>#esPoly</styleUrl>');
        lines.push('      <Polygon><tessellate>1</tessellate>');
        lines.push('        <outerBoundaryIs><LinearRing>');
        lines.push(`          <coordinates>${coordStr}</coordinates>`);
        lines.push('        </LinearRing></outerBoundaryIs>');
        lines.push('      </Polygon>');
        lines.push('    </Placemark>');
        if (includeLabels && coverage.rangeKm != null) {
            const ll = tx ? tx.marker.getLatLng() : sensor.marker.getLatLng();
            lines.push('    <Placemark>');
            lines.push(`      <name>Detection: ~${coverage.rangeKm.toFixed(1)} km</name>`);
            lines.push('      <styleUrl>#linkLabel</styleUrl>');
            lines.push(`      <Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point>`);
            lines.push('    </Placemark>');
        }
    }
    lines.push('  </Folder>');

    // --- Enemy System Rings ---
    lines.push('  <Folder><name>Enemy System Rings</name>');
    for (const node of redNodes) {
        const ll = node.marker.getLatLng();
        for (const sys of node.systems || []) {
            if (!sys.polygonPoints || sys.polygonPoints.length < 3) continue;
            const colorIdx = RED_SYSTEM_COLORS.indexOf(sys.color);
            const styleId  = colorIdx >= 0 ? `redSysRing-${colorIdx}` : 'redSysRing-0';
            // polygonPoints is [[lat,lng],...]; KML needs lng,lat,alt; close the ring
            const pts = [...sys.polygonPoints, sys.polygonPoints[0]];
            const coordStr = pts.map(pt => `${pt[1]},${pt[0]},0`).join(' ');
            lines.push('    <Placemark>');
            lines.push(`      <name>${escapeXml(node.name + ' — ' + sys.name)}</name>`);
            lines.push(`      <styleUrl>#${styleId}</styleUrl>`);
            lines.push('      <Polygon><tessellate>1</tessellate>');
            lines.push('        <outerBoundaryIs><LinearRing>');
            lines.push(`          <coordinates>${coordStr}</coordinates>`);
            lines.push('        </LinearRing></outerBoundaryIs>');
            lines.push('      </Polygon>');
            lines.push('    </Placemark>');
            if (includeLabels && sys.rangeKm != null) {
                lines.push('    <Placemark>');
                lines.push(`      <name>${escapeXml(sys.name)}: ~${sys.rangeKm.toFixed(1)} km</name>`);
                lines.push('      <styleUrl>#linkLabel</styleUrl>');
                lines.push(`      <Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point>`);
                lines.push('    </Placemark>');
            }
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

function exportEpKML(includeLabels) {
    const lines = [];
    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<kml xmlns="http://www.opengis.net/kml/2.2">');
    lines.push('<Document>');
    lines.push('  <name>Specter-EW EP Export</name>');

    // --- Styles ---
    const iconHref = 'http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png';
    lines.push(`  <Style id="epNode"><IconStyle><color>${cssToKmlColor('#27ae60')}</color><scale>1.2</scale><Icon><href>${iconHref}</href></Icon></IconStyle></Style>`);
    lines.push('  <Style id="epLabel"><IconStyle><scale>0</scale></IconStyle><LabelStyle><color>ffffffff</color><scale>0.75</scale></LabelStyle></Style>');
    EP_COLORS.forEach((color, i) => {
        lines.push(`  <Style id="epRing-${i}"><LineStyle><color>${cssToKmlColor(color)}</color><width>1</width></LineStyle><PolyStyle><color>${cssToKmlColor(color, 0.15)}</color></PolyStyle></Style>`);
    });

    // --- EP Nodes ---
    lines.push('  <Folder><name>EP Nodes</name>');
    for (const node of epNodes) {
        const ll = node.marker.getLatLng();
        lines.push('    <Placemark>');
        lines.push(`      <name>${escapeXml(node.name)}</name>`);
        lines.push('      <styleUrl>#epNode</styleUrl>');
        lines.push(`      <Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point>`);
        lines.push('    </Placemark>');
    }
    lines.push('  </Folder>');

    // --- EP Detection Rings ---
    lines.push('  <Folder><name>EP Detection Rings</name>');
    for (const node of epNodes) {
        for (const sys of node.systems) {
            if (!sys.polygonPoints || sys.polygonPoints.length < 3) continue;
            const colorIdx = EP_COLORS.indexOf(sys.color);
            const styleId = colorIdx >= 0 ? `epRing-${colorIdx}` : 'epRing-0';
            const pts = [...sys.polygonPoints, sys.polygonPoints[0]];
            const coordStr = pts.map(pt => `${pt[1]},${pt[0]},0`).join(' ');
            lines.push('    <Placemark>');
            lines.push(`      <name>${escapeXml(node.name + ' - ' + sys.name)}</name>`);
            lines.push(`      <styleUrl>#${styleId}</styleUrl>`);
            lines.push('      <Polygon><tessellate>1</tessellate>');
            lines.push('        <outerBoundaryIs><LinearRing>');
            lines.push(`          <coordinates>${coordStr}</coordinates>`);
            lines.push('        </LinearRing></outerBoundaryIs>');
            lines.push('      </Polygon>');
            lines.push('    </Placemark>');
            if (includeLabels && sys.rangeKm != null) {
                const ll = node.marker.getLatLng();
                lines.push('    <Placemark>');
                lines.push(`      <name>${escapeXml(sys.name + ': ~' + sys.rangeKm.toFixed(1) + ' km')}</name>`);
                lines.push('      <styleUrl>#epLabel</styleUrl>');
                lines.push(`      <Point><coordinates>${ll.lng},${ll.lat},0</coordinates></Point>`);
                lines.push('    </Placemark>');
            }
        }
    }
    lines.push('  </Folder>');

    lines.push('</Document>');
    lines.push('</kml>');

    const kmlString = lines.join('\n');
    const blob = new Blob([kmlString], { type: 'application/vnd.google-earth.kml+xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'specter-ep-export.kml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
}
