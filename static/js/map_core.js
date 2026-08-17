// Specter-EW — map core. Leaflet map/layers/icons, ALL shared mutable
// node/link/mode/EP state, generic helpers, and mode management.
// The only file besides app_init.js that runs meaningful top-level code
// (map creation). Loads second, right after scenario_schema.js.

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

let redNodes    = [];   // { id, marker }
let blueNodes   = [];   // { id, marker, sensorActive, sensorCoverages }
let blackNodes  = [];   // { id, name, marker } — reference-only markers
let enemyLinks  = [];   // { id, txId, rxId, line }
let jammingLinks = [];  // { id, blueId, rxId, line, result }

let activeMode = null;   // null | 'place-red' | 'place-blue' | 'place-black' | 'link-enemy' | 'link-jammer'
let linkSource = null;   // { color, id } — holds first node during two-step link creation
let selectedLink = null; // { type: 'enemy'|'jammer', enemyLinkId, jammingLinkId }
let redCounter   = 0;
let blueCounter  = 0;
let blackCounter = 0;
let selectedSensorNodeId = null;

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

// EP ring request management — epNodeId → AbortController for the in-flight
// calculateEpNode() run. Without this a node deleted mid-calculation leaves
// rings on the map that nothing holds a reference to any more.
const _epAbortControllers  = {};

// ============================================================
// SHARED RING HELPERS
// ============================================================

// Style shared by ES detection rings (red) and jammer footprints (cyan)
const RING_COLORS = {
    es:     { color: 'red',     fillColor: '#f03',    fillOpacity: 0.1  },
    jammer: { color: '#00bcd4', fillColor: '#00bcd4', fillOpacity: 0.12 },
};

// Monotonic per-node system index for red and EP nodes alike, so deleting a
// system never lets the next one collide with a surviving sibling's id or
// palette colour. Returns a 1-based index; ids are `<nodeId>_S<index>`.
function nextSystemIndex(node) {
    const used = (node.systems || []).map(sys => {
        const m = /_S(\d+)$/.exec(sys.id || '');
        return m ? Number(m[1]) : 0;
    });
    return Math.max(0, ...used) + 1;
}

// Remove Leaflet layers stored on an object and null the references
function removeLayerRef(obj, ...keys) {
    keys.forEach(key => {
        if (obj[key]) { map.removeLayer(obj[key]); obj[key] = null; }
    });
}

// ============================================================
// EP MODE DATA
// ============================================================

const epNodes    = [];
const EP_COLORS  = ['#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bfff'];
let epNodeCounter = 0;
let epModeActive  = false;

// Palette for red-node extra system rings. Warm hues, deliberately distinct from
// EP_COLORS (blues/greens) and from the primary ES ring red (RING_COLORS.es).
const RED_SYSTEM_COLORS = ['#ff7043','#ffb300','#d81b60','#8e24aa',
                           '#c62828','#ff5252','#ad1457','#ef6c00'];

const DEFAULT_GENERIC_FRIENDLY_SENSOR_SENSITIVITY_DBM = -100;

function activeBaseLayerName() {
    if (map.hasLayer(streetLayer)) return 'Streets';
    return 'Satellite';
}

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

function setMobileResult(margin, effect) {
    document.getElementById('mobile-margin').textContent = margin;
    document.getElementById('mobile-effect').textContent = effect;
}
