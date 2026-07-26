import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- CONFIG ----------------
const TILES_PORT = process.env.TILES_PORT ;
const OSRM_PORT = process.env.OSRM_PORT ;
const OSRM_FOOT_PORT = process.env.OSRM_FOOT_PORT;
const OSRM_BICYCLE_PORT = process.env.OSRM_BICYCLE_PORT;

// Tileserver config
const tileserverConfig = path.join(__dirname, 'config.json');

// OSRM folders (each contains .osrm, .osrm.mldgr, etc. for one travel mode)
const osrmDir = path.join(__dirname, 'mld');
const osrmFile = 'india-latest.osrm';

const footDir = path.join(__dirname, 'mld-foot');
const bicycleDir = path.join(__dirname, 'mld-bicycle');
const profileFile = 'india-260104.osrm';

// ----------------------------------------

// Validate files
if (!fs.existsSync(tileserverConfig)) {
  console.error(' tileserver config.json not found');
  process.exit(1);
}

if (!fs.existsSync(path.join(osrmDir, osrmFile))) {
  console.error(' OSRM file not found');
  process.exit(1);
}

// ---------------- TILESERVER ----------------
console.log(` Starting Tileserver on port ${TILES_PORT}`);

const tileserver = spawn(
  'npx',
  [
    'tileserver-gl-light',
    '--config', tileserverConfig,
    '--port', TILES_PORT
  ],
  { stdio: 'inherit' }
);



// ---------------- OSRM (Docker) ----------------
console.log(`Starting OSRM (Docker) on port ${OSRM_PORT}`);

const osrmServer = spawn(
  'docker',
  [
    'run',
    '--rm',
    '-p', `${OSRM_PORT}:${OSRM_PORT}`,        // host:container port
    '-v', `${osrmDir}:/data`,
    'osrm/osrm-backend:v5.22.0',
    'osrm-routed',
    `/data/${osrmFile}`,
    '--algorithm', 'mld',
    '--port', `${OSRM_PORT}`          // container listens on 5050
  ],
  { stdio: 'inherit' }
);

// ---------------- ERROR HANDLING ----------------
tileserver.on('error', err => {
  console.error(' Tileserver error:', err);
});

osrmServer.on('error', err => {
  console.error(' OSRM Docker error:', err);
  if (err.code === 'ENOENT') {
    console.error('Docker not installed or not in PATH');
  }
});

// ---------------- OSRM: walking + cycling (optional, once built) ----------------
const extraServers = [];

function startModeServer(dir, port, label) {
  if (!fs.existsSync(path.join(dir, profileFile))) {
    console.log(` [${label}] routing data not built yet, skipping (see build-profiles.sh)`);
    return;
  }
  console.log(` Starting OSRM (Docker) for ${label} on port ${port}`);
  const proc = spawn(
    'docker',
    [
      'run', '--rm',
      '-p', `${port}:${port}`,
      '-v', `${dir}:/data`,
      'ghcr.io/project-osrm/osrm-backend:latest',
      'osrm-routed',
      `/data/${profileFile}`,
      '--algorithm', 'mld',
      '--port', `${port}`
    ],
    { stdio: 'inherit' }
  );
  proc.on('error', err => console.error(` OSRM Docker error [${label}]:`, err));
  extraServers.push(proc);
}

startModeServer(footDir, OSRM_FOOT_PORT, 'foot');
startModeServer(bicycleDir, OSRM_BICYCLE_PORT, 'bicycle');

// ---------------- GRACEFUL SHUTDOWN ----------------
const shutdown = () => {
  console.log('\n Shutting down services...');
  if (!tileserver.killed) tileserver.kill();
  if (!osrmServer.killed) osrmServer.kill();
  extraServers.forEach(p => { if (!p.killed) p.kill(); });
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
