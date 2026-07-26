import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_PORT = process.env.APP_PORT || 3000;
const TILES_PORT = process.env.TILES_PORT;

const MODE_PORTS = {
  driving: process.env.OSRM_PORT,
  walking: process.env.OSRM_FOOT_PORT,
  cycling: process.env.OSRM_BICYCLE_PORT,
};

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'client')));

// Search places (city/state level) and POIs (restaurants, shops, hospitals, etc.)
// together, ranked by name similarity, like Google Maps' mixed autocomplete
app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const { rows } = await pool.query(
      `(
         SELECT name, address, admin AS city, province AS state,
                NULL AS category, latitude, longitude,
                similarity(name, $1) AS score
         FROM google_address
         WHERE name ILIKE '%' || $1 || '%' OR address ILIKE '%' || $1 || '%'
         ORDER BY score DESC
         LIMIT 10
       )
       UNION ALL
       (
         SELECT name, NULL AS address, NULL AS city, NULL AS state,
                category, latitude, longitude,
                similarity(name, $1) AS score
         FROM poi
         WHERE name ILIKE '%' || $1 || '%'
         ORDER BY score DESC
         LIMIT 10
       )
       ORDER BY score DESC
       LIMIT 10`,
      [q]
    );
    res.json(rows);
  } catch (err) {
    console.error('search error:', err);
    res.status(500).json({ error: 'search failed' });
  }
});

// Proxy directions to the local OSRM instance for the requested travel mode.
// Supports multi-stop trips via an optional `waypoints` JSON array of {lat,lng}
// inserted between the from and to points, e.g. waypoints=[{"lat":1,"lng":2}]
app.get('/api/route', async (req, res) => {
  const { fromLat, fromLng, toLat, toLng, mode = 'driving', waypoints } = req.query;
  if (!fromLat || !fromLng || !toLat || !toLng) {
    return res.status(400).json({ error: 'fromLat, fromLng, toLat, toLng are required' });
  }

  const port = MODE_PORTS[mode];
  if (!port) {
    return res.status(400).json({ error: `unsupported mode: ${mode}` });
  }

  let stops = [];
  if (waypoints) {
    try {
      stops = JSON.parse(waypoints);
    } catch {
      return res.status(400).json({ error: 'waypoints must be a JSON array of {lat,lng}' });
    }
  }

  const coords = [
    `${fromLng},${fromLat}`,
    ...stops.map(p => `${p.lng},${p.lat}`),
    `${toLng},${toLat}`,
  ].join(';');

  // Alternatives only make sense for a simple two-point trip
  const alternatives = stops.length === 0;

  try {
    const url = `http://localhost:${port}/route/v1/${mode}/${coords}?overview=full&geometries=geojson&steps=true&alternatives=${alternatives}`;
    const osrmRes = await fetch(url);
    const data = await osrmRes.json();
    res.json(data);
  } catch (err) {
    console.error('route error:', err);
    res.status(500).json({ error: 'routing failed' });
  }
});

// Reverse geocode a coordinate to a human-readable label (nearest known place)
app.get('/api/reverse', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat, lng are required' });

  try {
    const point = `ST_SetSRID(ST_MakePoint($2, $1), 4326)`;
    const { rows } = await pool.query(
      `(
         SELECT name, address, NULL AS category,
                sqrt((latitude - $1)^2 + (longitude - $2)^2) AS dist2
         FROM google_address
         ORDER BY dist2 ASC
         LIMIT 1
       )
       UNION ALL
       (
         SELECT name, NULL AS address, category,
                geom <-> ${point} AS dist2
         FROM poi
         ORDER BY geom <-> ${point} ASC
         LIMIT 1
       )
       ORDER BY dist2 ASC
       LIMIT 1`,
      [Number(lat), Number(lng)]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('reverse geocode error:', err);
    res.status(500).json({ error: 'reverse geocode failed' });
  }
});

// Recently selected places, most recent first (used to populate the search
// dropdown before the user has typed anything, like Google Maps' history)
app.get('/api/recent', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (label) id, label, latitude, longitude, created_at
       FROM recent_places
       ORDER BY label, created_at DESC`
    );
    rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(rows.slice(0, 5));
  } catch (err) {
    console.error('recent places error:', err);
    res.status(500).json({ error: 'failed to load recent places' });
  }
});

app.post('/api/recent', async (req, res) => {
  const { label, lat, lng } = req.body || {};
  if (!label || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'label, lat, lng are required' });
  }

  try {
    await pool.query(
      `INSERT INTO recent_places (label, latitude, longitude) VALUES ($1, $2, $3)`,
      [label, Number(lat), Number(lng)]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('save recent place error:', err);
    res.status(500).json({ error: 'failed to save recent place' });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ tilesPort: Number(TILES_PORT) });
});

// Report which travel modes have a live OSRM instance to route against
app.get('/api/modes', async (req, res) => {
  const entries = await Promise.all(
    Object.entries(MODE_PORTS).map(async ([mode, port]) => {
      try {
        const r = await fetch(`http://localhost:${port}/route/v1/${mode}/77.2,28.6;77.21,28.61`);
        return [mode, r.ok];
      } catch {
        return [mode, false];
      }
    })
  );
  res.json(Object.fromEntries(entries));
});

app.listen(APP_PORT, () => {
  console.log(`App server listening on http://localhost:${APP_PORT}`);
});
