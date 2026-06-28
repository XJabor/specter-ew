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

const localImageryLayer = L.tileLayer('/tiles/local/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: 'Local Imagery',
    opacity: 1
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
const overlayMaps = {
    "Local Imagery": localImageryLayer
};
L.control.layers(baseMaps, overlayMaps).addTo(map);

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

const blackIcon = new L.Icon({
    iconUrl: '/static/img/marker-icon-black.png',
    shadowUrl: '/static/img/marker-shadow.png',
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34]
});

// ============================================================
// DATA STRUCTURES
// ============================================================

let redNodes    = [];   // { id, marker, esActive, esCircle }
let blueNodes   = [];   // { id, marker }
let blackNodes  = [];   // { id, name, marker } — reference-only markers
let enemyLinks  = [];   // { id, txId, rxId, line }
let jammingLinks = [];  // { id, blueId, rxId, line, result }

let activeMode = null;   // null | 'place-red' | 'place-blue' | 'place-black' | 'link-enemy' | 'link-jammer'
let linkSource = null;   // { color, id } — holds first node during two-step link creation
let selectedLink = null; // { type: 'enemy'|'jammer', enemyLinkId, jammingLinkId }
let redCounter   = 0;
let blueCounter  = 0;
let blackCounter = 0;

let overlapLayer        = null;   // L.polygon | L.layerGroup | null — yellow intersection overlay
let overlapChecked      = new Set(); // node IDs selected in the overlap checklist
let overlapVertices     = [];     // [[lat,lng],...] — all vertices of the current overlap polygon(s)
let cornerMarkers       = [];     // L.circleMarker[] — MGRS labels at each vertex
let cornersVisible      = false;

// ES terrain ring request management
let _esDebounceTimer       = null;       // debounce handle for scheduleESUpdate()
const _esAbortControllers  = {};         // nodeId → AbortController for in-flight terrain requests

// Jammer footprint request management
let _fpDebounceTimer       = null;
const _fpAbortControllers  = {};

// ============================================================
// EP MODE DATA
// ============================================================

const epNodes    = [];
const EP_COLORS  = ['#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bfff'];
let epNodeCounter = 0;
let epModeActive  = false;

// ============================================================
// SCENARIO SAVE / LOAD
// ============================================================

const SCENARIO_SCHEMA_VERSION = 3;
const SPECTER_APP_VERSION = 'release-1-dev';
const PROFILE_PACK_STORAGE_KEY = 'specter-ew:equipment-profile-packs';
const PROFILE_CATEGORIES = ['radio', 'receiver', 'jammer', 'antenna'];
const PROFILE_NUMERIC_RANGES = {
    frequency_mhz:      [1, 40000],
    tx_power_w:         [0.001, 1000000],
    antenna_gain_dbi:   [-60, 80],
    rx_sensitivity_dbm: [-200, 0],
    antenna_height_m:   [1, 500],
    beamwidth_deg:      [1, 360],
    channel_bw_khz:     [0.001, 10000000],
    jammer_bw_khz:      [0.001, 10000000]
};
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
let builtInProfilePack = null;
let userProfilePacks = [];
let profileLoadPromise = null;
let selectedEquipmentNode = null; // { type: 'red'|'blue', id }
let syncingSidebarFromNode = false;
let pendingLibraryPlacement = null; // { team: 'red'|'blue', templateKey }

function scenarioNow() {
    return new Date().toISOString();
}

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

function latLngToPlain(latlng) {
    return { lat: latlng.lat, lon: latlng.lng };
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

function activeBaseLayerName() {
    if (map.hasLayer(streetLayer)) return 'Streets';
    return 'Satellite';
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
                es_active: !!node.esActive
            })),
            blue: blueNodes.map(node => ({
                id: node.id,
                name: node.name,
                location: latLngToPlain(node.marker.getLatLng()),
                equipment: equipmentScenarioState(node, 'blue'),
                ...nodeAntennaState(node),
                footprint_active: !!node.footprintActive
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

function validateScenario(data) {
    if (!data || typeof data !== 'object') throw new Error('Scenario file is not valid JSON.');
    if (data.schema_version == null) throw new Error('Scenario is missing schema_version.');
    if (Number(data.schema_version) > SCENARIO_SCHEMA_VERSION) {
        throw new Error(`Scenario schema v${data.schema_version} is newer than this app supports.`);
    }
    if (!data.nodes || typeof data.nodes !== 'object') throw new Error('Scenario is missing nodes.');
    if (!data.links || typeof data.links !== 'object') throw new Error('Scenario is missing links.');
    ['red', 'blue', 'black', 'ep'].forEach(kind => {
        const items = data.nodes[kind] || [];
        if (!Array.isArray(items)) throw new Error(`Scenario nodes.${kind} must be an array.`);
        items.forEach(item => {
            if (!item.id || !item.location) throw new Error(`Scenario ${kind} node is missing id or location.`);
            const lat = Number(item.location.lat);
            const lon = Number(item.location.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                throw new Error(`Scenario ${kind} node ${item.id} has an invalid location.`);
            }
        });
    });
    if (!Array.isArray(data.links.enemy || [])) throw new Error('Scenario links.enemy must be an array.');
    if (!Array.isArray(data.links.jamming || [])) throw new Error('Scenario links.jamming must be an array.');
    if (data.profile_library != null) {
        if (!data.profile_library || typeof data.profile_library !== 'object') throw new Error('Scenario profile_library must be an object.');
        if (!Array.isArray(data.profile_library.packs || [])) throw new Error('Scenario profile_library.packs must be an array.');
        (data.profile_library.packs || []).forEach(pack => validateProfilePack(pack, { allowJammerProfiles: true }));
    }
    return true;
}

function migrateScenario(data) {
    validateScenario(data);
    if (Number(data.schema_version) === SCENARIO_SCHEMA_VERSION) return data;
    if ([1, 2].includes(Number(data.schema_version))) {
        const settings = data.settings || {};
        const redEquipment = {
            equipment_type: 'radio',
            frequency_mhz: Number(settings.freq_mhz || 150),
            tx_power_w: Number(settings.enemy_tx_w || 5),
            rx_sensitivity_dbm: Number(settings.rx_sensitivity || -90),
            antenna_gain_dbi: Number(settings.enemy_tx_gain || 0),
            rx_gain_dbi: Number(settings.enemy_rx_gain || 0),
            antenna_type: 'omni',
            beamwidth_deg: 360,
            antenna_height_m: 1,
            apply_fh: !!settings.fh_toggle,
            channel_bw_khz: Number(settings.enemy_bw_khz || 25),
            jammer_bw_khz: Number(settings.jammer_bw_khz || 20000)
        };
        const blueEquipment = {
            equipment_type: 'jammer',
            frequency_mhz: Number(settings.freq_mhz || 150),
            tx_power_w: Number(settings.jammer_tx_w || 20),
            rx_sensitivity_dbm: Number(settings.rx_sensitivity || -90),
            antenna_gain_dbi: Number(settings.jammer_tx_gain || 3),
            rx_gain_dbi: Number(settings.friendly_rx_gain || 0),
            antenna_type: 'omni',
            beamwidth_deg: 360,
            antenna_height_m: 1,
            apply_fh: false,
            channel_bw_khz: Number(settings.enemy_bw_khz || 25),
            jammer_bw_khz: Number(settings.jammer_bw_khz || 20000)
        };
        return {
            ...data,
            schema_version: SCENARIO_SCHEMA_VERSION,
            nodes: {
                ...data.nodes,
                red: (data.nodes?.red || []).map(node => ({ ...node, equipment: node.equipment || redEquipment })),
                blue: (data.nodes?.blue || []).map(node => ({ ...node, equipment: node.equipment || blueEquipment }))
            },
            profile_library: data.profile_library || { packs: [] }
        };
    }
    throw new Error(`Unsupported scenario schema v${data.schema_version}.`);
}

function setCounterFromIds(ids, prefix) {
    return ids.reduce((max, id) => {
        const match = String(id || '').match(new RegExp('^' + prefix + '(\\d+)$'));
        return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
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

function makeRedNodeFromScenario(item) {
    const ll = [Number(item.location.lat), Number(item.location.lon)];
    const marker = L.marker(ll, { icon: redIcon, draggable: true }).addTo(map);
    const node = {
        id: item.id,
        name: item.name || item.id,
        marker,
        esActive: !!item.es_active,
        esCircle: null,
        esLabel: null,
        elevationM: null,
        esPolygonPoints: null,
        esRangeKm: null,
        antennaType: item.antenna_type || 'omni',
        antennaAzimuth: Number(item.antenna_azimuth || 0),
        antennaBeamwidth: Number(item.antenna_beamwidth || 90),
        antennaHeightAgl: Number(item.antenna_height_agl || 1.0)
    };
    applyEquipmentToNode(node, {
        ...(item.equipment || {}),
        antenna_type: item.antenna_type || item.equipment?.antenna_type,
        beamwidth_deg: item.antenna_beamwidth || item.equipment?.beamwidth_deg,
        antenna_height_m: item.antenna_height_agl || item.equipment?.antenna_height_m
    }, 'red');
    node.antennaAzimuth = Number(item.antenna_azimuth || 0);
    marker.on('click', function() { handleNodeClick('red', node.id); });
    marker.on('dragend', function() { fetchAndStoreElevation(node); markDirty('Node moved.'); recalculateAll(); });
    marker.on('popupclose', function() { bindRedPopup(node.id); });
    redNodes.push(node);
    bindRedPopup(node.id);
    fetchAndStoreElevation(node);
}

function makeBlueNodeFromScenario(item) {
    const ll = [Number(item.location.lat), Number(item.location.lon)];
    const marker = L.marker(ll, { icon: blueIcon, draggable: true }).addTo(map);
    const node = {
        id: item.id,
        name: item.name || item.id,
        marker,
        elevationM: null,
        antennaType: item.antenna_type || 'omni',
        antennaAzimuth: Number(item.antenna_azimuth || 0),
        antennaBeamwidth: Number(item.antenna_beamwidth || 90),
        antennaHeightAgl: Number(item.antenna_height_agl || 1.0),
        footprintActive: !!item.footprint_active,
        footprintCircle: null,
        fpLabel: null,
        footprintPolygonPoints: null
    };
    applyEquipmentToNode(node, {
        ...(item.equipment || {}),
        antenna_type: item.antenna_type || item.equipment?.antenna_type,
        beamwidth_deg: item.antenna_beamwidth || item.equipment?.beamwidth_deg,
        antenna_height_m: item.antenna_height_agl || item.equipment?.antenna_height_m
    }, 'blue');
    node.antennaAzimuth = Number(item.antenna_azimuth || 0);
    marker.on('click', function() { handleNodeClick('blue', node.id); });
    marker.on('dragend', function() { fetchAndStoreElevation(node); markDirty('Node moved.'); recalculateAll(); scheduleFootprintUpdate(); });
    marker.on('popupclose', function() { bindBluePopup(node.id); });
    blueNodes.push(node);
    bindBluePopup(node.id);
    fetchAndStoreElevation(node);
}

function makeBlackNodeFromScenario(item) {
    const ll = [Number(item.location.lat), Number(item.location.lon)];
    const marker = L.marker(ll, { icon: blackIcon, draggable: true }).addTo(map);
    const node = { id: item.id, name: item.name || item.id, marker };
    marker.on('dragend', function() { markDirty('Marker moved.'); updateMGRSTooltips(); });
    marker.on('popupclose', function() { bindBlackPopup(node.id); });
    blackNodes.push(node);
    bindBlackPopup(node.id);
}

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

function resetScenarioState() {
    setMode(null);
    Object.values(_esAbortControllers).forEach(controller => controller.abort());
    Object.keys(_esAbortControllers).forEach(id => delete _esAbortControllers[id]);
    Object.values(_fpAbortControllers).forEach(controller => controller.abort());
    Object.keys(_fpAbortControllers).forEach(id => delete _fpAbortControllers[id]);
    redNodes.forEach(n => { map.removeLayer(n.marker); if (n.esCircle) map.removeLayer(n.esCircle); if (n.esLabel) map.removeLayer(n.esLabel); });
    blueNodes.forEach(n => { map.removeLayer(n.marker); if (n.footprintCircle) map.removeLayer(n.footprintCircle); if (n.fpLabel) map.removeLayer(n.fpLabel); });
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
    const status = document.getElementById('selected-node-status');
    if (status) status.textContent = 'No node selected. Editing defaults for new blank nodes.';
    updateSidebarFrequencyLock('radio');
    overlapChecked.clear();
    clearOverlapLayer();
    renderOverlapControls();
    renderResults();
    updateEpWorkbench();
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
        renderOverlapControls();
        recalculateAll();
        const epNodesToCalculate = epNodes.filter(node => node.systems.some(sys => sys.ringActive));
        for (const node of epNodesToCalculate) {
            await calculateEpNode(node.id);
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

function safeScenarioFilename(name) {
    const base = (name || '').trim()
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    if (base) return base + '.specter.json';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    return `specter-${stamp}.specter.json`;
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
// MODE MANAGEMENT
// ============================================================

const modeBtnIds = {
    'place-red':   'btn-place-red',
    'place-blue':  'btn-place-blue',
    'place-black': 'btn-place-black',
    'place-ep':    'btn-place-ep',
};

const modeLabels = {
    null:           'Pan / Select',
    'place-red':    'Click map to place Enemy Node — ESC to cancel',
    'place-blue':   'Click map to place Friendly Node — ESC to cancel',
    'place-library-red':  'Click map to place selected Enemy template - ESC to cancel',
    'place-library-blue': 'Click map to place selected Friendly template - ESC to cancel',
    'place-black':  'Click map to place Marker — ESC to cancel',
    'link-enemy':   'Click the TX Enemy Node — ESC to cancel',
    'link-jammer':  'Click the target Enemy Node — ESC to cancel',
    'place-ep':     'Click map to place EP Node — ESC to cancel',
};

function setMode(newMode) {
    // Clicking the active button again cancels the mode
    if (newMode !== null && activeMode === newMode && !linkSource) newMode = null;

    if (linkSource) highlightNode(linkSource.color, linkSource.id, false);
    activeMode = newMode;
    if (newMode !== 'place-library-red' && newMode !== 'place-library-blue') pendingLibraryPlacement = null;
    linkSource = null;

    Object.values(modeBtnIds).forEach(id => document.getElementById(id).classList.remove('active'));
    if (newMode && modeBtnIds[newMode]) document.getElementById(modeBtnIds[newMode]).classList.add('active');

    map.getContainer().style.cursor = (newMode === 'place-red' || newMode === 'place-blue' || newMode === 'place-library-red' || newMode === 'place-library-blue' || newMode === 'place-black') ? 'crosshair' : '';
    document.getElementById('mode-indicator').textContent = modeLabels[newMode] ?? 'Pan / Select';
}

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') setMode(null);
});

// ============================================================
// HELPERS
// ============================================================

function findNode(color, id) {
    if (color === 'red')   return redNodes.find(n => n.id === id);
    if (color === 'blue')  return blueNodes.find(n => n.id === id);
    if (color === 'black') return blackNodes.find(n => n.id === id);
    if (color === 'ep')    return epNodes.find(n => n.id === id);
}

function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// EQUIPMENT PROFILE LIBRARY
// ============================================================

function profileStatus(message, isError = false) {
    const el = document.getElementById('profile-library-status');
    if (!el) return;
    el.style.color = isError ? '#ff7777' : '#aaa';
    el.textContent = message || '';
}

function normalizeProfileId(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function assertFiniteRange(profile, field) {
    if (profile[field] == null || profile[field] === '') return;
    const value = Number(profile[field]);
    const range = PROFILE_NUMERIC_RANGES[field];
    if (!Number.isFinite(value) || value < range[0] || value > range[1]) {
        throw new Error(`${profile.name || profile.id || 'Profile'} has invalid ${field}.`);
    }
    profile[field] = value;
}

function validateProfilePack(pack, options = {}) {
    if (!pack || typeof pack !== 'object') throw new Error('Profile pack is not valid JSON.');
    const schemaVersion = Number(pack.schema_version);
    if (![1, 2].includes(schemaVersion)) throw new Error('Equipment library schema_version must be 1 or 2.');
    if (!normalizeProfileId(pack.pack_id)) throw new Error('Profile pack is missing pack_id.');
    if (!String(pack.pack_name || '').trim()) throw new Error('Profile pack is missing pack_name.');
    const entries = Array.isArray(pack.templates) ? pack.templates : pack.profiles;
    if (!Array.isArray(entries)) throw new Error('Equipment library templates must be an array.');

    const seen = new Set();
    const normalizedTemplates = entries.map(raw => {
        if (!raw || typeof raw !== 'object') throw new Error('Template entries must be objects.');
        const profile = { ...raw };
        profile.id = normalizeProfileId(profile.id || profile.name);
        profile.name = String(profile.name || profile.id).trim().slice(0, 100);
        profile.equipment_type = String(profile.equipment_type || profile.category || 'radio').trim().toLowerCase();
        profile.category = profile.equipment_type;
        if (!profile.id || !profile.name) throw new Error('Every template needs an id and name.');
        if (!PROFILE_CATEGORIES.includes(profile.equipment_type)) throw new Error(`${profile.name} has unsupported equipment type.`);
        if (!options.allowJammerProfiles && profile.equipment_type === 'jammer') {
            throw new Error('Built-in packs cannot include jammer templates.');
        }
        if (seen.has(profile.id)) throw new Error(`Duplicate template id ${profile.id}.`);
        seen.add(profile.id);

        Object.keys(PROFILE_NUMERIC_RANGES).forEach(field => assertFiniteRange(profile, field));
        if (profile.antenna_type != null) {
            profile.antenna_type = String(profile.antenna_type).toLowerCase() === 'directional' ? 'directional' : 'omni';
        }
        const roles = Array.isArray(profile.role_compatibility) ? profile.role_compatibility : ['enemy', 'friendly'];
        profile.role_compatibility = roles
            .map(role => String(role).toLowerCase())
            .filter(role => role === 'enemy' || role === 'friendly');
        if (profile.role_compatibility.length === 0) profile.role_compatibility = ['enemy', 'friendly'];
        ['manufacturer', 'model', 'notes', 'source_url'].forEach(field => {
            if (profile[field] != null) profile[field] = String(profile[field]).trim().slice(0, field === 'notes' ? 500 : 240);
        });
        return profile;
    });
    return {
        schema_version: 2,
        pack_id: normalizeProfileId(pack.pack_id),
        pack_name: String(pack.pack_name).trim().slice(0, 100),
        templates: normalizedTemplates,
        profiles: normalizedTemplates
    };
}

function loadUserProfilePacks() {
    try {
        const raw = localStorage.getItem(PROFILE_PACK_STORAGE_KEY);
        const packs = raw ? JSON.parse(raw) : [];
        userProfilePacks = Array.isArray(packs)
            ? packs.map(pack => validateProfilePack(pack, { allowJammerProfiles: true }))
            : [];
    } catch (e) {
        console.warn('Profile pack storage reset', e);
        userProfilePacks = [];
    }
}

function saveUserProfilePacks() {
    try {
        localStorage.setItem(PROFILE_PACK_STORAGE_KEY, JSON.stringify(userProfilePacks));
    } catch (e) {
        profileStatus('Could not persist profiles locally.', true);
    }
}

function allProfilePacks() {
    return builtInProfilePack ? [builtInProfilePack, ...userProfilePacks] : [...userProfilePacks];
}

function allProfiles(category = 'all') {
    return allProfilePacks().flatMap(pack => pack.profiles.map(profile => ({
        ...profile,
        pack_id: pack.pack_id,
        pack_name: pack.pack_name,
        built_in: pack.pack_id === 'specter-builtins',
        key: `${pack.pack_id}/${profile.id}`
    }))).filter(profile => category === 'all' || profile.category === category);
}

function findProfile(key) {
    return allProfiles('all').find(profile => profile.key === key);
}

function profileOptionsHtml(category, placeholder) {
    const profiles = allProfiles(category);
    const options = [`<option value="">${escapeHtml(placeholder || 'Select profile...')}</option>`];
    profiles.forEach(profile => {
        const label = profile.built_in ? profile.name : `${profile.name} (${profile.pack_name})`;
        options.push(`<option value="${escapeHtml(profile.key)}">${escapeHtml(label)}</option>`);
    });
    return options.join('');
}

function setInputValue(id, value) {
    if (value == null) return false;
    const el = document.getElementById(id);
    if (!el) return false;
    el.value = value;
    return true;
}

function applyProfileToSidebar(profile, target) {
    if (!profile) return;
    let changed = false;
    if (target === 'ea-radio') {
        changed = setInputValue('freq_mhz', profile.frequency_mhz) || changed;
        changed = setInputValue('enemy_tx_w', profile.tx_power_w) || changed;
        changed = setInputValue('enemy_tx_gain', profile.antenna_gain_dbi) || changed;
        changed = setInputValue('enemy_rx_gain', profile.antenna_gain_dbi) || changed;
        changed = setInputValue('rx_sensitivity', profile.rx_sensitivity_dbm) || changed;
    } else if (target === 'ea-receiver') {
        changed = setInputValue('freq_mhz', profile.frequency_mhz) || changed;
        changed = setInputValue('rx_sensitivity', profile.rx_sensitivity_dbm) || changed;
        changed = setInputValue('friendly_rx_gain', profile.antenna_gain_dbi) || changed;
    } else if (target === 'ea-jammer') {
        changed = setInputValue('freq_mhz', profile.frequency_mhz) || changed;
        changed = setInputValue('jammer_tx_w', profile.tx_power_w) || changed;
        changed = setInputValue('jammer_tx_gain', profile.antenna_gain_dbi) || changed;
    }
    if (changed) {
        updateFrequencyHoppingControls();
        markDirty('Profile applied.');
        recalculateAll();
    }
}

function applyProfileToNode(team, id, profile) {
    const node = findNode(team, id);
    if (!node || !profile) return;
    if (profile.antenna_type) node.antennaType = profile.antenna_type;
    if (profile.beamwidth_deg != null) node.antennaBeamwidth = Number(profile.beamwidth_deg);
    if (profile.antenna_height_m != null) node.antennaHeightAgl = Number(profile.antenna_height_m);
    if (profile.antenna_gain_dbi != null) {
        if (team === 'red') {
            setInputValue('enemy_tx_gain', profile.antenna_gain_dbi);
            setInputValue('enemy_rx_gain', profile.antenna_gain_dbi);
        } else if (team === 'blue') {
            setInputValue('jammer_tx_gain', profile.antenna_gain_dbi);
        }
    }
    if (team === 'red') bindRedPopup(id); else bindBluePopup(id);
    node.marker.openPopup();
    markDirty('Antenna profile applied.');
    recalculateAll();
}

function applyProfileToEpSystem(nodeId, sysId, profile, target) {
    const node = epNodes.find(n => n.id === nodeId);
    const sys = node && node.systems.find(s => s.id === sysId);
    if (!sys || !profile) return;
    clearEpNodeRings(node);
    if (target === 'radio') {
        if (profile.frequency_mhz != null) sys.freqMhz = Number(profile.frequency_mhz);
        if (profile.tx_power_w != null) sys.txPowerW = Number(profile.tx_power_w);
        if (profile.antenna_gain_dbi != null) sys.txGainDbi = Number(profile.antenna_gain_dbi);
    } else if (target === 'antenna') {
        if (profile.antenna_type) sys.antennaType = profile.antenna_type;
        if (profile.beamwidth_deg != null) sys.antennaBeamwidth = Number(profile.beamwidth_deg);
        if (profile.antenna_height_m != null) sys.antennaHeightAgl = Number(profile.antenna_height_m);
        if (profile.antenna_gain_dbi != null) sys.txGainDbi = Number(profile.antenna_gain_dbi);
    }
    updateEpWorkbench();
    markDirty('EP profile applied.');
}

function renderProfileControls() {
    const category = document.getElementById('profile-category-filter')?.value || 'radio';
    const librarySelect = document.getElementById('profile-library-select');
    if (librarySelect) librarySelect.innerHTML = profileOptionsHtml(category, 'Select profile...');
    const deleteBtn = document.getElementById('btn-profile-delete');
    const selectedProfile = findProfile(librarySelect?.value);
    if (deleteBtn) deleteBtn.disabled = !selectedProfile || selectedProfile.built_in;

    const radioSelect = document.getElementById('ea-radio-profile-select');
    if (radioSelect) radioSelect.innerHTML = profileOptionsHtml('radio', 'Select radio...');
    const receiverSelect = document.getElementById('ea-receiver-profile-select');
    if (receiverSelect) receiverSelect.innerHTML = profileOptionsHtml('receiver', 'Select receiver...');
    const jammerSelect = document.getElementById('ea-jammer-profile-select');
    if (jammerSelect) jammerSelect.innerHTML = profileOptionsHtml('jammer', 'No built-in jammer profiles');
    updateEpWorkbench();
}

function mergeUserProfilePacks(packs) {
    if (!Array.isArray(packs)) return 0;
    let count = 0;
    packs.forEach(pack => {
        const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
        if (normalized.pack_id === 'specter-builtins') {
            throw new Error('Profile pack_id "specter-builtins" is reserved.');
        }
        const existingIdx = userProfilePacks.findIndex(p => p.pack_id === normalized.pack_id);
        if (existingIdx >= 0) userProfilePacks[existingIdx] = normalized;
        else userProfilePacks.push(normalized);
        count++;
    });
    saveUserProfilePacks();
    renderProfileControls();
    renderLibraryControls();
    return count;
}

function scenarioProfileLibraryState() {
    return { packs: userProfilePacks };
}

function saveCurrentProfile() {
    const category = document.getElementById('profile-category-filter')?.value;
    if (!PROFILE_CATEGORIES.includes(category)) {
        profileStatus('Choose a specific category first.', true);
        return;
    }
    const name = prompt('Profile name:');
    if (!name || !name.trim()) return;
    const profile = {
        id: normalizeProfileId(name),
        name: name.trim(),
        category,
        notes: 'User-created profile'
    };
    if (category === 'radio') {
        profile.frequency_mhz = Number(document.getElementById('freq_mhz').value);
        profile.tx_power_w = Number(document.getElementById('enemy_tx_w').value);
        profile.antenna_gain_dbi = Number(document.getElementById('enemy_tx_gain').value);
        profile.rx_sensitivity_dbm = Number(document.getElementById('rx_sensitivity').value);
    } else if (category === 'receiver') {
        profile.frequency_mhz = Number(document.getElementById('freq_mhz').value);
        profile.antenna_gain_dbi = Number(document.getElementById('friendly_rx_gain').value);
        profile.rx_sensitivity_dbm = Number(document.getElementById('rx_sensitivity').value);
    } else if (category === 'jammer') {
        profile.frequency_mhz = Number(document.getElementById('freq_mhz').value);
        profile.tx_power_w = Number(document.getElementById('jammer_tx_w').value);
        profile.antenna_gain_dbi = Number(document.getElementById('jammer_tx_gain').value);
    } else if (category === 'antenna') {
        profile.antenna_gain_dbi = Number(document.getElementById('enemy_tx_gain').value);
        profile.antenna_height_m = 1.5;
        profile.antenna_type = 'omni';
        profile.beamwidth_deg = 360;
    }
    const pack = userProfilePacks.find(p => p.pack_id === 'user-profiles') || {
        schema_version: 1,
        pack_id: 'user-profiles',
        pack_name: 'User Profiles',
        profiles: []
    };
    pack.profiles = pack.profiles.filter(p => p.id !== profile.id);
    pack.profiles.push(profile);
    const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
    const existingIdx = userProfilePacks.findIndex(p => p.pack_id === normalized.pack_id);
    if (existingIdx >= 0) userProfilePacks[existingIdx] = normalized;
    else userProfilePacks.push(normalized);
    saveUserProfilePacks();
    renderProfileControls();
    markDirty('Profile library changed.');
    profileStatus('Profile saved.');
}

function exportUserProfilePack() {
    const pack = {
        schema_version: 1,
        pack_id: 'specter-exported-profiles',
        pack_name: 'SPECTER Exported Profiles',
        profiles: userProfilePacks.flatMap(pack => pack.profiles.map(profile => ({
            ...profile,
            id: normalizeProfileId(`${pack.pack_id}-${profile.id}`)
        })))
    };
    try {
        const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
        const blob = new Blob([JSON.stringify(normalized, null, 2) + '\n'], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'specter-equipment-profiles.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        profileStatus('Profile pack exported.');
    } catch (e) {
        profileStatus('No valid user profiles to export.', true);
    }
}

function initProfileControls() {
    if (profileLoadPromise) return profileLoadPromise;
    loadUserProfilePacks();
    profileLoadPromise = fetch('/static/equipment_profiles.json')
        .then(r => {
            if (!r.ok) throw new Error('Built-in profile pack could not be loaded.');
            return r.json();
        })
        .then(pack => {
            builtInProfilePack = validateProfilePack(pack, { allowJammerProfiles: false });
            renderProfileControls();
            profileStatus(`${allProfiles('all').length} profiles loaded.`);
        })
        .catch(e => {
            console.warn('Profile library load failed', e);
            renderProfileControls();
            profileStatus('Built-in profiles unavailable.', true);
        });

    document.getElementById('profile-category-filter')?.addEventListener('change', renderProfileControls);
    document.getElementById('profile-library-select')?.addEventListener('change', function() {
        const profile = findProfile(this.value);
        const deleteBtn = document.getElementById('btn-profile-delete');
        if (deleteBtn) deleteBtn.disabled = !profile || profile.built_in;
    });
    document.getElementById('btn-profile-apply')?.addEventListener('click', function() {
        const profile = findProfile(document.getElementById('profile-library-select')?.value);
        if (!profile) return;
        if (profile.category === 'radio') applyProfileToSidebar(profile, 'ea-radio');
        else if (profile.category === 'receiver') applyProfileToSidebar(profile, 'ea-receiver');
        else if (profile.category === 'jammer') applyProfileToSidebar(profile, 'ea-jammer');
        else profileStatus('Select an antenna from a node popup or EP system.', true);
    });
    document.getElementById('btn-profile-save-current')?.addEventListener('click', saveCurrentProfile);
    document.getElementById('btn-profile-delete')?.addEventListener('click', function() {
        const profile = findProfile(document.getElementById('profile-library-select')?.value);
        if (!profile || profile.built_in) return;
        const pack = userProfilePacks.find(p => p.pack_id === profile.pack_id);
        if (!pack) return;
        pack.profiles = pack.profiles.filter(p => p.id !== profile.id);
        userProfilePacks = userProfilePacks.filter(p => p.profiles.length > 0);
        saveUserProfilePacks();
        renderProfileControls();
        markDirty('Profile library changed.');
        profileStatus('Profile deleted.');
    });
    document.getElementById('btn-profile-export')?.addEventListener('click', exportUserProfilePack);
    document.getElementById('btn-profile-import')?.addEventListener('click', () => document.getElementById('profile-pack-input')?.click());
    document.getElementById('profile-pack-input')?.addEventListener('change', function() {
        const file = this.files && this.files[0];
        this.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const pack = JSON.parse(reader.result);
                mergeUserProfilePacks([pack]);
                markDirty('Profile pack imported.');
                profileStatus('Profile pack imported.');
            } catch (e) {
                profileStatus(e.message, true);
                alert('Could not import profile pack: ' + e.message);
            }
        };
        reader.readAsText(file);
    });
    document.querySelectorAll('[data-profile-apply]').forEach(select => {
        select.addEventListener('change', function() {
            const profile = findProfile(this.value);
            if (profile) applyProfileToSidebar(profile, this.dataset.profileApply);
            this.value = '';
        });
    });
    return profileLoadPromise;
}

window.applyNodeAntennaProfile = function(team, id, key) {
    const profile = findProfile(key);
    if (profile) applyProfileToNode(team, id, profile);
};

window.applyEpProfile = function(nodeId, sysId, key, target) {
    const profile = findProfile(key);
    if (profile) applyProfileToEpSystem(nodeId, sysId, profile, target);
};

function allNodeTemplates(role = 'all') {
    return allProfilePacks().flatMap(pack => (pack.templates || pack.profiles || []).map(template => ({
        ...template,
        pack_id: pack.pack_id,
        pack_name: pack.pack_name,
        built_in: pack.pack_id === 'specter-builtins',
        key: `${pack.pack_id}/${template.id}`
    }))).filter(template => {
        if (template.equipment_type === 'antenna') return false;
        if (role === 'all') return true;
        const target = role === 'red' ? 'enemy' : 'friendly';
        return (template.role_compatibility || ['enemy', 'friendly']).includes(target);
    });
}

function findNodeTemplate(key) {
    return allNodeTemplates('all').find(template => template.key === key);
}

function epSystemTemplateOptionsHtml() {
    const templates = allNodeTemplates('all').filter(template => template.equipment_type !== 'jammer');
    return ['<option value="">Select system...</option>'].concat(templates.map(template => {
        const source = template.built_in ? 'Built-in' : template.pack_name;
        return `<option value="${escapeHtml(template.key)}">${escapeHtml(template.name)} - ${escapeHtml(source)}</option>`;
    })).join('');
}

function equipmentFromTemplate(template) {
    return {
        template_id: template?.key || '',
        name: template?.name || '',
        equipment_type: template?.equipment_type || 'radio',
        frequency_mhz: Number(template?.frequency_mhz ?? 150),
        tx_power_w: Number(template?.tx_power_w ?? 5),
        rx_sensitivity_dbm: Number(template?.rx_sensitivity_dbm ?? -90),
        antenna_gain_dbi: Number(template?.antenna_gain_dbi ?? 0),
        rx_gain_dbi: Number(template?.rx_gain_dbi ?? template?.antenna_gain_dbi ?? 0),
        antenna_type: template?.antenna_type || 'omni',
        beamwidth_deg: Number(template?.beamwidth_deg ?? 360),
        antenna_height_m: Number(template?.antenna_height_m ?? 1),
        notes: template?.notes || '',
        source_url: template?.source_url || ''
    };
}

function currentFhDefaults() {
    return {
        apply_fh: !!document.getElementById('fh_toggle')?.checked,
        channel_bw_khz: Number(document.getElementById('enemy_bw_khz')?.value || 25),
        jammer_bw_khz: Number(document.getElementById('jammer_bw_khz')?.value || 20000)
    };
}

function equipmentFromSidebar(type) {
    const fh = currentFhDefaults();
    if (type === 'blue') {
        return {
            template_id: '',
            name: '',
            equipment_type: 'jammer',
            frequency_mhz: Number(document.getElementById('freq_mhz').value || 150),
            tx_power_w: Number(document.getElementById('jammer_tx_w').value || 20),
            rx_sensitivity_dbm: Number(document.getElementById('rx_sensitivity').value || -90),
            antenna_gain_dbi: Number(document.getElementById('jammer_tx_gain').value || 0),
            rx_gain_dbi: Number(document.getElementById('friendly_rx_gain').value || 0),
            antenna_type: 'omni',
            beamwidth_deg: 360,
            antenna_height_m: 1,
            apply_fh: false,
            channel_bw_khz: fh.channel_bw_khz,
            jammer_bw_khz: fh.jammer_bw_khz
        };
    }
    return {
        template_id: '',
        name: '',
        equipment_type: 'radio',
        frequency_mhz: Number(document.getElementById('freq_mhz').value || 150),
        tx_power_w: Number(document.getElementById('enemy_tx_w').value || 5),
        rx_sensitivity_dbm: Number(document.getElementById('rx_sensitivity').value || -90),
        antenna_gain_dbi: Number(document.getElementById('enemy_tx_gain').value || 0),
        rx_gain_dbi: Number(document.getElementById('enemy_rx_gain').value || 0),
        antenna_type: 'omni',
        beamwidth_deg: 360,
        antenna_height_m: 1,
        apply_fh: fh.apply_fh,
        channel_bw_khz: fh.channel_bw_khz,
        jammer_bw_khz: fh.jammer_bw_khz
    };
}

function normalizeEquipmentConfig(equipment, type = 'red') {
    const defaults = equipmentFromSidebar(type);
    const merged = { ...defaults, ...(equipment || {}) };
    merged.equipment_type = PROFILE_CATEGORIES.includes(merged.equipment_type) ? merged.equipment_type : defaults.equipment_type;
    merged.frequency_mhz = Number(merged.frequency_mhz || defaults.frequency_mhz);
    merged.tx_power_w = Number(merged.tx_power_w || defaults.tx_power_w);
    merged.rx_sensitivity_dbm = Number(merged.rx_sensitivity_dbm ?? defaults.rx_sensitivity_dbm);
    merged.antenna_gain_dbi = Number(merged.antenna_gain_dbi ?? defaults.antenna_gain_dbi);
    merged.rx_gain_dbi = Number(merged.rx_gain_dbi ?? merged.antenna_gain_dbi ?? defaults.rx_gain_dbi);
    merged.antenna_type = merged.antenna_type === 'directional' ? 'directional' : 'omni';
    merged.beamwidth_deg = Math.max(1, Math.min(360, Number(merged.beamwidth_deg || defaults.beamwidth_deg)));
    merged.antenna_height_m = Math.max(1, Number(merged.antenna_height_m || defaults.antenna_height_m));
    merged.apply_fh = !!merged.apply_fh;
    merged.channel_bw_khz = Math.max(0.001, Number(merged.channel_bw_khz || defaults.channel_bw_khz || 25));
    merged.jammer_bw_khz = Math.max(0.001, Number(merged.jammer_bw_khz || defaults.jammer_bw_khz || 20000));
    return merged;
}

function applyEquipmentToNode(node, equipment, type) {
    node.equipment = normalizeEquipmentConfig(equipment, type);
    node.antennaType = node.equipment.antenna_type;
    node.antennaBeamwidth = node.equipment.beamwidth_deg;
    node.antennaHeightAgl = node.equipment.antenna_height_m;
}

function nodeEquipment(node, type) {
    if (!node.equipment) applyEquipmentToNode(node, equipmentFromSidebar(type), type);
    return node.equipment;
}

function equipmentScenarioState(node, type) {
    return normalizeEquipmentConfig(nodeEquipment(node, type), type);
}

function frequencyLockedForEquipment(equipmentType) {
    return equipmentType === 'receiver' || equipmentType === 'jammer';
}

function updateSidebarFrequencyLock(equipmentType) {
    const input = document.getElementById('freq_mhz');
    const label = document.getElementById('freq-label');
    const note = document.getElementById('freq-lock-note');
    if (!input || !label) return;
    const locked = frequencyLockedForEquipment(equipmentType);
    input.disabled = locked;
    if (note) note.style.display = locked ? 'block' : 'none';
    if (equipmentType === 'jammer') label.textContent = 'Target Frequency (MHz)';
    else if (equipmentType === 'receiver') label.textContent = 'Reference Frequency (MHz)';
    else label.textContent = 'Frequency (MHz)';
}

function updateBuilderFrequencyLock() {
    const type = document.getElementById('builder-equipment-type')?.value || 'radio';
    const input = document.getElementById('builder-frequency');
    const label = document.getElementById('builder-frequency-label');
    const note = document.getElementById('builder-frequency-note');
    if (!input || !label) return;
    const locked = frequencyLockedForEquipment(type);
    input.disabled = locked;
    if (note) note.style.display = locked ? 'block' : 'none';
    if (type === 'jammer') label.textContent = 'Target MHz';
    else if (type === 'receiver') label.textContent = 'Reference MHz';
    else label.textContent = 'Freq MHz';
}

function populateSidebarFromNode(type, node) {
    if (!node) return;
    const equipment = nodeEquipment(node, type);
    syncingSidebarFromNode = true;
    document.getElementById('freq_mhz').value = equipment.frequency_mhz;
    document.getElementById('rx_sensitivity').value = equipment.rx_sensitivity_dbm;
    document.getElementById('fh_toggle').checked = !!equipment.apply_fh;
    document.getElementById('enemy_bw_khz').value = equipment.channel_bw_khz;
    document.getElementById('jammer_bw_khz').value = equipment.jammer_bw_khz;
    updateFrequencyHoppingControls();
    if (type === 'red') {
        document.getElementById('enemy_tx_w').value = equipment.tx_power_w;
        document.getElementById('enemy_tx_gain').value = equipment.antenna_gain_dbi;
        document.getElementById('enemy_rx_gain').value = equipment.rx_gain_dbi;
    } else {
        document.getElementById('jammer_tx_w').value = equipment.tx_power_w;
        document.getElementById('jammer_tx_gain').value = equipment.antenna_gain_dbi;
        document.getElementById('friendly_rx_gain').value = equipment.rx_gain_dbi;
    }
    syncingSidebarFromNode = false;
    updateSidebarFrequencyLock(equipment.equipment_type);
    const status = document.getElementById('selected-node-status');
    if (status) status.textContent = `Editing ${type === 'red' ? 'Enemy' : 'Friendly'} ${node.name}: ${equipment.name || equipment.equipment_type}`;
}

function selectEquipmentNode(type, id) {
    const node = findNode(type, id);
    if (!node || (type !== 'red' && type !== 'blue')) return;
    selectedEquipmentNode = { type, id };
    populateSidebarFromNode(type, node);
}

function syncSelectedNodeFromSidebar(changedId) {
    if (syncingSidebarFromNode || !selectedEquipmentNode) return false;
    const node = findNode(selectedEquipmentNode.type, selectedEquipmentNode.id);
    if (!node) return false;
    const equipment = nodeEquipment(node, selectedEquipmentNode.type);
    if (changedId === 'freq_mhz') {
        if (frequencyLockedForEquipment(equipment.equipment_type)) return false;
        equipment.frequency_mhz = Number(document.getElementById('freq_mhz').value || equipment.frequency_mhz);
    }
    if (changedId === 'rx_sensitivity') equipment.rx_sensitivity_dbm = Number(document.getElementById('rx_sensitivity').value || equipment.rx_sensitivity_dbm);
    if (changedId === 'fh_toggle') equipment.apply_fh = !!document.getElementById('fh_toggle').checked;
    if (changedId === 'enemy_bw_khz') equipment.channel_bw_khz = Math.max(0.001, Number(document.getElementById('enemy_bw_khz').value || equipment.channel_bw_khz));
    if (changedId === 'jammer_bw_khz') equipment.jammer_bw_khz = Math.max(0.001, Number(document.getElementById('jammer_bw_khz').value || equipment.jammer_bw_khz));
    if (selectedEquipmentNode.type === 'red') {
        if (changedId === 'enemy_tx_w') equipment.tx_power_w = Number(document.getElementById('enemy_tx_w').value || equipment.tx_power_w);
        if (changedId === 'enemy_tx_gain') equipment.antenna_gain_dbi = Number(document.getElementById('enemy_tx_gain').value || equipment.antenna_gain_dbi);
        if (changedId === 'enemy_rx_gain') equipment.rx_gain_dbi = Number(document.getElementById('enemy_rx_gain').value || equipment.rx_gain_dbi);
    } else {
        if (changedId === 'jammer_tx_w') equipment.tx_power_w = Number(document.getElementById('jammer_tx_w').value || equipment.tx_power_w);
        if (changedId === 'jammer_tx_gain') equipment.antenna_gain_dbi = Number(document.getElementById('jammer_tx_gain').value || equipment.antenna_gain_dbi);
        if (changedId === 'friendly_rx_gain') equipment.rx_gain_dbi = Number(document.getElementById('friendly_rx_gain').value || equipment.rx_gain_dbi);
    }
    applyEquipmentToNode(node, equipment, selectedEquipmentNode.type);
    if (selectedEquipmentNode.type === 'red') bindRedPopup(node.id); else bindBluePopup(node.id);
    return true;
}

function renderLibraryControls() {
    const role = document.getElementById('library-role-select')?.value || 'red';
    const select = document.getElementById('library-template-select');
    if (!select) return;
    const previous = select.value;
    const templates = allNodeTemplates(role);
    select.innerHTML = ['<option value="">Select template...</option>'].concat(templates.map(template => {
        const source = template.built_in ? 'Built-in' : template.pack_name;
        return `<option value="${escapeHtml(template.key)}">${escapeHtml(template.name)} - ${escapeHtml(source)}</option>`;
    })).join('');
    if (templates.some(t => t.key === previous)) select.value = previous;
    renderLibraryDetails();
}

function renderLibraryDetails() {
    const template = findNodeTemplate(document.getElementById('library-template-select')?.value);
    const details = document.getElementById('library-template-details');
    const deleteBtn = document.getElementById('btn-delete-library-template');
    if (deleteBtn) deleteBtn.disabled = !template || template.built_in;
    if (!details) return;
    if (!template) {
        details.textContent = 'Select a template to place it on the map.';
        return;
    }
    details.innerHTML = `${escapeHtml(template.equipment_type)} | ${escapeHtml(template.frequency_mhz || '')} MHz | ${escapeHtml(template.tx_power_w || '')} W<br>${escapeHtml(template.notes || '')}`;
}

function saveUserLibrary() {
    saveUserProfilePacks();
    renderLibraryControls();
}

function scenarioProfileLibraryState() {
    return { packs: userProfilePacks.map(pack => ({ ...pack, profiles: undefined })) };
}

function saveBuilderTemplate() {
    const name = document.getElementById('builder-name').value.trim();
    if (!name) {
        libraryStatus('Template name is required.', true);
        return;
    }
    const roleValue = document.getElementById('builder-role-compatibility').value;
    const roles = roleValue === 'enemy' ? ['enemy'] : roleValue === 'friendly' ? ['friendly'] : ['enemy', 'friendly'];
    const template = {
        id: normalizeProfileId(name),
        name,
        role_compatibility: roles,
        equipment_type: document.getElementById('builder-equipment-type').value,
        frequency_mhz: Number(document.getElementById('builder-frequency').value),
        tx_power_w: Number(document.getElementById('builder-power').value),
        rx_sensitivity_dbm: Number(document.getElementById('builder-rx-sensitivity').value),
        antenna_gain_dbi: Number(document.getElementById('builder-antenna-gain').value),
        antenna_type: document.getElementById('builder-antenna-type').value,
        beamwidth_deg: Number(document.getElementById('builder-beamwidth').value),
        antenna_height_m: Number(document.getElementById('builder-height').value),
        apply_fh: document.getElementById('builder-apply-fh').value === 'true',
        channel_bw_khz: Number(document.getElementById('builder-channel-bw').value),
        jammer_bw_khz: Number(document.getElementById('builder-jammer-bw').value),
        notes: document.getElementById('builder-notes').value.trim()
    };
    const pack = userProfilePacks.find(p => p.pack_id === 'user-node-templates') || {
        schema_version: 2,
        pack_id: 'user-node-templates',
        pack_name: 'User Node Templates',
        templates: [],
        profiles: []
    };
    pack.templates = (pack.templates || []).filter(t => t.id !== template.id);
    pack.templates.push(template);
    const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
    const idx = userProfilePacks.findIndex(p => p.pack_id === normalized.pack_id);
    if (idx >= 0) userProfilePacks[idx] = normalized;
    else userProfilePacks.push(normalized);
    saveUserLibrary();
    markDirty('Library template saved.');
    libraryStatus('Template saved.');
}

function libraryStatus(message, isError = false) {
    const el = document.getElementById('library-status');
    if (!el) return;
    el.style.color = isError ? '#ff7777' : '#aaa';
    el.textContent = message || '';
}

function startLibraryPlacement() {
    const templateKey = document.getElementById('library-template-select')?.value;
    const role = document.getElementById('library-role-select')?.value || 'red';
    const template = findNodeTemplate(templateKey);
    if (!template) {
        libraryStatus('Select a template first.', true);
        return;
    }
    pendingLibraryPlacement = { team: role, templateKey };
    setMode(role === 'red' ? 'place-library-red' : 'place-library-blue');
    libraryStatus(`Click the map to place ${template.name}.`);
}

function exportUserLibrary() {
    const pack = {
        schema_version: 2,
        pack_id: 'specter-exported-node-templates',
        pack_name: 'SPECTER Exported Node Templates',
        templates: userProfilePacks.flatMap(pack => (pack.templates || []).map(template => ({
            ...template,
            id: normalizeProfileId(`${pack.pack_id}-${template.id}`)
        })))
    };
    try {
        const normalized = validateProfilePack(pack, { allowJammerProfiles: true });
        const blob = new Blob([JSON.stringify({ ...normalized, profiles: undefined }, null, 2) + '\n'], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'specter-node-library.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
        libraryStatus('Library exported.');
    } catch (e) {
        libraryStatus('No user templates to export.', true);
    }
}

function initEquipmentLibraryControls() {
    initProfileControls();
    document.querySelectorAll('.workbench-tab').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.workbench-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.workbench-tab-panel').forEach(panel => panel.classList.remove('active'));
            this.classList.add('active');
            document.getElementById(`tab-${this.dataset.workbenchTab}`)?.classList.add('active');
        });
    });
    document.getElementById('btn-about-support')?.addEventListener('click', () => {
        document.querySelector('.workbench-tab[data-workbench-tab="about"]')?.click();
    });
    document.getElementById('library-role-select')?.addEventListener('change', renderLibraryControls);
    document.getElementById('library-template-select')?.addEventListener('change', renderLibraryDetails);
    document.getElementById('builder-equipment-type')?.addEventListener('change', updateBuilderFrequencyLock);
    document.getElementById('btn-place-library-node')?.addEventListener('click', startLibraryPlacement);
    document.getElementById('btn-builder-save')?.addEventListener('click', saveBuilderTemplate);
    document.getElementById('btn-library-export')?.addEventListener('click', exportUserLibrary);
    document.getElementById('btn-library-import')?.addEventListener('click', () => document.getElementById('library-pack-input')?.click());
    document.getElementById('library-pack-input')?.addEventListener('change', function() {
        const file = this.files && this.files[0];
        this.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const pack = JSON.parse(reader.result);
                mergeUserProfilePacks([pack]);
                renderLibraryControls();
                markDirty('Library imported.');
                libraryStatus('Library imported.');
            } catch (e) {
                libraryStatus(e.message, true);
            }
        };
        reader.readAsText(file);
    });
    document.getElementById('btn-delete-library-template')?.addEventListener('click', function() {
        const template = findNodeTemplate(document.getElementById('library-template-select')?.value);
        if (!template || template.built_in) return;
        const pack = userProfilePacks.find(p => p.pack_id === template.pack_id);
        if (!pack) return;
        pack.templates = (pack.templates || []).filter(t => t.id !== template.id);
        pack.profiles = pack.templates;
        userProfilePacks = userProfilePacks.filter(p => (p.templates || []).length > 0);
        saveUserLibrary();
        markDirty('Library template deleted.');
        libraryStatus('Template deleted.');
    });
    profileLoadPromise?.then(renderLibraryControls);
    updateBuilderFrequencyLock();
    updateSidebarFrequencyLock('radio');
}

function makeEdgeLabel(polygonPoints, centerLat, centerLon, radiusM, text, offsetPx = [0, 0]) {
    let edgePt;
    if (polygonPoints && polygonPoints.length > 0) {
        edgePt = polygonPoints.reduce((a, b) => b[1] > a[1] ? b : a);
    } else {
        const lonOff = (radiusM / 1000) / (111.32 * Math.cos(centerLat * Math.PI / 180));
        edgePt = [centerLat, centerLon + lonOff];
    }
    return L.tooltip({ permanent: true, direction: 'right', className: 'dist-label', offset: offsetPx })
        .setLatLng(edgePt)
        .setContent(text)
        .addTo(map);
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
    const marker = L.marker(latlng, { icon: redIcon, draggable: true }).addTo(map);
    marker.on('click', function() { handleNodeClick('red', id); });
    const node = { id, name: id, marker, esActive: false, esCircle: null, esLabel: null, elevationM: null,
                   antennaType: 'omni', antennaAzimuth: 0, antennaBeamwidth: 90, antennaHeightAgl: 1.0 };
    if (template) node.name = libraryNodeName(template, id);
    applyEquipmentToNode(node, template ? equipmentFromTemplate(template) : equipmentFromSidebar('red'), 'red');
    marker.on('dragend', function() { fetchAndStoreElevation(node); markDirty('Node moved.'); recalculateAll(); });
    marker.on('popupclose', function() { bindRedPopup(id); });
    redNodes.push(node);
    bindRedPopup(id);
    updateMGRSTooltips();
    updateLinkAllBtn();
    fetchAndStoreElevation(node);
    selectEquipmentNode('red', id);
    markDirty('Enemy node added.');
}

function placeBlueNode(latlng, template = null) {
    blueCounter++;
    const id = 'B' + blueCounter;
    const marker = L.marker(latlng, { icon: blueIcon, draggable: true }).addTo(map);
    marker.on('click', function() { handleNodeClick('blue', id); });
    const node = { id, name: id, marker, elevationM: null,
                   antennaType: 'omni', antennaAzimuth: 0, antennaBeamwidth: 90, antennaHeightAgl: 1.0,
                   footprintActive: false, footprintCircle: null, fpLabel: null, footprintPolygonPoints: null };
    if (template) node.name = libraryNodeName(template, id);
    applyEquipmentToNode(node, template ? equipmentFromTemplate(template) : equipmentFromSidebar('blue'), 'blue');
    marker.on('dragend', function() { fetchAndStoreElevation(node); markDirty('Node moved.'); recalculateAll(); scheduleFootprintUpdate(); });
    marker.on('popupclose', function() { bindBluePopup(id); });
    blueNodes.push(node);
    bindBluePopup(id);
    updateMGRSTooltips();
    fetchAndStoreElevation(node);
    selectEquipmentNode('blue', id);
    markDirty('Friendly node added.');
}

function placeBlackNode(latlng) {
    blackCounter++;
    const id = 'M' + blackCounter;
    const marker = L.marker(latlng, { icon: blackIcon, draggable: true }).addTo(map);
    const node = { id, name: id, marker };
    marker.on('dragend', function() { markDirty('Marker moved.'); updateMGRSTooltips(); });
    marker.on('popupclose', function() { bindBlackPopup(id); });
    blackNodes.push(node);
    bindBlackPopup(id);
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
        mgrsInputSection('red', id, node) +
        antennaPopupSection('red', id, node),
        { minWidth: 180 }
    );
}

function bindBluePopup(id) {
    const node = findNode('blue', id);
    if (!node) return;
    const fpLabel = node.footprintActive ? '🚫 Hide Jammer Footprint' : '📡 Show Jammer Footprint';
    node.marker.bindPopup(
        `<b>Friendly Node ${node.name}</b><br>
        <button onclick="startJammingLink('${id}')">⚡ Link to Target</button><br>
        <button onclick="toggleNodeFootprint('${id}')">${fpLabel}</button><br>
        <button onclick="renameNode('blue','${id}')">✏️ Rename Node</button><br>
        <button onclick="removeNode('blue','${id}')">🗑️ Remove Node</button>` +
        mgrsInputSection('blue', id, node) +
        antennaPopupSection('blue', id, node),
        { minWidth: 180 }
    );
}

function bindBlackPopup(id) {
    const node = findNode('black', id);
    if (!node) return;
    node.marker.bindPopup(
        `<b>Marker ${node.name}</b><br>
        <button onclick="renameNode('black','${id}')">✏️ Rename</button><br>
        <button onclick="removeNode('black','${id}')">🗑️ Remove</button>` +
        mgrsInputSection('black', id, node),
        { minWidth: 180 }
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
    if (type === 'red') bindRedPopup(id);
    else if (type === 'blue') bindBluePopup(id);
    else bindBlackPopup(id);
    node.marker.openPopup();
    updateMGRSTooltips();
    renderResults();
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
    if (team === 'red') bindRedPopup(id); else bindBluePopup(id);
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
        if (type === 'red') bindRedPopup(id);
        else if (type === 'blue') bindBluePopup(id);
        else if (type === 'ep') bindEpPopup(id);
        else bindBlackPopup(id);
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
            if (node.esCircle) map.removeLayer(node.esCircle);
            if (node.esLabel) map.removeLayer(node.esLabel);
        }
        redNodes = redNodes.filter(n => n.id !== id);
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
            if (node.footprintCircle) map.removeLayer(node.footprintCircle);
            if (node.fpLabel) map.removeLayer(node.fpLabel);
        }
        blueNodes = blueNodes.filter(n => n.id !== id);
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
        updateSidebarFrequencyLock('radio');
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
    scheduleFootprintUpdate();
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
        // Include node coordinates so the backend can perform elevation-aware LOS analysis
        // and bearing-based directional antenna gain calculations
        const blue = findNode('blue', jLink.blueId);
        const rx   = findNode('red',  jLink.rxId);
        const tx   = findNode('red',  eLink.txId);
        const txEq = tx ? nodeEquipment(tx, 'red') : {};
        const rxEq = rx ? nodeEquipment(rx, 'red') : {};
        const blueEq = blue ? nodeEquipment(blue, 'blue') : {};
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
            enemy_dist_km: enemyDistKm,
            jammer_dist_km: jammerDistKm
        };
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
    blackNodes.forEach(function(node) {
        const latlng = node.marker.getLatLng();
        const mgrsStr = mgrs.forward([latlng.lng, latlng.lat]);
        node.marker.bindTooltip(`${node.name} — ${mgrsStr}`, {
            permanent: true, direction: 'top', className: 'mgrs-label'
        });
    });
    epNodes.forEach(function(node) {
        const latlng = node.marker.getLatLng();
        const mgrsStr = mgrs.forward([latlng.lng, latlng.lat]);
        node.marker.bindTooltip(`${node.name} — ${mgrsStr}`, {
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
        if (!suppressDirty) markDirty('Overlap overlay updated.');
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
    markDirty('Detection ring toggled.');
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
        if (!n.esActive && n.esLabel) { map.removeLayer(n.esLabel); n.esLabel = null; }
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
        const eq = nodeEquipment(node, 'red');
        const payload = {
            ...esParams,
            freq_mhz:            eq.frequency_mhz,
            enemy_tx_w:          eq.tx_power_w,
            enemy_tx_gain:       eq.antenna_gain_dbi,
            rx_sensitivity:      eq.rx_sensitivity_dbm,
            enemy_lat:           ll.lat,
            enemy_lon:           ll.lng,
            tx_antenna_type:     eq.antenna_type || node.antennaType,
            tx_azimuth_deg:      node.antennaAzimuth,
            tx_beamwidth_deg:    eq.beamwidth_deg || node.antennaBeamwidth,
            tx_antenna_height_m: eq.antenna_height_m || node.antennaHeightAgl,
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
            if (node.esLabel) { map.removeLayer(node.esLabel); node.esLabel = null; }

            if (data.polygon_points) {
                // Terrain-aware detection polygon
                node.esPolygonPoints = data.polygon_points;
                const label = `Detection: ~${data.base_range_km.toFixed(1)} km (terrain)`;
                node.esCircle = L.polygon(data.polygon_points, {
                    color: 'red', fillColor: '#f03', fillOpacity: 0.1, weight: 1
                }).addTo(map);
                node.esLabel = makeEdgeLabel(data.polygon_points, null, null, null, label);
            } else {
                // Fallback: uniform circle when elevation API is unavailable
                node.esPolygonPoints = circleToPolygon(ll.lat, ll.lng, data.base_range_km);
                const radiusMeters = data.base_range_km * 1000;
                const label = `Detection: ${data.base_range_km.toFixed(2)} km`;
                node.esCircle = L.circle(ll, {
                    color: 'red', fillColor: '#f03', fillOpacity: 0.1, radius: radiusMeters
                }).addTo(map);
                node.esLabel = makeEdgeLabel(null, ll.lat, ll.lng, radiusMeters, label);
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
// JAMMER FOOTPRINT
// ============================================================

window.toggleNodeFootprint = function(id) {
    const node = findNode('blue', id);
    if (!node) return;
    node.footprintActive = !node.footprintActive;
    if (!node.footprintActive && node.footprintCircle) {
        map.removeLayer(node.footprintCircle);
        node.footprintCircle = null;
        node.footprintPolygonPoints = null;
        if (node.fpLabel) { map.removeLayer(node.fpLabel); node.fpLabel = null; }
    }
    map.closePopup();
    bindBluePopup(id);
    markDirty('Jammer footprint toggled.');
    if (node.footprintActive) scheduleFootprintUpdate();
};

function scheduleFootprintUpdate() {
    clearTimeout(_fpDebounceTimer);
    _fpDebounceTimer = setTimeout(updateJammerFootprints, 300);
}

async function updateJammerFootprints() {
    blueNodes.forEach(n => {
        if (!n.footprintActive && n.footprintCircle) { map.removeLayer(n.footprintCircle); n.footprintCircle = null; }
        if (!n.footprintActive && n.fpLabel) { map.removeLayer(n.fpLabel); n.fpLabel = null; }
    });

    const activeNodes = blueNodes.filter(n => n.footprintActive);
    if (activeNodes.length === 0) return;

    activeNodes.forEach(node => {
        if (_fpAbortControllers[node.id]) _fpAbortControllers[node.id].abort();
        _fpAbortControllers[node.id] = new AbortController();
    });

    const fpParams = {
        freq_mhz:         document.getElementById('freq_mhz').value,
        jammer_terrain:   document.getElementById('jammer_terrain').value,
        jammer_tx_w:      document.getElementById('jammer_tx_w').value,
        jammer_tx_gain:   document.getElementById('jammer_tx_gain').value,
        rx_sensitivity:   document.getElementById('rx_sensitivity').value,
        friendly_rx_gain: document.getElementById('friendly_rx_gain').value,
    };

    for (const node of activeNodes) {
        const ll = node.marker.getLatLng();
        const eq = nodeEquipment(node, 'blue');
        const payload = {
            ...fpParams,
            freq_mhz:              eq.frequency_mhz,
            jammer_tx_w:           eq.tx_power_w,
            jammer_tx_gain:        eq.antenna_gain_dbi,
            rx_sensitivity:        eq.rx_sensitivity_dbm,
            jammer_lat:            ll.lat,
            jammer_lon:            ll.lng,
            jammer_antenna_type:   eq.antenna_type || node.antennaType,
            jammer_azimuth_deg:    node.antennaAzimuth,
            jammer_beamwidth_deg:  eq.beamwidth_deg || node.antennaBeamwidth,
            jammer_antenna_height_m: eq.antenna_height_m || node.antennaHeightAgl,
        };

        try {
            const r = await fetch('/calculate_jammer_footprint', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: _fpAbortControllers[node.id].signal
            });
            const data = await r.json();
            if (data.status !== 'success') continue;

            if (node.footprintCircle) map.removeLayer(node.footprintCircle);
            if (node.fpLabel) { map.removeLayer(node.fpLabel); node.fpLabel = null; }

            if (data.polygon_points) {
                node.footprintPolygonPoints = data.polygon_points;
                const label = `Jammer Coverage: ~${data.base_range_km.toFixed(1)} km (terrain)`;
                node.footprintCircle = L.polygon(data.polygon_points, {
                    color: '#00bcd4', fillColor: '#00bcd4', fillOpacity: 0.12, weight: 1
                }).addTo(map);
                node.fpLabel = makeEdgeLabel(data.polygon_points, null, null, null, label);
            } else {
                node.footprintPolygonPoints = circleToPolygon(ll.lat, ll.lng, data.base_range_km);
                const radiusMeters = data.base_range_km * 1000;
                const label = `Jammer Coverage: ${data.base_range_km.toFixed(2)} km`;
                node.footprintCircle = L.circle(ll, {
                    color: '#00bcd4', fillColor: '#00bcd4', fillOpacity: 0.12, radius: radiusMeters
                }).addTo(map);
                node.fpLabel = makeEdgeLabel(null, ll.lat, ll.lng, radiusMeters, label);
            }
        } catch (e) {
            if (e.name !== 'AbortError') { /* network error — leave existing footprint in place */ }
        }
    }
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

                html += `<tr class="jammer-sub-row ${rowClass}${jammerSel ? ' row-selected' : ''}"
                    onclick="selectLink('jammer', '${jLink.id}', '${eLink.id}')">
                    <td><button class="remove-link-btn" onclick="event.stopPropagation(); removeJammingLinkById('${jLink.id}')">✕</button></td>
                    <td>↳ ${getNodeDisplayName('blue', jLink.blueId)}</td>
                    <td>${margin}</td>
                    <td>${effect} ${losBadge}${enemyLosBadge}${terrainWarningBadge}</td>
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
document.getElementById('btn-ep-mode').addEventListener('click', toggleEpMode);

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
        if (s.layer) { map.removeLayer(s.layer); s.layer = null; }
        if (s.label) { map.removeLayer(s.label); s.label = null; }
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
    if (sys && sys.layer) map.removeLayer(sys.layer);
    if (sys && sys.label) map.removeLayer(sys.label);
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

map.on('click', function(e) {
    if      (activeMode === 'place-red')   placeRedNode(e.latlng);
    else if (activeMode === 'place-blue')  placeBlueNode(e.latlng);
    else if (activeMode === 'place-library-red' || activeMode === 'place-library-blue') {
        const template = findNodeTemplate(pendingLibraryPlacement?.templateKey);
        if (!template) return;
        if (activeMode === 'place-library-red') placeRedNode(e.latlng, template);
        else placeBlueNode(e.latlng, template);
        pendingLibraryPlacement = null;
        setMode(null);
    }
    else if (activeMode === 'place-black') placeBlackNode(e.latlng);
    else if (activeMode === 'place-ep')    placeEpNode(e.latlng);
});

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

// ============================================================
// WORKBENCH BUTTON EVENTS
// ============================================================

document.getElementById('btn-place-red').addEventListener('click',   () => setMode('place-red'));
document.getElementById('btn-place-blue').addEventListener('click',  () => setMode('place-blue'));
document.getElementById('btn-place-black').addEventListener('click', () => setMode('place-black'));
document.getElementById('btn-place-ep').addEventListener('click',    () => setMode('place-ep'));

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
document.getElementById('btn-clear-overlap').addEventListener('click', function() {
    clearOverlapLayer();
    markDirty('Overlap overlay cleared.');
});
document.getElementById('btn-toggle-corners').addEventListener('click', toggleCornerMarkers);

// ============================================================
// CLEAR ALL
// ============================================================

document.getElementById('clear-nodes-btn').addEventListener('click', function() {
    resetScenarioState();
    markDirty('Scenario cleared.');
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
            const allNodes = [...redNodes, ...blueNodes, ...blackNodes, ...epNodes];
            if (allNodes.length === 0) return;
            const circles = redNodes.filter(n => n.esCircle).map(n => n.esCircle);
            const bounds = L.latLngBounds([]);
            allNodes.forEach(n => bounds.extend(n.marker.getLatLng()));
            circles.forEach(c => bounds.extend(c.getBounds()));
            blueNodes.filter(n => n.footprintCircle).forEach(n => bounds.extend(n.footprintCircle.getBounds()));
            epNodes.forEach(n => n.systems.filter(s => s.layer).forEach(s => bounds.extend(s.layer.getBounds())));
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
    element.addEventListener('change', function() {
        if (this.closest('#workbench')) return;
        markDirty('Settings changed.');
        syncSelectedNodeFromSidebar(this.id);
        recalculateAll();
    });
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

function updateFrequencyHoppingControls() {
    const displayState = document.getElementById('fh_toggle').checked ? 'block' : 'none';
    document.getElementById('enemy_bw_container').style.display = displayState;
    document.getElementById('jammer_bw_container').style.display = displayState;
}

document.getElementById('fh_toggle').addEventListener('change', function() {
    updateFrequencyHoppingControls();
    syncSelectedNodeFromSidebar('fh_toggle');
    recalculateAll();
});
updateFrequencyHoppingControls();
initEquipmentLibraryControls();
initScenarioControls();

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

// ============================================================
// LOCAL DATA DIRECTORY PANEL (localhost only)
// ============================================================

(function initDataDirPanel() {
    fetch('/api/data_dir_status')
        .then(r => {
            if (!r.ok) return null;   // 403 for remote users — hide panel silently
            return r.json();
        })
        .then(status => {
            if (!status) return;

            const panel   = document.getElementById('data-dir-panel');
            const pathEl  = document.getElementById('data-dir-path');
            const statEl  = document.getElementById('data-dir-status');
            const input   = document.getElementById('data-dir-input');
            const applyBtn  = document.getElementById('data-dir-apply');
            const rescanBtn = document.getElementById('data-dir-rescan');
            const msgEl   = document.getElementById('data-dir-msg');

            panel.style.display = '';

            function renderStatus(s) {
                pathEl.textContent = s.path;
                statEl.textContent = `${s.dted_cells} DTED cells · ${s.imagery_files} imagery file(s)`;
                if (s.locked) {
                    input.style.display   = 'none';
                    applyBtn.style.display = 'none';
                    msgEl.style.color  = '#aaa';
                    msgEl.textContent  = 'Path locked by environment variable.';
                } else {
                    input.style.display    = '';
                    applyBtn.style.display = '';
                    input.value = s.path;
                    msgEl.textContent = '';
                }
            }

            renderStatus(status);

            applyBtn.addEventListener('click', function () {
                const newPath = input.value.trim();
                if (!newPath) return;
                applyBtn.disabled = true;
                msgEl.style.color = '#aaa';
                msgEl.textContent = 'Scanning…';
                fetch('/api/set_data_dir', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: newPath }),
                })
                .then(r => r.json())
                .then(result => {
                    applyBtn.disabled = false;
                    if (result.status === 'success') {
                        msgEl.style.color = '#66cc66';
                        msgEl.textContent = 'Applied.';
                        renderStatus(result);
                    } else {
                        msgEl.style.color = '#ff4444';
                        msgEl.textContent = result.message || 'Error applying path.';
                    }
                })
                .catch(() => {
                    applyBtn.disabled = false;
                    msgEl.style.color = '#ff4444';
                    msgEl.textContent = 'Request failed.';
                });
            });

            rescanBtn.addEventListener('click', function () {
                rescanBtn.disabled = true;
                msgEl.style.color  = '#aaa';
                msgEl.textContent  = 'Rescanning…';
                fetch('/api/rescan_data', { method: 'POST' })
                .then(r => r.json())
                .then(result => {
                    rescanBtn.disabled = false;
                    msgEl.style.color  = '#66cc66';
                    msgEl.textContent  = 'Rescan complete.';
                    renderStatus(result);
                })
                .catch(() => {
                    rescanBtn.disabled = false;
                    msgEl.style.color  = '#ff4444';
                    msgEl.textContent  = 'Rescan failed.';
                });
            });
        })
        .catch(() => {});  // network error — panel stays hidden
})();
