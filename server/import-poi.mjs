import fs from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = process.argv[2] || path.join(__dirname, 'india.geojson');

// Priority order: if a feature has more than one of these tags, the first match wins
const CATEGORY_KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft', 'historic', 'sport'];
const BATCH_SIZE = 2000;

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

function centroid(geometry) {
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates;
    return { lat, lng };
  }
  // Good-enough centroid: average the outer ring's vertices
  let ring;
  if (geometry.type === 'Polygon') {
    ring = geometry.coordinates[0];
  } else if (geometry.type === 'MultiPolygon') {
    ring = geometry.coordinates[0][0];
  } else {
    return null;
  }
  if (!ring || !ring.length) return null;
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of ring) { sumLng += lng; sumLat += lat; }
  return { lat: sumLat / ring.length, lng: sumLng / ring.length };
}

async function insertBatch(rows) {
  if (!rows.length) return;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const base = i * 5;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    params.push(r.name, r.category, r.categoryType, r.lat, r.lng);
  });
  await pool.query(
    `INSERT INTO poi (name, category, category_type, latitude, longitude) VALUES ${values.join(',')}`,
    params
  );
}

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_FILE, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  let matched = 0;
  let batch = [];
  const startTime = Date.now();

  for await (const rawLine of rl) {
    lineNum++;
    const line = rawLine.trim().replace(/,$/, '');
    if (!line || line.startsWith('{"type":"FeatureCollection"') || line === ']}' || line === ']' || line === '[') {
      continue;
    }

    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      continue;
    }

    const props = feature.properties || {};
    const name = props.name;
    if (!name) continue;

    const categoryType = CATEGORY_KEYS.find(k => props[k]);
    if (!categoryType) continue;

    const point = centroid(feature.geometry);
    if (!point) continue;

    batch.push({ name, category: props[categoryType], categoryType, lat: point.lat, lng: point.lng });
    matched++;

    if (batch.length >= BATCH_SIZE) {
      await insertBatch(batch);
      batch = [];
    }

    if (lineNum % 1000000 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`[${elapsed}s] processed ${lineNum.toLocaleString()} lines, matched ${matched.toLocaleString()} POIs`);
    }
  }

  await insertBatch(batch);
  console.log(`DONE. Processed ${lineNum.toLocaleString()} lines, imported ${matched.toLocaleString()} POIs.`);
  await pool.end();
}

main().catch(err => {
  console.error('Import failed:', err);
  process.exit(1);
});
