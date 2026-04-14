import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import mapboxgl from 'mapbox-gl';
import { MAPBOX_STYLE, formatDuration, formatDate } from './mapConfig';

export default function PointReyesSimulatePage() {
  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const mapReady = useRef(false);
  const sourcesReady = useRef(false);

  const [data, setData] = useState(null);
  const [speed, setSpeed] = useState(60);

  // Mutable animation state (avoid re-renders each frame)
  const anim = useRef({
    globalTime: 0,
    totalDuration: 0,
    rideOffsets: [],
    lastRafTs: null,
    rafId: null,
    lastFrameDtMs: 16,
    lastCameraRide: -1,
    cameraLat: null,
    cameraLng: null,
    finishedRiders: {},
    lastRenderedRide: -1,
  });

  const scrubberRef = useRef(null);
  const timeDisplayRef = useRef(null);
  const nowPlayingRef = useRef(null);
  const pillRefs = useRef([]);

  // ── Helpers ──
  function globalToLocal(gt) {
    const offsets = anim.current.rideOffsets;
    for (let i = offsets.length - 1; i >= 0; i--) {
      if (gt >= offsets[i]) return { rideIdx: i, rideTime: gt - offsets[i] };
    }
    return { rideIdx: 0, rideTime: 0 };
  }

  // ── Load data ──
  useEffect(() => {
    fetch('/api/tracks/point_reyes')
      .then(r => r.json())
      .then(d => {
        setData(d);
        buildTimeline(d);
      });
  }, []);

  function buildTimeline(d) {
    const riderKeys = Object.keys(d);
    if (!riderKeys.length) return;
    const numRides = (d[riderKeys[0]].rides || []).length;
    const offsets = [];
    let offset = 0;
    for (let i = 0; i < numRides; i++) {
      offsets.push(offset);
      let rideDur = 0;
      riderKeys.forEach(rider => {
        const coords = d[rider].rides && d[rider].rides[i];
        if (coords && coords.length) rideDur = Math.max(rideDur, coords[coords.length - 1][2] || 0);
      });
      offset += rideDur;
    }
    anim.current.rideOffsets = offsets;
    anim.current.totalDuration = offset;
  }

  // ── Map init ──
  useEffect(() => {
    if (mapRef.current) return;
    const map = new mapboxgl.Map({
      container: mapContainer.current,
      style: MAPBOX_STYLE,
      center: [-122.9, 38.1],
      zoom: 10,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');
    mapRef.current = map;

    map.on('style.load', () => {
      mapReady.current = true;
      map.setConfigProperty('basemap', 'showRoadLabels', false);
      map.setConfigProperty('basemap', 'showPointOfInterestLabels', false);
    });

    return () => map.remove();
  }, []);

  // ── Init map sources when data + map are ready ──
  useEffect(() => {
    if (!data || !mapRef.current) return;
    const map = mapRef.current;

    const init = () => {
      mapReady.current = true;
      const bounds = new mapboxgl.LngLatBounds();

      Object.entries(data).forEach(([rider, info]) => {
        // Completed (faded) polylines per ride
        (info.rides || []).forEach((coords, rideIdx) => {
          if (!coords || !coords.length) return;
          const id = `completed-${rider}-${rideIdx}`;
          coords.forEach(c => bounds.extend([c[1], c[0]]));
          map.addSource(id, {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords.map(c => [c[1], c[0]]) } },
          });
          map.addLayer({
            id, type: 'line', source: id,
            paint: { 'line-color': info.color, 'line-width': 4, 'line-opacity': 0.35 },
            layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
          });
        });

        // Active polyline (one per rider)
        const animId = `anim-${rider}`;
        map.addSource(animId, {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } },
        });
        map.addLayer({
          id: animId, type: 'line', source: animId,
          paint: { 'line-color': info.color, 'line-width': 6, 'line-opacity': 0.95 },
          layout: { 'line-cap': 'round', 'line-join': 'round' },
        });

        // Dot (circle layer)
        const dotId = `dot-${rider}`;
        map.addSource(dotId, {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } },
        });
        map.addLayer({
          id: dotId, type: 'circle', source: dotId,
          paint: {
            'circle-radius': 5,
            'circle-color': info.color,
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
          },
          layout: { visibility: 'none' },
        });
      });

      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 40 });
      sourcesReady.current = true;
      renderFrame(0);
    };

    if (map.isStyleLoaded()) init();
    else map.on('style.load', init);
  }, [data]);

  // ── Render frame ──
  const renderFrame = useCallback((gt) => {
    const map = mapRef.current;
    if (!map || !mapReady.current || !data) return;
    if (!map.isStyleLoaded() || !sourcesReady.current) return;
    const a = anim.current;
    gt = Math.max(0, Math.min(gt, a.totalDuration));
    a.globalTime = gt;

    const { rideIdx: currentRide, rideTime } = globalToLocal(gt);

    if (currentRide !== a.lastRenderedRide) {
      a.finishedRiders = {};
      a.lastRenderedRide = currentRide;
    }

    Object.entries(data).forEach(([rider, info]) => {
      const rides = info.rides || [];

      // Completed rides
      rides.forEach((_, idx) => {
        const id = `completed-${rider}-${idx}`;
        if (!map.getLayer(id)) return;
        map.setLayoutProperty(id, 'visibility', idx < currentRide ? 'visible' : 'none');
      });

      const animId = `anim-${rider}`;
      const dotId = `dot-${rider}`;
      const coords = rides[currentRide];

      if (!coords || !coords.length) {
        if (map.getSource(animId)) map.getSource(animId).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
        if (map.getSource(dotId)) map.setLayoutProperty(dotId, 'visibility', 'none');
        return;
      }

      if (a.finishedRiders[rider]) {
        if (map.getLayer(dotId)) map.setLayoutProperty(dotId, 'visibility', 'visible');
        return;
      }

      if (coords[coords.length - 1][2] <= rideTime) {
        a.finishedRiders[rider] = true;
        const last = coords[coords.length - 1];
        if (map.getSource(animId)) {
          map.getSource(animId).setData({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords.map(c => [c[1], c[0]]) },
          });
        }
        if (map.getSource(dotId)) {
          map.getSource(dotId).setData({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [last[1], last[0]] },
          });
          map.setLayoutProperty(dotId, 'visibility', 'visible');
        }
        return;
      }

      const pts = [];
      for (let i = 0; i < coords.length; i++) {
        if (coords[i][2] <= rideTime) pts.push([coords[i][1], coords[i][0]]);
        else break;
      }

      if (pts.length === 0) {
        if (map.getSource(animId)) map.getSource(animId).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: [] } });
        if (map.getLayer(dotId)) map.setLayoutProperty(dotId, 'visibility', 'none');
        return;
      }

      if (map.getSource(animId)) {
        map.getSource(animId).setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: pts },
        });
      }
      const lastPt = pts[pts.length - 1];
      if (map.getSource(dotId)) {
        map.getSource(dotId).setData({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: lastPt },
        });
        map.setLayoutProperty(dotId, 'visibility', 'visible');
      }
    });

    // Camera follow
    if (playingRef.current) {
      if (currentRide !== a.lastCameraRide) {
        a.lastCameraRide = currentRide;
        let minT = Infinity, startLng = null, startLat = null;
        Object.values(data).forEach(info => {
          const c = info.rides && info.rides[currentRide];
          if (c && c.length && c[0][2] < minT) {
            minT = c[0][2]; startLat = c[0][0]; startLng = c[0][1];
          }
        });
        if (startLng !== null) {
          map.jumpTo({ center: [startLng, startLat], zoom: 13 });
          a.cameraLat = startLat;
          a.cameraLng = startLng;
        }
      } else if (a.cameraLat !== null) {
        // Centroid of active dots
        const positions = [];
        Object.keys(data).forEach(rider => {
          const dotId = `dot-${rider}`;
          if (map.getLayer(dotId) && map.getLayoutProperty(dotId, 'visibility') === 'visible') {
            const src = map.getSource(dotId);
            if (src) {
              try {
                const gj = src.serialize()?.data;
                if (gj?.geometry?.coordinates) positions.push(gj.geometry.coordinates);
              } catch { /* skip */ }
            }
          }
        });
        if (positions.length) {
          const tLng = positions.reduce((s, p) => s + p[0], 0) / positions.length;
          const tLat = positions.reduce((s, p) => s + p[1], 0) / positions.length;
          const alpha = 1 - Math.exp(-a.lastFrameDtMs / 500);
          a.cameraLat += (tLat - a.cameraLat) * alpha;
          a.cameraLng += (tLng - a.cameraLng) * alpha;
          map.panTo([a.cameraLng, a.cameraLat], { animate: false });
        }
      }
    }

    // Update DOM directly (no re-render)
    if (scrubberRef.current) scrubberRef.current.value = gt;
    if (timeDisplayRef.current) timeDisplayRef.current.textContent = formatDuration(gt);
    updateNowPlaying(currentRide, gt);
  }, [data]);

  function updateNowPlaying(currentRide, gt) {
    const a = anim.current;
    if (!a.rideOffsets.length || !data) return;
    const numRides = a.rideOffsets.length;
    let dateStr = '';
    for (const rider of Object.keys(data)) {
      const s = data[rider].stats && data[rider].stats[currentRide];
      if (s && s.start_time) { dateStr = formatDate(s.start_time); break; }
    }
    const label = gt >= a.totalDuration
      ? 'complete'
      : `day ${currentRide + 1} of ${numRides}${dateStr ? ' · ' + dateStr : ''}`;
    if (nowPlayingRef.current) nowPlayingRef.current.textContent = label;

    // Update pill highlight
    pillRefs.current.forEach((el, i) => {
      if (el) el.classList.toggle('active', gt < a.totalDuration && i === currentRide);
    });
  }

  // ── Animation loop (fully imperative) ──
  const playingRef = useRef(false);
  const speedRef = useRef(speed);
  const renderFrameRef = useRef(renderFrame);
  const [playingState, setPlayingState] = useState(false); // only for button UI

  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { renderFrameRef.current = renderFrame; }, [renderFrame]);

  function animLoop(ts) {
    const a = anim.current;
    if (!playingRef.current) return;
    if (a.lastRafTs !== null) {
      const dtMs = ts - a.lastRafTs;
      a.lastFrameDtMs = dtMs;
      a.globalTime += (dtMs / 1000) * speedRef.current;
      if (a.globalTime >= a.totalDuration) {
        a.globalTime = a.totalDuration;
        stopPlay();
      }
    }
    a.lastRafTs = ts;
    renderFrameRef.current(a.globalTime);
    if (playingRef.current) a.rafId = requestAnimationFrame(animLoop);
  }

  function startPlay() {
    const a = anim.current;
    if (a.totalDuration <= 0) return;
    if (playingRef.current) return;
    if (a.globalTime >= a.totalDuration) a.globalTime = 0;
    a.lastRafTs = null;
    a.lastCameraRide = -1;
    a.cameraLat = null;
    a.cameraLng = null;
    a.finishedRiders = {};
    a.lastRenderedRide = -1;
    playingRef.current = true;
    setPlayingState(true);
    a.rafId = requestAnimationFrame(animLoop);
  }

  function stopPlay() {
    playingRef.current = false;
    setPlayingState(false);
    const a = anim.current;
    if (a.rafId) { cancelAnimationFrame(a.rafId); a.rafId = null; }
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      playingRef.current = false;
      if (anim.current.rafId) cancelAnimationFrame(anim.current.rafId);
    };
  }, []);

  const handleReset = useCallback(() => {
    stopPlay();
    const a = anim.current;
    a.globalTime = 0;
    a.lastCameraRide = -1;
    a.cameraLat = null;
    a.cameraLng = null;
    a.finishedRiders = {};
    a.lastRenderedRide = -1;
    renderFrame(0);
  }, [renderFrame]);

  const handleJumpToRide = useCallback((i) => {
    stopPlay();
    const a = anim.current;
    a.globalTime = a.rideOffsets[i] || 0;
    a.lastCameraRide = -1;
    a.cameraLat = null;
    a.cameraLng = null;
    a.finishedRiders = {};
    a.lastRenderedRide = -1;
    renderFrame(a.globalTime);
  }, [renderFrame]);

  const handleScrub = useCallback((e) => {
    stopPlay();
    const gt = parseFloat(e.target.value);
    anim.current.finishedRiders = {};
    anim.current.lastRenderedRide = -1;
    renderFrame(gt);
  }, [renderFrame]);

  const numRides = anim.current.rideOffsets.length || (data ? Math.max(...Object.values(data).map(i => (i.rides || []).length), 0) : 0);

  return (
    <div className="app-layout">
      <div className="sidebar">
        <div className="sidebar-header">
          <Link to="/point_reyes" className="back-link">← explore</Link>
          <div className="sidebar-title">point reyes</div>
          <div className="sidebar-subtitle">2025 · simulation</div>
        </div>

        <div className="sidebar-section">
          <div className="section-label">riders</div>
          {data && Object.entries(data).map(([rider, info]) => (
            <div key={rider} className="check-row" style={{ cursor: 'default' }}>
              <span className="rider-dot" style={{ background: info.color }} />
              <span className="check-label">{rider}</span>
            </div>
          ))}
        </div>

        <div className="sidebar-section">
          <div className="section-label">now playing</div>
          <div className="now-playing" ref={nowPlayingRef}>—</div>
          <div className="time-display" ref={timeDisplayRef}>0:00</div>
          <input
            type="range"
            className="scrubber"
            ref={scrubberRef}
            min={0}
            max={anim.current.totalDuration || 1000}
            defaultValue={0}
            onMouseDown={stopPlay}
            onTouchStart={stopPlay}
            onInput={handleScrub}
          />
          <div className="btn-group">
            <button className="btn btn-primary" disabled={playingState} onClick={startPlay}>
              ▶ Play
            </button>
            <button className="btn" disabled={!playingState} onClick={stopPlay}>
              ⏸ Pause
            </button>
            <button className="btn btn-ghost" onClick={handleReset}>
              ↺ Reset
            </button>
          </div>
          <div className="speed-row">
            <span className="speed-label">Speed</span>
            <select className="speed-select" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
              {[10, 30, 60, 120, 200, 300, 500, 750, 1000, 1500, 2000, 3000].map(v => (
                <option key={v} value={v}>{v}×</option>
              ))}
            </select>
          </div>
          <div className="ride-pills">
            {Array.from({ length: numRides }, (_, i) => (
              <button
                key={i}
                className="ride-pill"
                ref={el => pillRefs.current[i] = el}
                onClick={() => handleJumpToRide(i)}
              >
                Day {i + 1}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="map-container" ref={mapContainer} />
    </div>
  );
}
