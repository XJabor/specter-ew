// Specter-EW — report generation (browser side). Gathers an explicit,
// plain-data snapshot of the scenario, hands it to SpecterReport
// (report_model.js) and opens the print-friendly result in a new window.
// Declarations only: wiring lives in app_init.js.
//
// Only fields named here reach the report. No cookies, storage, auth state,
// server paths, or equipment notes/URLs are read.

function reportEquipment(eq) {
    if (!eq) return null;
    return {
        name: eq.name || '',
        equipment_type: eq.equipment_type,
        frequency_mhz: eq.frequency_mhz,
        tx_power_w: eq.tx_power_w,
        antenna_gain_dbi: eq.antenna_gain_dbi,
        rx_sensitivity_dbm: eq.rx_sensitivity_dbm,
        rx_gain_dbi: eq.rx_gain_dbi,
        apply_fh: !!eq.apply_fh,
        channel_bw_khz: eq.channel_bw_khz,
        jammer_bw_khz: eq.jammer_bw_khz,
    };
}

function reportSystem(sys) {
    return {
        id: sys.id, name: sys.name, freqMhz: sys.freqMhz, txPowerW: sys.txPowerW,
        txGainDbi: sys.txGainDbi, antennaType: sys.antennaType, antennaAzimuth: sys.antennaAzimuth,
        antennaBeamwidth: sys.antennaBeamwidth, antennaHeightAgl: sys.antennaHeightAgl,
    };
}

function reportNodeBase(node) {
    const ll = node.marker.getLatLng();
    let grid = '';
    try { grid = mgrs.forward([ll.lng, ll.lat]); } catch (e) { grid = ''; }
    return { id: node.id, name: plainNodeName(node.name), lat: ll.lat, lon: ll.lng, mgrs: grid };
}

function reportRfNode(node, type) {
    const eq = nodeEquipment(node, type);
    return {
        ...reportNodeBase(node),
        elevationM: node.elevationM ?? null,
        equipment: reportEquipment(eq),
        antenna: {
            type: eq.antenna_type || node.antennaType,
            azimuth_deg: node.antennaAzimuth,
            beamwidth_deg: eq.beamwidth_deg || node.antennaBeamwidth,
            height_m: eq.antenna_height_m || node.antennaHeightAgl,
        },
    };
}

function reportShapes() {
    const shapes = [];
    const ring = (color, points, center, radiusKm) => shapes.push({ kind: 'ring', color, points: points || null, center, radiusKm });
    const center = node => { const ll = node.marker.getLatLng(); return [ll.lat, ll.lng]; };
    redNodes.forEach(node => {
        if (node.esPolygonPoints) ring('#ff0033', node.esPolygonPoints);
        (node.systems || []).forEach(sys => { if (sys.polygonPoints) ring(sys.color, sys.polygonPoints); });
    });
    blueNodes.forEach(node => {
        (node.sensorCoverages || []).forEach(c => { if (c.polygonPoints) ring('#ff0033', c.polygonPoints); });
        if (node.footprintPolygonPoints) ring(RING_COLORS.jammer.color, node.footprintPolygonPoints);
    });
    epNodes.forEach(node => {
        if (node.ringsHidden) return;
        node.systems.forEach(sys => {
            if (sys.polygonPoints) ring(sys.color, sys.polygonPoints);
            else if (sys.rangeKm) ring(sys.color, null, center(node), sys.rangeKm);
        });
    });
    if (overlapLayer) {
        overlapLayer.getLayers().forEach(layer => {
            const raw = layer.getLatLngs();
            const pts = (Array.isArray(raw[0]) ? raw[0] : raw).map(ll => [ll.lat, ll.lng]);
            shapes.push({ kind: 'overlap', color: '#f2d600', points: pts });
        });
    }
    return shapes;
}

function reportOverlap() {
    const labels = activeSensorCoverages()
        .filter(item => overlapChecked.has(`${item.sensor.id}:${item.coverage.redId}`))
        .map(item => {
            const tx = findNode('red', item.coverage.redId);
            return `${plainNodeName(item.sensor.name)} / ${plainNodeName(tx ? tx.name : item.coverage.redId)}`;
        });
    return { visible: !!overlapLayer, zones: overlapLayer ? overlapLayer.getLayers().length : 0, selected: labels };
}

function gatherReportSnapshot() {
    const value = id => document.getElementById(id)?.value;
    const sensor = selectedSensorReference();
    const dist = (a, b) => (a && b) ? a.marker.getLatLng().distanceTo(b.marker.getLatLng()) / 1000 : null;
    return {
        appVersion: SPECTER_APP_VERSION,
        schemaVersion: SCENARIO_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        title: (value('report-title') || '').trim(),
        marking: (value('report-marking') || '').trim(),
        scenarioName: getScenarioName(),
        mode: epModeActive ? 'EP' : 'EA',
        legacySchema: loadedScenarioMigration,
        settings: {
            enemyTerrain: value('enemy_terrain'),
            jammerTerrain: value('jammer_terrain'),
            lowerThreshold: value('lower_threshold'),
            upperThreshold: value('upper_threshold'),
            footprintRxSensitivity: value('footprint_rx_sensitivity'),
            sensorReference: { name: plainNodeName(sensor.name), rxSensitivityDbm: sensor.rxSensitivityDbm, rxGainDbi: sensor.rxGainDbi },
            epTerrain: value('ep_terrain'),
            epRxSensitivity: value('ep_rx_sensitivity'),
        },
        nodes: {
            red: redNodes.map(n => ({ ...reportRfNode(n, 'red'), systems: (n.systems || []).map(reportSystem) })),
            blue: blueNodes.map(n => reportRfNode(n, 'blue')),
            black: blackNodes.map(reportNodeBase),
            ep: epNodes.map(n => ({ ...reportNodeBase(n), ringsHidden: !!n.ringsHidden, systems: n.systems.map(reportSystem) })),
        },
        enemyLinks: enemyLinks.map(l => ({ id: l.id, txId: l.txId, rxId: l.rxId,
            distanceKm: dist(findNode('red', l.txId), findNode('red', l.rxId)) })),
        jammingLinks: jammingLinks.map(l => ({ id: l.id, blueId: l.blueId, rxId: l.rxId,
            distanceKm: dist(findNode('blue', l.blueId), findNode('red', l.rxId)) })),
        results: collectResultRecords().map(({ record, stale }) => ({ record, stale })),
        shapes: reportShapes(),
        overlap: reportOverlap(),
    };
}

// ── Imagery basemap ───────────────────────────────────────────────────────
// Draws the tiles of the map's current base layer (plus the local imagery
// overlay when it is on) under the report map, as one inline JPEG. Tile
// servers must allow CORS (Esri and OSM do) or the canvas cannot be exported;
// any failure returns null and the report falls back to the plain schematic.

const BASEMAP_TILE_TIMEOUT_MS = 8000;
const BASEMAP_ATTRIBUTION = {
    Satellite: 'Imagery: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    Streets: 'Map data © OpenStreetMap contributors',
};

function loadTileImage(url) {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const timer = setTimeout(() => resolve(null), BASEMAP_TILE_TIMEOUT_MS);
        img.onload = () => { clearTimeout(timer); resolve(img); };
        img.onerror = () => { clearTimeout(timer); resolve(null); };  // e.g. 204 = no local coverage
        img.src = url;
    });
}

function tileUrl(layer, t) {
    const sub = layer.options.subdomains;
    return L.Util.template(layer._url, { z: t.z, x: t.x, y: t.y, s: sub ? sub[0] : '', r: '' });
}

async function renderReportBasemap(mapModel) {
    if (!mapModel?.mercator) return null;
    const baseName = activeBaseLayerName();
    const base = baseName === 'Streets' ? streetLayer : satelliteLayer;
    const layers = [base];
    if (map.hasLayer(localImageryLayer)) layers.push(localImageryLayer);

    const plan = SpecterReport.basemapTilePlan(mapModel, { maxZoom: base.options.maxZoom || 18 });
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    let drawn = 0;
    for (const layer of layers) {
        const images = await Promise.all(plan.tiles.map(t => loadTileImage(tileUrl(layer, t))));
        images.forEach((img, i) => {
            if (!img) return;
            const t = plan.tiles[i];
            // +1 px overlap hides hairline seams between scaled tiles.
            ctx.drawImage(img, t.dx, t.dy, t.size + 1, t.size + 1);
            if (layer === base) drawn++;
        });
    }
    if (drawn < plan.tiles.length / 2) return null;   // mostly missing: not worth showing
    try {
        return {
            href: canvas.toDataURL('image/jpeg', 0.85),
            attribution: BASEMAP_ATTRIBUTION[baseName] +
                (layers.length > 1 ? ' · Local imagery overlay' : ''),
        };
    } catch (e) {
        return null;  // tainted canvas: a tile server without CORS
    }
}

function reportStatus(message, isError = false) {
    const el = document.getElementById('report-status');
    if (!el) return;
    el.style.color = isError ? '#ff7777' : '#aaa';
    el.textContent = message || '';
}

async function openReport() {
    // Open the window now, inside the click, so pop-up blockers allow it;
    // imagery tiles load asynchronously afterwards.
    const w = window.open('', '_blank');
    if (w) {
        w.document.write('<!DOCTYPE html><title>Generating report…</title>' +
            '<p style="font:14px system-ui,sans-serif;padding:24px">Generating report…</p>');
    }
    let html, report;
    try {
        const snapshot = gatherReportSnapshot();
        const wantImagery = document.getElementById('report-imagery')?.checked !== false;
        if (wantImagery) {
            reportStatus('Loading map imagery…');
            snapshot.basemap = await renderReportBasemap(SpecterReport.buildMapModel(snapshot));
        }
        report = SpecterReport.buildReportData(snapshot);
        html = SpecterReport.renderReportHtml(report);
    } catch (e) {
        console.error('Report generation failed', e);
        reportStatus('Could not build the report.', true);
        if (w) w.close();
        return;
    }
    if (w && !w.closed) {
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.opener = null;
    } else {
        // Pop-up blocked: fall back to downloading the same HTML.
        const blob = new Blob([html], { type: 'text/html' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = safeScenarioFilename(report.meta.scenarioName).replace(/\.specter\.json$/, '') + '-report.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }
    const imageryNote = document.getElementById('report-imagery')?.checked === false ? ''
        : report.basemap ? ' Map imagery included.' : ' Map imagery unavailable; plain map used.';
    reportStatus(`Report generated: ${report.counts.links} J/S result(s), ${report.counts.rings} ring(s), ${report.warnings.length} note(s).${imageryNote}`);
}
