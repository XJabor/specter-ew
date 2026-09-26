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

function reportStatus(message, isError = false) {
    const el = document.getElementById('report-status');
    if (!el) return;
    el.style.color = isError ? '#ff7777' : '#aaa';
    el.textContent = message || '';
}

function openReport() {
    let html, report;
    try {
        report = SpecterReport.buildReportData(gatherReportSnapshot());
        html = SpecterReport.renderReportHtml(report);
    } catch (e) {
        console.error('Report generation failed', e);
        reportStatus('Could not build the report.', true);
        return;
    }
    const w = window.open('', '_blank');
    if (w) {
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
    reportStatus(`Report generated: ${report.counts.links} J/S result(s), ${report.counts.rings} ring(s), ${report.warnings.length} note(s).`);
}
