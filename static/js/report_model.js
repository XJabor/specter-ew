// Specter-EW — report model (pure logic, no DOM/Leaflet).
// Loaded after calc_results.js; also loadable in Node for unit tests.
//
//   buildReportData(snapshot) -> report     (allowlist: only named fields of
//                                            the snapshot ever reach the report)
//   renderReportHtml(report)  -> string     (self-contained, print-friendly)
//
// The snapshot is plain data gathered by report.js from live app state; see
// gatherReportSnapshot() there for its shape. Nothing in this file reads
// cookies, storage, globals, or the environment, which is what keeps auth
// material and local paths out of reports by construction.
(function () {
'use strict';

const _R = (typeof module !== 'undefined' && module.exports)
    ? require('./calc_results.js')
    : window.SpecterResults;

const REPORT_DISCLAIMER =
    'Results are planning estimates produced by empirical and simplified physical propagation ' +
    'models. They represent median expectations, not guarantees: real-world signal levels ' +
    'commonly vary by ±10 dB or more with local terrain, vegetation, structures, weather, ' +
    'equipment condition, and operator technique. Validate critical results in the field ' +
    'before operational use.';

const REPORT_SUPPORT = {
    license: 'GNU AGPL-3.0',
    source: 'https://github.com/XJabor/specter-ew',
    support: 'contact@specter-ew.com',
};

const REPORT_ASSUMPTIONS = [
    'Path loss is routed by frequency, antenna height, terrain setting and line of sight: Egli below 1 GHz for low antennas; Two-Ray (line of sight) or COST-231 Hata (obstructed) when the transmitter is at least 30 m high and at 150 MHz or above; plane-earth two-ray loss plus a flat clutter correction at 1–2 GHz with low antennas; plane-earth two-ray loss plus foliage absorption above 2 GHz; pure free-space loss when terrain is set to "Free space".',
    'Every model is floored at free-space loss. Detection ranges are the exact inverse of the path-loss model, including that floor.',
    'Terrain correction is flat: rural/open +0 dB, light forest/suburban +8 dB, dense forest/urban +20 dB (Egli and 1–2 GHz branches). Above 2 GHz, foliage absorption grows with distance (2 or 5 dB per GHz·km) and a 5/10 dB canopy penalty applies when either antenna is below 5 m in vegetation.',
    'Terrain heights come from local DTED Level 2 where available, otherwise the online SRTM 30 m service. Obstructed paths add dominant-obstacle knife-edge diffraction loss (ITU-R P.526) using a 4/3-earth radius; above 2 GHz that value is applied as a blockage penalty.',
    'Detection rings and jammer footprints walk the terrain profile outward on each bearing to the range where received power falls to the reference threshold. The receiver antenna height is the friendly node’s own antenna height for sensor-coverage rings, the selected sensor’s height (or the generic sensor height setting) for enemy detection and enemy-system rings, and the reference receiver height settings for jammer footprints and EP rings; heights below 1 m are treated as 1 m. Ring labels on the map show the flat-terrain line-of-sight range.',
    'Directional antennas use a Gaussian main-lobe approximation of the stated half-power beamwidth.',
    'J/S margin is jamming power minus enemy signal power at the target receiver. The capture-effect thresholds listed under Settings classify it as No Effect, Contested (warbling/popcorn), or Complete Jamming.',
    'Frequency-hopping tax reduces jammer EIRP by 10·log10(jammer sweep bandwidth ÷ target channel bandwidth).',
];

const REPORT_LIMITATIONS = [
    'Models do not include multipath fading, atmospheric ducting, ionospheric propagation, rain fade, building-level clutter, or co-channel interference other than the modelled jammer.',
    'Terrain is sampled at 11–25 points per path, so narrow ridges or gaps between samples can be missed.',
    'Switching between propagation models at 150 MHz, 30 m mast height, 1 GHz and 2 GHz can produce step changes in predicted loss. The largest is at 1 GHz for low antennas: about 28 dB less loss just above 1 GHz, where Egli’s empirical (f/40)² terrain factor gives way to the physical two-ray model.',
    'COST-231 Hata is used below its published 1500–2000 MHz range as the elevated-transmitter obstructed-path model.',
    'Results beyond about 50 km are less reliable; the radio horizon is applied only where noted.',
];

// ── Small helpers ──────────────────────────────────────────────────────────

function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function str(v, max = 120) {
    return v == null ? '' : String(v).slice(0, max);
}

function num(v) {
    return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
}

function fmtLatLon(lat, lon) {
    if (num(lat) == null || num(lon) == null) return '—';
    return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
}

function fmtTimestamp(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return str(iso, 40);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function equipmentSummary(eq) {
    if (!eq) return '—';
    const type = str(eq.equipment_type, 20) || 'equipment';
    const parts = [type.charAt(0).toUpperCase() + type.slice(1)];
    if (num(eq.tx_power_w) != null && type !== 'receiver') parts.push(_R.fmtWatts(eq.tx_power_w));
    if (num(eq.antenna_gain_dbi) != null) parts.push(_R.fmtDbi(eq.antenna_gain_dbi));
    if (num(eq.rx_sensitivity_dbm) != null && type !== 'jammer') parts.push(`Rx ${_R.fmtDbm(eq.rx_sensitivity_dbm)}`);
    if (type === 'jammer' && num(eq.jammer_bw_khz) != null) parts.push(`${_R.fmtNum(eq.jammer_bw_khz, 0)} kHz sweep`);
    if (type === 'radio' && eq.apply_fh) parts.push(`FH, ${_R.fmtNum(eq.channel_bw_khz, 1)} kHz ch.`);
    const name = str(eq.name, 60);
    return (name ? `${name} — ` : '') + parts.join(' · ');
}

function antennaSummary(a) {
    if (!a) return '—';
    return _R.antennaText({ type: a.type, azimuth_deg: a.azimuth_deg, beamwidth_deg: a.beamwidth_deg, height_m: a.height_m });
}

function systemAntenna(sys) {
    return _R.antennaText({
        type: sys.antennaType, azimuth_deg: sys.antennaAzimuth,
        beamwidth_deg: sys.antennaBeamwidth, height_m: sys.antennaHeightAgl,
    });
}

// ── Report data ────────────────────────────────────────────────────────────

function nodeRows(nodes) {
    const rows = [];
    const add = (role, n, extra = {}) => rows.push({
        role,
        id: str(n.id, 20),
        name: str(n.name, 40),
        mgrs: str(n.mgrs, 30) || '—',
        latlon: fmtLatLon(n.lat, n.lon),
        elevation: num(n.elevationM) != null ? `${Math.round(n.elevationM)} m` : '—',
        frequency: extra.frequency ?? (n.equipment ? _R.fmtMhz(n.equipment.frequency_mhz) : '—'),
        equipment: extra.equipment ?? equipmentSummary(n.equipment),
        antenna: extra.antenna ?? antennaSummary(n.antenna),
    });
    (nodes?.red || []).forEach(n => add('Enemy', n));
    (nodes?.blue || []).forEach(n => add('Friendly', n));
    (nodes?.ep || []).forEach(n => add('EP', n, {
        frequency: `${(n.systems || []).length} system(s)`, equipment: 'EP emitter group', antenna: '—',
    }));
    (nodes?.black || []).forEach(n => add('Marker', n, { frequency: '—', equipment: 'Reference only', antenna: '—' }));
    return rows;
}

function nodeName(nodes, type, id) {
    const n = (nodes?.[type] || []).find(x => x.id === id);
    return n ? str(n.name, 40) : str(id, 20);
}

function refreshSubjectNames(record, nodes) {
    // Records capture names at calculation time; report with the current ones.
    const s = record.subject || {};
    const fix = (who, type) => who && { ...who, name: nodeName(nodes, type, who.id) };
    const subject = { ...s };
    if (record.kind === 'ea-link') {
        subject.jammer = fix(s.jammer, 'blue');
        subject.target = fix(s.target, 'red');
        subject.transmitter = fix(s.transmitter, 'red');
    } else if (record.kind === 'ep-system') {
        subject.node = fix(s.node, 'ep');
    } else if (record.kind === 'jammer-footprint') {
        subject.node = fix(s.node, 'blue');
    } else {
        subject.node = fix(s.node, 'red');
    }
    if (s.sensor) {
        subject.sensor = s.sensor.id ? fix(s.sensor, 'blue') : { name: str(s.sensor.name, 40) };
    }
    if (subject.system) {
        const owner = (nodes?.[record.kind === 'ep-system' ? 'ep' : 'red'] || []).find(n => n.id === s.node?.id);
        const live = (owner?.systems || []).find(x => x.id === subject.system.id);
        subject.system = { id: subject.system.id, name: str(live ? live.name : subject.system.name, 40) };
    }
    return { ...record, subject };
}

const SOURCE_LABELS = {
    local: 'Local DTED', remote: 'Online SRTM', mixed: 'Local + online',
    fallback: 'Unavailable (flat fallback)', none: 'Not used', unknown: 'Not recorded',
};

function modelsText(record) {
    const usage = _R.recordModelUsage(record);
    const ids = Object.keys(usage);
    return ids.length ? ids.map(_R.modelName).join(', ') : '—';
}

function buildReportData(snapshot) {
    const snap = snapshot || {};
    const nodes = snap.nodes || {};
    const legacy = snap.legacySchema && num(snap.legacySchema.from) != null
        ? { from: num(snap.legacySchema.from), to: num(snap.legacySchema.to) } : null;

    const results = (snap.results || [])
        .filter(r => r && r.record && (r.record.kind === 'ea-link' || _R.FOOTPRINT_KINDS.includes(r.record.kind)))
        .map(r => ({ record: refreshSubjectNames(r.record, nodes), stale: !!r.stale }));

    const described = results.map(({ record, stale }) => ({
        record, stale, view: _R.describeResult(record, { stale, legacySchema: legacy }),
    }));

    const linkRows = described.filter(d => d.record.kind === 'ea-link').map(({ record, stale, view }) => ({
        id: str(record.id, 60),
        jammer: record.subject.jammer?.name || '—',
        transmitter: record.subject.transmitter?.name || '—',
        target: record.subject.target?.name || '—',
        frequency: _R.fmtMhz(record.diagnostics?.freq_mhz ?? record.request?.freq_mhz),
        jammerDistance: _R.fmtKm(record.diagnostics?.jammer?.distance_km ?? record.request?.jammer_dist_km),
        enemyDistance: _R.fmtKm(record.diagnostics?.enemy?.distance_km ?? record.request?.enemy_dist_km),
        jammerRx: _R.fmtDbm(record.diagnostics?.jammer?.rx_dbm),
        enemyRx: _R.fmtDbm(record.diagnostics?.enemy?.rx_dbm),
        margin: _R.fmtSignedDb(record.margin, 1),
        assessment: str(record.effect, 80) || '—',
        classification: record.classification,
        models: modelsText(record),
        terrain: SOURCE_LABELS[_R.recordElevationSource(record)],
        stale,
        warnings: view.warnings.length,
    }));

    const ringRows = described.filter(d => d.record.kind !== 'ea-link').map(({ record, stale, view }) => ({
        id: str(record.id, 60),
        kind: _R.RESULT_KIND_LABELS[record.kind],
        subject: view.title,
        frequency: _R.fmtMhz(record.diagnostics?.freq_mhz ?? record.request?.freq_mhz),
        threshold: _R.fmtDbm(record.diagnostics?.rx_sensitivity_dbm ?? record.request?.rx_sensitivity),
        median: _R.fmtKm(record.ranges?.median_km, 1),
        spread: record.ranges ? `${_R.fmtNum(record.ranges.min_km, 1)}–${_R.fmtNum(record.ranges.max_km, 1)} km` : '—',
        label: _R.fmtKm(record.rangeKm, 1),
        sampling: record.diagnostics
            ? (record.polygonFallback ? 'Circle' : `${record.diagnostics.num_bearings}×${record.diagnostics.num_samples}`)
            : '—',
        models: modelsText(record),
        terrain: SOURCE_LABELS[_R.recordElevationSource(record)],
        stale,
        warnings: view.warnings.length,
    }));

    const commsRows = (snap.enemyLinks || []).map(l => {
        const tx = (nodes.red || []).find(n => n.id === l.txId);
        return {
            id: str(l.id, 60),
            transmitter: nodeName(nodes, 'red', l.txId),
            receiver: nodeName(nodes, 'red', l.rxId),
            frequency: tx?.equipment ? _R.fmtMhz(tx.equipment.frequency_mhz) : '—',
            distance: _R.fmtKm(l.distanceKm),
            jammers: (snap.jammingLinks || []).filter(j => j.rxId === l.rxId).length,
        };
    });

    const systemRow = (node, sys, kind) => {
        const hit = described.find(d => d.record.kind === kind && d.record.subject?.system?.id === sys.id);
        return {
            node: str(node.name, 40),
            system: str(sys.name, 40),
            frequency: _R.fmtMhz(sys.freqMhz),
            power: _R.fmtWatts(sys.txPowerW),
            gain: _R.fmtDbi(sys.txGainDbi),
            antenna: systemAntenna(sys),
            range: hit?.record.ranges
                ? `${_R.fmtKm(hit.record.ranges.median_km, 1)} (${_R.fmtNum(hit.record.ranges.min_km, 1)}–${_R.fmtNum(hit.record.ranges.max_km, 1)})`
                : 'Not calculated',
            hidden: kind === 'ep-system' && !!node.ringsHidden,
            stale: !!hit?.stale,
        };
    };
    const epRows = (nodes.ep || []).flatMap(n => (n.systems || []).map(s => systemRow(n, s, 'ep-system')));
    const enemySystemRows = (nodes.red || []).flatMap(n => (n.systems || []).map(s => systemRow(n, s, 'red-system')));

    const st = snap.settings || {};
    const sensor = st.sensorReference || {};
    const settingsRows = [
        ['Enemy-to-enemy terrain', _R.terrainLabel(st.enemyTerrain)],
        ['Jammer-to-target terrain', _R.terrainLabel(st.jammerTerrain)],
        ['Capture thresholds', `No effect ≤ ${_R.fmtSignedDb(st.lowerThreshold)} · Complete jamming ≥ ${_R.fmtSignedDb(st.upperThreshold)}`],
        ['ES ring reference sensor', `${str(sensor.name, 40) || '—'} (${_R.fmtDbm(sensor.rxSensitivityDbm)}, ${_R.fmtDbi(sensor.rxGainDbi)})`],
        ['Generic sensor height', `${_R.fmtNum(st.sensorHeightM, 1)} m AGL`],
        ['Jammer footprint threshold', _R.fmtDbm(st.footprintRxSensitivity)],
        ['Footprint reference receiver height', `${_R.fmtNum(st.footprintRxHeightM, 1)} m AGL`],
        ['EP terrain', _R.terrainLabel(st.epTerrain)],
        ['EP enemy receiver sensitivity', _R.fmtDbm(st.epRxSensitivity)],
        ['EP enemy receiver height', `${_R.fmtNum(st.epRxHeightM, 1)} m AGL`],
        ['Workbench mode at export', snap.mode === 'EP' ? 'EP' : 'EA / ES'],
    ].map(([label, value]) => ({ label, value }));

    // Model branch summary across every result.
    const modelUse = {};
    described.forEach(({ record }) => {
        Object.entries(_R.recordModelUsage(record)).forEach(([m]) => {
            modelUse[m] = modelUse[m] || { links: 0, rings: 0 };
            if (record.kind === 'ea-link') modelUse[m].links++;
            else modelUse[m].rings++;
        });
    });
    const modelSummary = Object.entries(modelUse).map(([id, use]) => ({
        id,
        name: _R.modelName(id),
        summary: _R.MODEL_INFO[id]?.summary || '',
        validity: _R.MODEL_INFO[id]?.validity || '',
        usedBy: [use.links && `${use.links} link(s)`, use.rings && `${use.rings} ring(s)`].filter(Boolean).join(', '),
    }));

    const coverage = { local: 0, remote: 0, mixed: 0, fallback: 0, none: 0, unknown: 0, highRes: 0, standardRes: 0 };
    described.forEach(({ record }) => {
        coverage[_R.recordElevationSource(record)]++;
        const d = record.diagnostics;
        if (record.kind !== 'ea-link' && d && !record.polygonFallback) {
            if (d.locally_covered) coverage.highRes++;
            else coverage.standardRes++;
        }
    });

    const warnings = [];
    const pushWarning = (level, text, source) => {
        if (!warnings.find(w => w.text === text && w.source === source)) warnings.push({ level, text, source });
    };
    if (legacy) {
        pushWarning('info', `Scenario was loaded from schema v${legacy.from} and migrated to v${legacy.to}; all results were recalculated with the current model (v${str(snap.appVersion, 20)}).`, 'Scenario');
    }
    described.forEach(({ view }) => view.warnings
        .filter(w => w.code !== 'legacy-schema')
        .forEach(w => pushWarning(w.level, w.text, view.title)));
    const uncalculated = [...epRows, ...enemySystemRows].filter(r => r.range === 'Not calculated').length;
    if (uncalculated) pushWarning('info', `${uncalculated} EP/enemy system(s) have no calculated ring and are listed without a range.`, 'Systems');
    const pending = (snap.jammingLinks || []).filter(j => !linkRows.find(r => r.id.startsWith(`${j.id}|`))).length;
    if (pending) pushWarning('warn', `${pending} jamming link(s) have no J/S result (no enemy comms link to the target, or calculation pending).`, 'Links');

    const overlap = snap.overlap || {};

    return {
        meta: {
            title: str(snap.title, 120) || str(snap.scenarioName, 80) || 'Untitled scenario',
            scenarioName: str(snap.scenarioName, 80) || 'Untitled scenario',
            appVersion: str(snap.appVersion, 20),
            generatedAt: str(snap.generatedAt, 40),
            generatedAtText: fmtTimestamp(snap.generatedAt),
            marking: str(snap.marking, 80),
            schemaVersion: num(snap.schemaVersion),
        },
        counts: {
            nodes: nodeRows(nodes).length,
            links: linkRows.length,
            rings: ringRows.length,
            warnings: warnings.filter(w => w.level === 'warn').length,
        },
        nodeRows: nodeRows(nodes),
        commsRows,
        linkRows,
        ringRows,
        epRows,
        enemySystemRows,
        settingsRows,
        modelSummary,
        coverage,
        overlap: {
            visible: !!overlap.visible,
            zones: num(overlap.zones) || 0,
            selected: (overlap.selected || []).map(s => str(s, 80)),
        },
        warnings,
        details: described.map(({ record, view }) => ({ id: str(record.id, 60), view })),
        assumptions: REPORT_ASSUMPTIONS.slice(),
        limitations: REPORT_LIMITATIONS.slice(),
        disclaimer: REPORT_DISCLAIMER,
        support: { ...REPORT_SUPPORT },
        map: buildMapModel(snap),
        basemap: safeBasemap(snap.basemap),
    };
}

// ── Map (SVG schematic) ────────────────────────────────────────────────────

const MAP_W = 960;
const MAP_H = 560;
const MAP_PAD = 36;
const KM_PER_DEG = 111.32;

const NODE_COLORS = { red: '#d32f2f', blue: '#1e6fd9', black: '#333333', ep: '#27ae60' };
const LINK_TONES = { complete: '#2e7d32', contested: '#ef6c00', none: '#c62828', unknown: '#8a8a8a' };

function circlePoints(center, radiusKm, n = 48) {
    const [lat, lon] = center;
    const cos = Math.cos(lat * Math.PI / 180) || 1e-6;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const b = (2 * Math.PI * i) / n;
        pts.push([lat + (radiusKm * Math.cos(b)) / KM_PER_DEG, lon + (radiusKm * Math.sin(b)) / (KM_PER_DEG * cos)]);
    }
    return pts;
}

function safeColor(c, fallback) {
    return /^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? c : fallback;
}

function buildMapModel(snap) {
    const nodes = snap.nodes || {};
    const points = [];
    const markers = [];
    // Unwrap longitudes relative to the first node so a layout straddling the
    // antimeridian (179°E / 179°W) stays contiguous instead of spanning the globe.
    let refLon = null;
    const unwrap = lon => (refLon == null ? lon : refLon + ((((lon - refLon) % 360) + 540) % 360) - 180);
    ['red', 'blue', 'black', 'ep'].forEach(type => (nodes[type] || []).forEach(n => {
        if (num(n.lat) == null || num(n.lon) == null) return;
        if (refLon == null) refLon = Number(n.lon);
        const lon = unwrap(Number(n.lon));
        markers.push({ type, lat: Number(n.lat), lon, name: str(n.name, 40) });
        points.push([Number(n.lat), lon]);
    }));
    if (markers.length === 0) return null;
    const ll = p => [Number(p[0]), unwrap(Number(p[1]))];

    const shapes = (snap.shapes || []).map(s => {
        const pts = Array.isArray(s.points) && s.points.length >= 3
            ? s.points.filter(p => num(p?.[0]) != null && num(p?.[1]) != null).map(ll)
            : (s.center && num(s.radiusKm) ? circlePoints(ll(s.center), Number(s.radiusKm)) : []);
        return { kind: s.kind === 'overlap' ? 'overlap' : 'ring', color: safeColor(s.color, '#888888'), points: pts };
    }).filter(s => s.points.length >= 3);

    // Frame the nodes plus ring geometry near them. A ring far larger than
    // the node layout (e.g. a free-space ring hundreds of km across) is left
    // to clip at the frame edge instead of shrinking every node to a dot.
    const nLat = points.reduce((s, p) => s + p[0], 0) / points.length;
    const nLon = points.reduce((s, p) => s + p[1], 0) / points.length;
    const nCos = Math.cos(nLat * Math.PI / 180) || 1e-6;
    const kmFromCentroid = p => Math.hypot((p[0] - nLat) * KM_PER_DEG, (p[1] - nLon) * KM_PER_DEG * nCos);
    const nodeSpread = Math.max(...points.map(kmFromCentroid));
    const frameKm = Math.max(3 * nodeSpread, 10);
    let clipped = false;
    shapes.forEach(s => s.points.forEach(p => {
        if (kmFromCentroid(p) <= frameKm) points.push(p);
        else clipped = true;
    }));

    const find = (type, id) => (nodes[type] || []).find(n => n.id === id);
    const lines = [];
    (snap.enemyLinks || []).forEach(l => {
        const a = find('red', l.txId), b = find('red', l.rxId);
        if (a && b) lines.push({ kind: 'enemy', a: ll([a.lat, a.lon]), b: ll([b.lat, b.lon]), color: '#c62828' });
    });
    (snap.jammingLinks || []).forEach(l => {
        const a = find('blue', l.blueId), b = find('red', l.rxId);
        if (!a || !b) return;
        const tone = (snap.results || [])
            .map(r => r?.record)
            .filter(r => r?.kind === 'ea-link' && r.subject?.jammer?.id === l.blueId && r.subject?.target?.id === l.rxId)
            .reduce((best, r) => (best == null || Number(r.margin) > Number(best.margin) ? r : best), null);
        lines.push({ kind: 'jammer', a: ll([a.lat, a.lon]), b: ll([b.lat, b.lon]),
            color: LINK_TONES[tone?.classification || 'unknown'] });
    });

    // Web Mercator, the projection map tiles use, so an imagery basemap drawn
    // from mercator.{cx, cy, scale} lines up exactly with the vectors.
    const ws = points.map(mercatorWorld);
    const minX = Math.min(...ws.map(w => w[0])), maxX = Math.max(...ws.map(w => w[0]));
    const minY = Math.min(...ws.map(w => w[1])), maxY = Math.max(...ws.map(w => w[1]));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const lat0 = mercatorLat(cy);
    const kmPerWorld = EARTH_CIRCUMFERENCE_KM * (Math.cos(lat0 * Math.PI / 180) || 1e-6);
    const minSpan = 0.5 / kmPerWorld;  // never zoom in past ~0.5 km across
    const scale = Math.min((MAP_W - 2 * MAP_PAD) / Math.max(minSpan, maxX - minX),
                           (MAP_H - 2 * MAP_PAD) / Math.max(minSpan, maxY - minY)); // px per world unit
    const project = p => {
        const [x, y] = mercatorWorld(p);
        return [MAP_W / 2 + (x - cx) * scale, MAP_H / 2 + (y - cy) * scale];
    };
    const pxPerKm = scale / kmPerWorld;

    // Scale bar: largest 1/2/5×10^n km that fits in a quarter of the width.
    const maxKm = (MAP_W / 4) / pxPerKm;
    const pow = Math.pow(10, Math.floor(Math.log10(maxKm)));
    const barKm = [5, 2, 1].map(m => m * pow).find(v => v <= maxKm) || pow;

    return {
        width: MAP_W,
        height: MAP_H,
        shapes: shapes.map(s => ({ ...s, points: s.points.map(project) })),
        lines: lines.map(l => ({ ...l, a: project(l.a), b: project(l.b) })),
        markers: markers.map(m => ({ ...m, xy: project([m.lat, m.lon]) })),
        scaleBar: { km: barKm, px: barKm * pxPerKm },
        mercator: { cx, cy, scale },
        clipped,
    };
}

const EARTH_CIRCUMFERENCE_KM = 40075.017;

// [lat, lon] -> Web Mercator world coordinates in [0, 1] (y grows southward).
function mercatorWorld([lat, lon]) {
    const phi = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
    return [(lon + 180) / 360, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2];
}

function mercatorLat(y) {
    return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}

// Tiles covering a map model's frame at a given pixel ratio: the zoom whose
// tile pixels are at least as fine as the output (fewer zooms if that would
// exceed maxTiles), and where each tile lands on the output canvas.
function basemapTilePlan(model, { pixelRatio = 2, maxZoom = 18, maxTiles = 64 } = {}) {
    const { cx, cy, scale } = model.mercator;
    const W = model.width * pixelRatio, H = model.height * pixelRatio;
    const worldPx = scale * pixelRatio;                 // canvas px per world unit
    const left = cx - (W / 2) / worldPx, top = cy - (H / 2) / worldPx;
    const right = cx + (W / 2) / worldPx, bottom = cy + (H / 2) / worldPx;
    let z = Math.max(0, Math.min(maxZoom, Math.ceil(Math.log2(worldPx / 256))));
    for (;;) {
        const n = 2 ** z;
        const x0 = Math.floor(left * n), x1 = Math.floor(right * n);
        const y0 = Math.max(0, Math.floor(top * n)), y1 = Math.min(n - 1, Math.floor(bottom * n));
        const count = (x1 - x0 + 1) * (y1 - y0 + 1);
        if (count <= maxTiles || z === 0) {
            const size = worldPx / n;
            const tiles = [];
            for (let ty = y0; ty <= y1; ty++) {
                for (let tx = x0; tx <= x1; tx++) {
                    tiles.push({ z, x: ((tx % n) + n) % n, y: ty,
                        dx: (tx / n - left) * worldPx, dy: (ty / n - top) * worldPx, size });
                }
            }
            return { width: W, height: H, zoom: z, tiles };
        }
        z--;
    }
}

const BASEMAP_HREF = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/;

// Only an inline raster produced by report.js is accepted, never a URL.
function safeBasemap(basemap) {
    if (!basemap || !BASEMAP_HREF.test(String(basemap.href || ''))) return null;
    return { href: basemap.href, attribution: str(basemap.attribution, 200) };
}

function renderMapSvg(model, basemap = null) {
    if (!model) return '<p class="muted">No nodes placed.</p>';
    const f = v => Number(v).toFixed(1);
    const bm = safeBasemap(basemap);
    const parts = [`<svg class="map${bm ? ' imagery' : ''}" viewBox="0 0 ${model.width} ${model.height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scenario map" overflow="hidden">`];
    parts.push(`<rect width="${model.width}" height="${model.height}" fill="#f6f7f4" stroke="#c9ccc4"/>`);
    if (bm) {
        parts.push(`<image href="${bm.href}" x="0" y="0" width="${model.width}" height="${model.height}" preserveAspectRatio="none"/>`);
    }
    model.shapes.forEach(s => {
        const d = s.points.map(p => `${f(p[0])},${f(p[1])}`).join(' ');
        parts.push(s.kind === 'overlap'
            ? `<polygon points="${d}" fill="#f2d600" fill-opacity="0.45" stroke="#b39c00" stroke-width="1.5"/>`
            : `<polygon points="${d}" fill="${s.color}" fill-opacity="0.12" stroke="${s.color}" stroke-width="1.2"/>`);
    });
    model.lines.forEach(l => parts.push(
        `<line class="link-${l.kind}" x1="${f(l.a[0])}" y1="${f(l.a[1])}" x2="${f(l.b[0])}" y2="${f(l.b[1])}" stroke="${l.color}" stroke-width="${l.kind === 'jammer' ? 3 : 1.6}"${l.kind === 'enemy' ? ' stroke-dasharray="6 4"' : ''}/>`));
    model.markers.forEach(m => {
        const [x, y] = m.xy;
        const color = NODE_COLORS[m.type] || '#333';
        parts.push(m.type === 'black'
            ? `<rect x="${f(x - 4)}" y="${f(y - 4)}" width="8" height="8" fill="${color}"/>`
            : `<circle cx="${f(x)}" cy="${f(y)}" r="5.5" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
        parts.push(`<text x="${f(x + 8)}" y="${f(y - 7)}" class="lbl">${esc(m.name)}</text>`);
    });
    const sb = model.scaleBar;
    const y0 = model.height - 18;
    if (bm) {
        // Light backing so the black scale bar and north arrow read on imagery.
        parts.push(`<rect x="12" y="${y0 - 24}" width="${f(sb.px + 18)}" height="34" rx="3" fill="#fff" fill-opacity="0.8"/>`);
        parts.push(`<rect x="${model.width - 42}" y="8" width="28" height="46" rx="3" fill="#fff" fill-opacity="0.8"/>`);
    }
    parts.push(`<g class="scale"><line x1="20" y1="${y0}" x2="${f(20 + sb.px)}" y2="${y0}" stroke="#222" stroke-width="2"/>` +
        `<line x1="20" y1="${y0 - 5}" x2="20" y2="${y0 + 5}" stroke="#222"/><line x1="${f(20 + sb.px)}" y1="${y0 - 5}" x2="${f(20 + sb.px)}" y2="${y0 + 5}" stroke="#222"/>` +
        `<text x="20" y="${y0 - 8}" class="lbl">${sb.km} km</text></g>`);
    const nx = model.width - 28;
    parts.push(`<g class="north"><path d="M${nx},14 L${nx + 7},34 L${nx},29 L${nx - 7},34 Z" fill="#222"/><text x="${nx}" y="48" text-anchor="middle" class="lbl">N</text></g>`);
    parts.push('</svg>');
    return parts.join('');
}

// ── HTML rendering ─────────────────────────────────────────────────────────

function table(headers, rows, rowClass) {
    if (!rows.length) return '<p class="muted">None.</p>';
    const head = headers.map(([, label]) => `<th>${esc(label)}</th>`).join('');
    const body = rows.map(r => `<tr${rowClass ? ` class="${esc(rowClass(r))}"` : ''}>` +
        headers.map(([key]) => `<td>${esc(r[key])}</td>`).join('') + '</tr>').join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderDetail({ id, view }) {
    const sections = view.sections.map(s => `<div class="det-sec"><h4>${esc(s.heading)}</h4><dl>` +
        s.rows.map(r => `<dt${r.sub ? ' class="sub"' : ''}>${esc(r.label)}</dt><dd>${esc(r.value)}</dd>`).join('') +
        '</dl></div>').join('');
    const models = view.models.map(m => `<p class="model"><strong>${esc(m.name)}</strong> — ${esc(m.summary || '')} <span class="muted">${esc(m.validity || '')}</span></p>`).join('');
    const warns = view.warnings.length
        ? '<ul class="warns">' + view.warnings.map(w => `<li class="${esc(w.level)}">${esc(w.text)}</li>`).join('') + '</ul>'
        : '';
    return `<article class="detail"><h3>${esc(view.title)} <span class="kind">${esc(view.kindLabel)}</span></h3>` +
        `<p class="headline tone-${esc(view.headline.tone)}"><strong>${esc(view.headline.label)}:</strong> ${esc(view.headline.value)}</p>` +
        models + warns + `<div class="det-grid">${sections}</div><p class="muted small">Result id: ${esc(id)}</p></article>`;
}

const REPORT_CSS = `
:root{--ink:#1d2327;--muted:#5f6b72;--line:#d5d9dc;--head:#eef1f3;--good:#2e7d32;--mixed:#b35c00;--bad:#c62828}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 28px 40px}
.marking{text-align:center;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:4px;border:1px solid var(--ink);margin-bottom:14px}
header.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:2px solid var(--ink);padding-bottom:10px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 8px;padding-bottom:4px;border-bottom:1px solid var(--line);break-after:avoid}
h3{font-size:14px;margin:0 0 6px}h4{font-size:12px;margin:0 0 4px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.meta{color:var(--muted);font-size:12px}.meta b{color:var(--ink);font-weight:600}
.actions button{font:inherit;padding:6px 14px;border:1px solid var(--ink);background:var(--ink);color:#fff;border-radius:4px;cursor:pointer}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0}
.summary div{border:1px solid var(--line);border-radius:6px;padding:8px 10px}.summary strong{display:block;font-size:20px}
.disclaimer{border-left:4px solid var(--mixed);background:#fff8ef;padding:8px 12px;margin:12px 0}
table{width:100%;border-collapse:collapse;margin:6px 0 4px;font-size:12px}
th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}th{background:var(--head);font-weight:600}
tr.complete td:nth-child(9){color:var(--good);font-weight:600}tr.contested td:nth-child(9){color:var(--mixed);font-weight:600}tr.none td:nth-child(9){color:var(--bad);font-weight:600}
tr.stale td{background:#fff4e5}
svg.map{width:100%;height:auto;border-radius:4px}svg.imagery polygon{stroke-width:2;fill-opacity:.18}svg.imagery line.link-jammer{stroke-width:4}svg.imagery line.link-enemy{stroke-width:2.5}svg .lbl{font:11px system-ui,sans-serif;fill:#1d2327;paint-order:stroke;stroke:#fff;stroke-width:3px}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:11px;color:var(--muted);margin-top:4px}.legend i{display:inline-block;width:14px;height:3px;vertical-align:middle;margin-right:4px}
ul{margin:4px 0;padding-left:20px}li{margin:2px 0}.warns li.warn{color:var(--bad)}.warns li.info{color:var(--muted)}
.muted{color:var(--muted)}.small{font-size:11px}
.detail{border:1px solid var(--line);border-radius:6px;padding:10px 12px;margin:10px 0;break-inside:avoid}
.detail .kind{font-weight:400;color:var(--muted);font-size:12px;margin-left:6px}
.headline{margin:2px 0 6px}.tone-good{color:var(--good)}.tone-mixed{color:var(--mixed)}.tone-bad{color:var(--bad)}
.model{margin:2px 0;font-size:12px}
.det-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 18px}
dl{display:grid;grid-template-columns:auto 1fr;gap:1px 10px;margin:0;font-size:12px}dt{color:var(--muted)}dt.sub{padding-left:12px}dd{margin:0}
footer{margin-top:30px;padding-top:8px;border-top:1px solid var(--line);color:var(--muted);font-size:11px}
@page{margin:14mm}
@media print{.actions{display:none}main{padding:0;max-width:none}h2{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}.marking.bottom{position:fixed;bottom:0;left:0;right:0}}
`;

function renderReportHtml(report) {
    const r = report;
    const m = r.meta;
    const marking = m.marking ? `<div class="marking">${esc(m.marking)}</div>` : '';
    const coverage = r.coverage;
    const coverageText = [
        ['local DTED', coverage.local], ['online SRTM', coverage.remote], ['mixed', coverage.mixed],
        ['flat fallback (no terrain)', coverage.fallback], ['no terrain used', coverage.none], ['not recorded', coverage.unknown],
    ].filter(([, n]) => n).map(([l, n]) => `${n} ${l}`).join(' · ') || 'No terrain-aware results.';

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.title)} — Specter-EW report</title>
<style>${REPORT_CSS}</style></head>
<body><main>
${marking}
<header class="top">
  <div>
    <h1>${esc(m.title)}</h1>
    <div class="meta">Scenario <b>${esc(m.scenarioName)}</b> · Generated <b>${esc(m.generatedAtText)}</b> · Specter-EW <b>v${esc(m.appVersion)}</b></div>
  </div>
  <div class="actions"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
</header>

<div class="summary">
  <div><strong>${r.counts.nodes}</strong>Nodes</div>
  <div><strong>${r.counts.links}</strong>J/S results</div>
  <div><strong>${r.counts.rings}</strong>Rings &amp; footprints</div>
  <div><strong>${r.counts.warnings}</strong>Warnings</div>
</div>
<p class="disclaimer"><strong>Planning estimates.</strong> ${esc(r.disclaimer)}</p>

<h2>Map</h2>
${renderMapSvg(r.map, r.basemap)}
<div class="legend"><span><i style="background:#c62828"></i>Enemy comms (dashed)</span><span><i style="background:#2e7d32"></i>Jamming: complete</span><span><i style="background:#ef6c00"></i>contested</span><span><i style="background:#c62828;height:4px"></i>no effect</span><span><i style="background:#f2d600"></i>Overlap</span><span>North up; not a navigation product.</span>${r.map?.clipped ? '<span>Some rings extend beyond the frame.</span>' : ''}${r.basemap?.attribution ? `<span>${esc(r.basemap.attribution)}</span>` : ''}</div>

<h2>Node inventory</h2>
${table([['role', 'Role'], ['id', 'ID'], ['name', 'Name'], ['mgrs', 'MGRS'], ['latlon', 'Lat, Lon'], ['elevation', 'Elev.'], ['frequency', 'Frequency'], ['equipment', 'Equipment'], ['antenna', 'Antenna']], r.nodeRows)}

<h2>Enemy communications links</h2>
${table([['transmitter', 'Transmitter'], ['receiver', 'Receiver'], ['frequency', 'Frequency'], ['distance', 'Distance'], ['jammers', 'Jammers on RX']], r.commsRows)}

<h2>Jamming results (J/S)</h2>
${table([['jammer', 'Jammer'], ['transmitter', 'Enemy TX'], ['target', 'Target RX'], ['frequency', 'Freq'], ['jammerDistance', 'J→T'], ['enemyDistance', 'TX→T'], ['jammerRx', 'J at T'], ['enemyRx', 'S at T'], ['margin', 'J/S'], ['assessment', 'Assessment'], ['models', 'Model(s)'], ['terrain', 'Terrain data']], r.linkRows, row => `${row.classification}${row.stale ? ' stale' : ''}`)}

<h2>ES rings &amp; jammer footprints</h2>
${table([['kind', 'Type'], ['subject', 'Subject'], ['frequency', 'Freq'], ['threshold', 'Threshold'], ['median', 'Median'], ['spread', 'Min–max'], ['label', 'Label'], ['sampling', 'Bearings×samples'], ['models', 'Model(s)'], ['terrain', 'Terrain data']], r.ringRows, row => row.stale ? 'stale' : '')}

<h2>Enemy systems</h2>
${table([['node', 'Node'], ['system', 'System'], ['frequency', 'Freq'], ['power', 'Power'], ['gain', 'Gain'], ['antenna', 'Antenna'], ['range', 'Range median (min–max)']], r.enemySystemRows, row => row.stale ? 'stale' : '')}

<h2>EP systems</h2>
${table([['node', 'EP node'], ['system', 'System'], ['frequency', 'Freq'], ['power', 'Power'], ['gain', 'Gain'], ['antenna', 'Antenna'], ['range', 'Range median (min–max)']], r.epRows, row => row.stale ? 'stale' : '')}

<h2>Overlap analysis</h2>
${r.overlap.visible
        ? `<p>Common coverage shown for ${r.overlap.selected.length} ring(s): ${esc(r.overlap.selected.join('; '))} — ${r.overlap.zones} zone(s).</p>`
        : (r.overlap.selected.length
            ? `<p class="muted">${r.overlap.selected.length} ring(s) selected; common coverage not displayed at export.</p>`
            : '<p class="muted">No overlap analysis displayed.</p>')}

<h2>Settings</h2>
${table([['label', 'Setting'], ['value', 'Value']], r.settingsRows)}

<h2>Propagation models used</h2>
${table([['name', 'Model'], ['usedBy', 'Used by'], ['summary', 'What it does'], ['validity', 'Validity']], r.modelSummary)}
<p><strong>Terrain data coverage:</strong> ${esc(coverageText)}${coverage.highRes + coverage.standardRes
        ? ` · Ring resolution: ${coverage.highRes} high (local DTED, 72×25), ${coverage.standardRes} standard (online, 36×11).` : ''}</p>

<h2>Warnings</h2>
${r.warnings.length
        ? '<ul class="warns">' + r.warnings.map(w => `<li class="${esc(w.level)}"><strong>${esc(w.source)}:</strong> ${esc(w.text)}</li>`).join('') + '</ul>'
        : '<p class="muted">No warnings.</p>'}

<h2>Calculation assumptions</h2>
<ul>${r.assumptions.map(a => `<li>${esc(a)}</li>`).join('')}</ul>

<h2>Limitations</h2>
<ul>${r.limitations.map(a => `<li>${esc(a)}</li>`).join('')}</ul>

<h2>Calculation details</h2>
${r.details.length ? r.details.map(renderDetail).join('') : '<p class="muted">No calculated results.</p>'}

<footer>
  <p>Specter-EW v${esc(m.appVersion)} · Generated ${esc(m.generatedAtText)} · Licensed under ${esc(r.support.license)} · Source &amp; support: ${esc(r.support.source)} · ${esc(r.support.support)}</p>
  <p>${esc(r.disclaimer)}</p>
</footer>
${m.marking ? `<div class="marking bottom">${esc(m.marking)}</div>` : ''}
</main></body></html>`;
    return html;
}

// ── Dual-mode export ──────────────────────────────────────────────────────
const SpecterReport = {
    REPORT_DISCLAIMER, REPORT_ASSUMPTIONS, REPORT_LIMITATIONS, REPORT_SUPPORT,
    buildReportData, renderReportHtml, buildMapModel, renderMapSvg, basemapTilePlan,
    escapeReportHtml: esc,
};
if (typeof window !== 'undefined') window.SpecterReport = SpecterReport;
if (typeof module !== 'undefined' && module.exports) module.exports = SpecterReport;
})();
