import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, send_from_directory


app = Flask(__name__, static_folder='.')

BASE_DIR = Path(__file__).parent
POINT_REYES_DIR = BASE_DIR / 'point-reyes'

POINT_REYES_COLORS = {
    'sarah': '#FF6B6B',
    'alex': '#4ECDC4',
    'john-marc': '#F9A825',
}

GPX_NS = {'gpx': 'http://www.topografix.com/GPX/1/1'}


def haversine_km(lat1, lon1, lat2, lon2):
    """Distance in km between two lat/lon points."""
    from math import radians, sin, cos, sqrt, atan2

    earth_radius_km = 6371.0
    dlat = radians(lat2 - lat1)
    dlon = radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return earth_radius_km * 2 * atan2(sqrt(a), sqrt(1 - a))


def parse_gpx_with_timestamps(file_path):
    """
    Parse a GPX file with per-trackpoint timestamps.
    Returns (raw_latlng_ts, stats) where raw_latlng_ts is a list of
    [lat, lon, unix_seconds_float | None].
    """
    tree = ET.parse(file_path)
    root = tree.getroot()

    raw_points = []  # (lat, lon, ele, datetime|None)
    for trkpt in root.findall('.//gpx:trkpt', GPX_NS):
        lat = float(trkpt.get('lat'))
        lon = float(trkpt.get('lon'))
        ele_el = trkpt.find('gpx:ele', GPX_NS)
        ele = float(ele_el.text) if ele_el is not None else 0.0
        time_el = trkpt.find('gpx:time', GPX_NS)
        ts = None
        if time_el is not None:
            try:
                ts = datetime.fromisoformat(time_el.text.replace('Z', '+00:00'))
            except ValueError:
                pass
        raw_points.append((lat, lon, ele, ts))

    if not raw_points:
        return [], {'distance_km': 0, 'elevation_gain_m': 0, 'points_raw': 0, 'points_simplified': 0}

    moving_threshold_kmh = 1.0
    distance = 0.0
    elevation_gain = 0.0
    moving_time_s = 0.0
    speeds = []

    prev_lat, prev_lon, prev_ele, prev_ts = raw_points[0]
    for lat, lon, ele, ts in raw_points[1:]:
        segment_distance = haversine_km(prev_lat, prev_lon, lat, lon)
        distance += segment_distance
        if ele - prev_ele > 0:
            elevation_gain += ele - prev_ele
        if prev_ts is not None and ts is not None:
            dt = (ts - prev_ts).total_seconds()
            if dt > 0:
                speed_kmh = (segment_distance / dt) * 3600.0
                speeds.append(speed_kmh)
                if speed_kmh >= moving_threshold_kmh:
                    moving_time_s += dt
        prev_lat, prev_lon, prev_ele, prev_ts = lat, lon, ele, ts

    times = [p[3] for p in raw_points if p[3] is not None]
    elapsed_time_s = None
    start_time_iso = None
    if len(times) >= 2:
        elapsed_time_s = (times[-1] - times[0]).total_seconds()
        start_time_iso = times[0].isoformat()

    avg_speed_kmh = None
    if moving_time_s > 0:
        avg_speed_kmh = round(distance / (moving_time_s / 3600.0), 1)

    filtered_speeds = [s for s in speeds if s <= 120.0]
    max_speed_kmh = round(max(filtered_speeds), 1) if filtered_speeds else None

    stats = {
        'distance_km': round(distance, 1),
        'elevation_gain_m': round(elevation_gain),
        'points_raw': len(raw_points),
        'points_simplified': len(raw_points),
        'start_time': start_time_iso,
        'elapsed_time_s': round(elapsed_time_s) if elapsed_time_s is not None else None,
        'moving_time_s': round(moving_time_s) if moving_time_s > 0 else None,
        'stopped_time_s': round(elapsed_time_s - moving_time_s) if elapsed_time_s is not None and moving_time_s > 0 else None,
        'avg_speed_kmh': avg_speed_kmh,
        'max_speed_kmh': max_speed_kmh,
    }

    raw_latlng_ts = [
        [lat, lon, ts.timestamp() if ts is not None else None]
        for lat, lon, ele, ts in raw_points
    ]
    return raw_latlng_ts, stats


def _get_first_timestamp(file_path):
    """Read just the first trackpoint timestamp from a GPX file for sorting."""
    from datetime import timezone

    try:
        tree = ET.parse(file_path)
        root = tree.getroot()
        time_el = root.find('.//gpx:trkpt/gpx:time', GPX_NS)
        if time_el is not None:
            return datetime.fromisoformat(time_el.text.replace('Z', '+00:00'))
    except Exception:
        pass
    return datetime.min.replace(tzinfo=timezone.utc)


def load_point_reyes_tracks():
    """Load Point Reyes GPX files and normalize times by ride start."""
    result = {}

    if not POINT_REYES_DIR.exists():
        print(f"WARNING: Point Reyes directory not found: {POINT_REYES_DIR}")
        return result

    raw_by_rider = {}
    for rider_dir in sorted(POINT_REYES_DIR.iterdir()):
        if not rider_dir.is_dir():
            continue
        rider_name = rider_dir.name
        gpx_files = list(rider_dir.glob('*.gpx'))
        if not gpx_files:
            continue
        gpx_files.sort(key=lambda f: _get_first_timestamp(f))

        rides_raw = []
        ride_stats = []
        for gpx_file in gpx_files:
            print(f"  Parsing {rider_name}/{gpx_file.name} ...", end='', flush=True)
            raw_latlng_ts, stats = parse_gpx_with_timestamps(gpx_file)
            rides_raw.append(raw_latlng_ts)
            ride_stats.append(stats)
            moving_str = f", {round(stats['moving_time_s'] / 60)}m moving" if stats.get('moving_time_s') else ''
            print(f" {stats['points_raw']} pts, {stats['distance_km']} km{moving_str}")

        raw_by_rider[rider_name] = {
            'color': POINT_REYES_COLORS.get(rider_name, '#888888'),
            'rides_raw': rides_raw,
            'stats': ride_stats,
        }

    num_rides = max((len(v['rides_raw']) for v in raw_by_rider.values()), default=0)

    for rider_name, rider_data in raw_by_rider.items():
        result[rider_name] = {
            'color': rider_data['color'],
            'rides': [],
            'stats': rider_data['stats'],
        }

    for ride_idx in range(num_rides):
        first_unix = []
        for rider_name, rider_data in raw_by_rider.items():
            if ride_idx < len(rider_data['rides_raw']):
                for lat, lon, ts_unix in rider_data['rides_raw'][ride_idx]:
                    if ts_unix is not None:
                        first_unix.append((ts_unix, rider_name))
                        break

        ride_epoch = min(ts for ts, _ in first_unix) if first_unix else None
        if ride_epoch is not None:
            earliest = min(first_unix, key=lambda x: x[0])[1]
            print(f"  Ride {ride_idx + 1}: epoch = {earliest} (t=0), others offset accordingly")

        for rider_name, rider_data in raw_by_rider.items():
            if ride_idx < len(rider_data['rides_raw']):
                normalized = []
                for lat, lon, ts_unix in rider_data['rides_raw'][ride_idx]:
                    if ts_unix is not None and ride_epoch is not None:
                        t_seconds = round(ts_unix - ride_epoch)
                    else:
                        t_seconds = 0
                    normalized.append([lat, lon, t_seconds])
                result[rider_name]['rides'].append(normalized)
            else:
                result[rider_name]['rides'].append([])

    return result


print('Loading Point Reyes GPX tracks...')
POINT_REYES_TRACKS = load_point_reyes_tracks()
print(f"Done. {sum(len(v['rides']) for v in POINT_REYES_TRACKS.values())} tracks loaded.\n")


@app.route('/')
def index():
    return send_from_directory(str(BASE_DIR), 'index.html')


@app.route('/point_reyes')
def point_reyes_page():
    return send_from_directory(str(BASE_DIR), 'point_reyes.html')


@app.route('/point_reyes_app.js')
def serve_point_reyes_js():
    return send_from_directory(str(BASE_DIR), 'point_reyes_app.js')


@app.route('/point_reyes_simulate')
def point_reyes_simulate_page():
    return send_from_directory(str(BASE_DIR), 'point_reyes_simulate.html')


@app.route('/point_reyes_simulate_app.js')
def serve_point_reyes_simulate_js():
    return send_from_directory(str(BASE_DIR), 'point_reyes_simulate_app.js')


@app.route('/styles.css')
def serve_css():
    return send_from_directory(str(BASE_DIR), 'styles.css')


@app.route('/api/tracks/point_reyes')
def get_point_reyes_tracks():
    return jsonify(POINT_REYES_TRACKS)


if __name__ == '__main__':
    app.run(debug=False, port=5000, host='0.0.0.0')
