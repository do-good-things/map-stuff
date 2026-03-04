/* global L */

(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────
  let data = {};            // raw API response
  let rideOffsets = [];     // rideOffsets[i] = globalTime at start of ride i
  let totalDuration = 0;   // sum of all ride moving_time_s

  // Layers keyed by rider name
  let completedLayers = {}; // completedLayers[rider][rideIdx] = L.polyline (faded, full)
  let animPolylines = {};   // animPolylines[rider] = L.polyline (growing, current ride)
  let animDots = {};        // animDots[rider] = L.circleMarker

  // Animation state
  let globalTime = 0;       // seconds into global timeline
  let playing = false;
  let lastRafTs = null;
  let rafId = null;

  // Camera state
  let rideBounds = [];       // rideBounds[i] = L.latLngBounds for ride i
  let lastCameraRide = -1;   // last ride we zoomed to
  let cameraLat = null;      // smoothed camera position (null = uninitialised)
  let cameraLng = null;
  let lastFrameDtMs = 16;    // real ms between frames; used for lerp time constant

  // Finished-rider cache: skip rebuilding polylines for riders whose GPS has ended
  let finishedRiders = {};   // { rider: true } once all their coords are shown
  let lastRenderedRide = -1; // reset finishedRiders when ride changes

  // ── Map setup ───────────────────────────────────────────
  const map = L.map('map', { center: [38.1, -122.9], zoom: 10, zoomControl: true });

  const STADIA_ATTR = '&copy; <a href="https://www.stadiamaps.com/" target="_blank">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

  const darkTile = L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    { attribution: STADIA_ATTR, maxZoom: 20 });
  darkTile.addTo(map);

  L.control.layers(
    {
      'Dark': darkTile,
      'Light': L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png', { attribution: STADIA_ATTR, maxZoom: 20 }),
    },
    {},
    { position: 'topright' }
  ).addTo(map);

  // ── Helpers ─────────────────────────────────────────────
  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '—';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
                 : `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatDate(isoString) {
    if (!isoString) return '';
    try {
      return new Date(isoString).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  // Convert globalTime → { rideIdx, rideTime }
  function globalToLocal(gt) {
    const numRides = rideOffsets.length;
    for (let i = numRides - 1; i >= 0; i--) {
      if (gt >= rideOffsets[i]) {
        return { rideIdx: i, rideTime: gt - rideOffsets[i] };
      }
    }
    return { rideIdx: 0, rideTime: 0 };
  }

  // ── Load ────────────────────────────────────────────────
  fetch('/api/tracks/point_reyes')
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(parsed => {
      data = parsed;
      buildTimeline();
      buildRideBounds();
      buildRideJumpButtons();
      initRiderList();
      initAnimLayers();
      fitBounds();
      renderAtGlobalTime(0);
      updateScrubber();
      updateNowPlaying();
    })
    .catch(err => {
      console.error('Error loading tracks:', err);
    });

  // ── Timeline ────────────────────────────────────────────
  function buildTimeline() {
    // Use the first rider's rides as the reference for ride count
    const riderKeys = Object.keys(data);
    if (!riderKeys.length) return;

    const refInfo = data[riderKeys[0]];
    const numRides = (refInfo.rides || []).length;

    rideOffsets = [];
    let offset = 0;
    for (let i = 0; i < numRides; i++) {
      rideOffsets.push(offset);
      // Use the last coordinate's t_seconds as ride duration — this is already
      // aligned to the shared absolute clock (start offsets applied server-side).
      let rideDur = 0;
      riderKeys.forEach(rider => {
        const coords = data[rider].rides && data[rider].rides[i];
        if (coords && coords.length) rideDur = Math.max(rideDur, coords[coords.length - 1][2] || 0);
      });
      offset += rideDur;
    }
    totalDuration = offset;
    document.getElementById('sim-scrubber').max = totalDuration;
  }

  // ── Ride bounds (for camera transitions) ────────────────
  function buildRideBounds() {
    const riderKeys = Object.keys(data);
    rideBounds = rideOffsets.map((_, i) => {
      const pts = [];
      riderKeys.forEach(rider => {
        const coords = data[rider].rides && data[rider].rides[i];
        if (coords) coords.forEach(c => pts.push([c[0], c[1]]));
      });
      return pts.length ? L.latLngBounds(pts) : null;
    });
  }

  // ── Ride jump buttons ─────────────────────────────────
  function buildRideJumpButtons() {
    const container = document.getElementById('ride-jump-buttons');
    if (!container) return;
    container.innerHTML = '';
    rideOffsets.forEach((_, i) => {
      const btn = document.createElement('button');
      btn.textContent = `Day ${i + 1}`;
      btn.dataset.ride = i;
      btn.addEventListener('click', () => jumpToRide(i));
      container.appendChild(btn);
    });
  }

  function jumpToRide(rideIdx) {
    if (rideIdx < 0 || rideIdx >= rideOffsets.length) return;
    globalTime = rideOffsets[rideIdx];
    // Reset camera so ride transition fires
    lastCameraRide = -1;
    cameraLat = null;
    cameraLng = null;
    finishedRiders = {};
    lastRenderedRide = -1;
    renderAtGlobalTime(globalTime);
    updateScrubberNoEvent();
    updateNowPlaying();
  }

  function updateRideJumpHighlight(currentRide) {
    const container = document.getElementById('ride-jump-buttons');
    if (!container) return;
    const buttons = container.querySelectorAll('button');
    buttons.forEach((btn, i) => {
      btn.classList.toggle('active-ride', i === currentRide);
    });
  }

  // ── Rider list ──────────────────────────────────────────
  function initRiderList() {
    const container = document.getElementById('rider-list');
    container.innerHTML = '';
    Object.entries(data).forEach(([rider, info]) => {
      const row = document.createElement('div');
      row.className = 'check-row';
      row.innerHTML = `
        <span class="rider-dot" style="background:${info.color}"></span>
        <span class="rider-label">${rider}</span>
      `;
      container.appendChild(row);
    });
  }

  // ── Animation layers ────────────────────────────────────
  function initAnimLayers() {
    Object.entries(data).forEach(([rider, info]) => {
      completedLayers[rider] = [];
      // Pre-create full faded polylines for each ride (hidden until completed)
      (info.rides || []).forEach((coords, rideIdx) => {
        if (!coords || coords.length === 0) { completedLayers[rider].push(null); return; }
        const latlngs = coords.map(c => [c[0], c[1]]);
        const poly = L.polyline(latlngs, {
          color: info.color, weight: 2.5, opacity: 0.35,
          lineCap: 'round', lineJoin: 'round',
        });
        completedLayers[rider].push(poly);
      });

      // Growing polyline for current ride
      animPolylines[rider] = L.polyline([], {
        color: info.color, weight: 4, opacity: 0.95,
        lineCap: 'round', lineJoin: 'round',
      });

      // Dot marker
      animDots[rider] = L.circleMarker([0, 0], {
        radius: 5, color: '#fff', weight: 1.5,
        fillColor: info.color, fillOpacity: 1,
      });
    });
  }

  // ── Fit bounds ──────────────────────────────────────────
  function fitBounds() {
    const all = [];
    Object.values(data).forEach(info => {
      (info.rides || []).forEach(coords => {
        if (coords) coords.forEach(c => all.push([c[0], c[1]]));
      });
    });
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
  }

  // ── Render at global time ────────────────────────────────
  function renderAtGlobalTime(gt) {
    gt = Math.max(0, Math.min(gt, totalDuration));
    globalTime = gt;

    const { rideIdx: currentRide, rideTime } = globalToLocal(gt);

    // Reset finished-rider cache whenever the active ride changes
    if (currentRide !== lastRenderedRide) {
      finishedRiders = {};
      lastRenderedRide = currentRide;
    }

    Object.entries(data).forEach(([rider, info]) => {
      const rides = info.rides || [];

      // Completed rides: show full faded polylines
      rides.forEach((coords, idx) => {
        const layer = completedLayers[rider][idx];
        if (!layer) return;
        if (idx < currentRide) {
          if (!map.hasLayer(layer)) layer.addTo(map);
        } else {
          if (map.hasLayer(layer)) map.removeLayer(layer);
        }
      });

      // Current ride: growing polyline
      const animPoly = animPolylines[rider];
      const animDot = animDots[rider];
      const coords = rides[currentRide];

      if (!coords || coords.length === 0) {
        if (map.hasLayer(animPoly)) map.removeLayer(animPoly);
        if (map.hasLayer(animDot)) map.removeLayer(animDot);
        return;
      }

      // Fast path: this rider has already shown their full GPS track.
      // Avoid rebuilding a potentially huge polyline every frame.
      if (finishedRiders[rider]) {
        if (!map.hasLayer(animPoly)) animPoly.addTo(map);
        if (!map.hasLayer(animDot)) animDot.addTo(map);
        return;
      }

      // Check if rider has finished (last coord's timestamp is already past)
      if (coords[coords.length - 1][2] <= rideTime) {
        finishedRiders[rider] = true;
        const lastCoord = coords[coords.length - 1];
        animPoly.setLatLngs(coords.map(c => [c[0], c[1]]));
        if (!map.hasLayer(animPoly)) animPoly.addTo(map);
        animDot.setLatLng([lastCoord[0], lastCoord[1]]);
        if (!map.hasLayer(animDot)) animDot.addTo(map);
        return;
      }

      // Active rider: build growing polyline up to rideTime
      // coords[i] = [lat, lon, t_seconds]
      let pts = [];
      for (let i = 0; i < coords.length; i++) {
        if (coords[i][2] <= rideTime) {
          pts.push([coords[i][0], coords[i][1]]);
        } else {
          break;
        }
      }

      if (pts.length === 0) {
        // This rider's start offset hasn't been reached yet — hide until they begin
        if (map.hasLayer(animPoly)) map.removeLayer(animPoly);
        if (map.hasLayer(animDot)) map.removeLayer(animDot);
        return;
      }

      animPoly.setLatLngs(pts);
      if (!map.hasLayer(animPoly)) animPoly.addTo(map);

      const lastPt = pts[pts.length - 1];
      animDot.setLatLng(lastPt);
      if (!map.hasLayer(animDot)) animDot.addTo(map);
    });

    // Future rides: all hidden (completed and anim layers are already managed above)

    // ── Camera ────────────────────────────────────────────
    if (playing) {
      if (currentRide !== lastCameraRide) {
        // Ride transition: zoom to where the earliest-starting rider begins
        lastCameraRide = currentRide;
        let minT = Infinity, startLat = null, startLng = null;
        Object.values(data).forEach(info => {
          const coords = info.rides && info.rides[currentRide];
          if (coords && coords.length && coords[0][2] < minT) {
            minT = coords[0][2];
            startLat = coords[0][0];
            startLng = coords[0][1];
          }
        });
        if (startLat !== null) {
          map.setView([startLat, startLng], 13, { animate: false });
          cameraLat = startLat;
          cameraLng = startLng;
        }
      } else {
        // Compute centroid of all active dots
        const positions = Object.values(animDots)
          .filter(d => map.hasLayer(d))
          .map(d => d.getLatLng());
        if (positions.length && cameraLat !== null) {
          const targetLat = positions.reduce((s, p) => s + p.lat, 0) / positions.length;
          const targetLng = positions.reduce((s, p) => s + p.lng, 0) / positions.length;

          // Exponential lerp with a 500 ms time constant — frame-rate independent
          const alpha = 1 - Math.exp(-lastFrameDtMs / 500);
          cameraLat += (targetLat - cameraLat) * alpha;
          cameraLng += (targetLng - cameraLng) * alpha;

          // Only actually move the map if we've drifted more than 1 screen pixel
          const currentPx = map.latLngToContainerPoint(map.getCenter());
          const targetPx  = map.latLngToContainerPoint([cameraLat, cameraLng]);
          const dx = targetPx.x - currentPx.x;
          const dy = targetPx.y - currentPx.y;
          if (dx * dx + dy * dy > 1) {
            map.panTo([cameraLat, cameraLng], { animate: false });
          }
        }
      }
    }
  }

  // ── Animation loop ──────────────────────────────────────
  function animLoop(ts) {
    if (!playing) return;
    if (lastRafTs !== null) {
      const dtMs = ts - lastRafTs;
      lastFrameDtMs = dtMs;
      const speed = parseFloat(document.getElementById('anim-speed').value);
      globalTime += (dtMs / 1000) * speed;
      if (globalTime >= totalDuration) {
        globalTime = totalDuration;
        playing = false;
        setPlayPauseButtons();
      }
    }
    lastRafTs = ts;
    renderAtGlobalTime(globalTime);
    updateScrubberNoEvent();
    updateNowPlaying();
    if (playing) rafId = requestAnimationFrame(animLoop);
  }

  function startPlay() {
    if (globalTime >= totalDuration) globalTime = 0;
    playing = true;
    lastRafTs = null;
    lastCameraRide = -1;
    cameraLat = null;
    cameraLng = null;
    finishedRiders = {};
    lastRenderedRide = -1;
    setPlayPauseButtons();
    rafId = requestAnimationFrame(animLoop);
  }

  function pausePlay() {
    playing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    setPlayPauseButtons();
  }

  function resetSim() {
    pausePlay();
    globalTime = 0;
    lastCameraRide = -1;
    cameraLat = null;
    cameraLng = null;
    finishedRiders = {};
    lastRenderedRide = -1;
    renderAtGlobalTime(0);
    updateScrubberNoEvent();
    updateNowPlaying();
  }

  function setPlayPauseButtons() {
    document.getElementById('btn-play').disabled = playing;
    document.getElementById('btn-pause').disabled = !playing;
  }

  // ── Scrubber ────────────────────────────────────────────
  let scrubberUserDragging = false;

  function updateScrubber() {
    document.getElementById('sim-scrubber').value = globalTime;
    updateTimeDisplay();
  }

  function updateScrubberNoEvent() {
    document.getElementById('sim-scrubber').value = globalTime;
    updateTimeDisplay();
  }

  function updateTimeDisplay() {
    document.getElementById('sim-time-display').textContent = formatDuration(globalTime);
  }

  // ── Now Playing ─────────────────────────────────────────
  function updateNowPlaying() {
    if (!rideOffsets.length) return;
    const { rideIdx } = globalToLocal(globalTime);
    const numRides = rideOffsets.length;

    // Get date from any rider's stats for this ride
    let dateStr = '';
    const riderKeys = Object.keys(data);
    for (const rider of riderKeys) {
      const s = data[rider].stats && data[rider].stats[rideIdx];
      if (s && s.start_time) { dateStr = formatDate(s.start_time); break; }
    }

    const label = globalTime >= totalDuration
      ? `Complete`
      : `Day ${rideIdx + 1} of ${numRides}${dateStr ? ' · ' + dateStr : ''}`;

    document.getElementById('sim-now-playing').textContent = label;
    updateRideJumpHighlight(globalTime >= totalDuration ? -1 : rideIdx);
  }

  // ── Control bindings ────────────────────────────────────
  document.getElementById('btn-play').addEventListener('click', startPlay);
  document.getElementById('btn-pause').addEventListener('click', pausePlay);
  document.getElementById('btn-reset').addEventListener('click', resetSim);

  const scrubber = document.getElementById('sim-scrubber');
  scrubber.addEventListener('mousedown', () => {
    scrubberUserDragging = true;
    pausePlay();
  });
  scrubber.addEventListener('touchstart', () => {
    scrubberUserDragging = true;
    pausePlay();
  });
  scrubber.addEventListener('input', () => {
    globalTime = parseFloat(scrubber.value);
    renderAtGlobalTime(globalTime);
    updateTimeDisplay();
    updateNowPlaying();
  });
  scrubber.addEventListener('mouseup', () => { scrubberUserDragging = false; });
  scrubber.addEventListener('touchend', () => { scrubberUserDragging = false; });

})();
