# Offline India Map

A self-hosted, Google Maps-style web app for India: vector map tiles, driving
directions with turn-by-turn steps and multi-stop routing, place/POI search
with autocomplete, current-location support, and 3D buildings — all served
locally, no external map API required.

## Features

- **Map** — vector tiles rendered with MapLibre GL, 3D building extrusions,
  tilt/rotate camera controls
- **Search** — autocomplete across ~4,200 named places and **637,000+ POIs**
  (hospitals, restaurants, temples, shops, schools, etc.) mined from OpenStreetMap
  data, ranked by name similarity
- **Directions** — real driving routes via a local OSRM instance: turn-by-turn
  steps, alternate routes, multi-stop trips (add as many waypoints as you want)
- **Current location** — browser geolocation, with a one-tap "use my location"
  option in every search field
- **Recent places** — your last few selections appear in the search dropdown,
  like Google Maps' history
- **Reverse geocoding** — click anywhere on the map to get the nearest known
  place/POI name instead of raw coordinates

## Architecture

```
client/index.html   MapLibre GL front end (single page, no build step)
server/app.js       Express API: search, routing proxy, reverse geocode, recent places
server/tileserver.mjs   Starts tileserver-gl-light (map tiles) + OSRM (Docker) for driving
server/import-poi.mjs   One-off script that built the poi table from a raw OSM GeoJSON export
```

Data lives in Postgres (PostGIS + pg_trgm) — see [Tables](#database-tables) below.

## Prerequisites

- Node.js 20+
- Docker (for OSRM routing)
- PostgreSQL with the `postgis` and `pg_trgm` extensions

## Setup

The data files (map tiles, routing graph, fonts, and a Postgres dump) are too
large for GitHub and are distributed separately — see the note at the bottom.

### 1. Clone and install

```
git clone https://github.com/visin04/maping_system_offline.git
cd maping_system_offline/server
npm install
```

### 2. Unpack the data bundle

Get `india-map-data.zip` (see [Data bundle](#data-bundle)) and unzip it into
`server/`, so you end up with:

```
server/mld/                 OSRM driving routing graph
server/india.mbtiles        map tiles
server/fonts/               glyph data tileserver-gl needs
server/india_map_dump.sql   Postgres dump
```

### 3. Restore the database

```
createdb -h <host> -p <port> -U postgres india_map
pg_restore -h <host> -p <port> -U postgres -d india_map --no-owner server/india_map_dump.sql
```

### 4. Configure environment

Create `server/.env` (never committed — has your DB password):

```
TILES_PORT=8080
OSRM_PORT=5003
OSRM_FOOT_PORT=5004
OSRM_BICYCLE_PORT=5005
APP_PORT=3000

PGHOST=localhost
PGPORT=<your postgres port>
PGUSER=postgres
PGPASSWORD=<your postgres password>
PGDATABASE=india_map
```

### 5. Run

```
cd server
node tileserver.mjs   # tile server + OSRM (driving), terminal 1
node app.js           # web app, terminal 2
```

Open `http://localhost:3000`.

## Database tables

| Table | Rows | What |
|---|---|---|
| `country` | 244 | Country reference data |
| `state` | 38 | Indian states/UTs |
| `city` | 1,390 | Cities |
| `google_address` | 4,196 | Named places with city/state |
| `poi` | 637,618 | Restaurants, hospitals, temples, shops, etc. |
| `recent_places` | — | Search history for the autocomplete dropdown |

## Known limitations

- **Walking/cycling routing isn't available** — each travel mode needs its own
  OSRM routing graph, and building those for all of India repeatedly ran out
  of memory on the original build machine. Driving works fully; the bike/walk
  tabs stay disabled until that data is built (see `/api/modes`).
- Reverse geocoding returns the *nearest known* place/POI, not a full street
  address — rural areas may return a distant match.

## Data bundle

`india-map-data.zip` (map tiles, routing graph, fonts, DB dump — excluded from
git because several files exceed GitHub's 100MB limit) is shared separately
via Google Drive. Ask the repo owner for the link.
