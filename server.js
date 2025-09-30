import express from "express";
import fetch from "node-fetch";
import path from "path";

const app = express();
const __dirname = path.resolve();

/* -------- Config (safe defaults) -------- */
const BASE_PORT = Number(process.env.PORT) || 3000;
const THINGSPEAK_CHANNEL = process.env.THINGSPEAK_CHANNEL || "270748"; // change if you like
const THINGSPEAK_READ_KEY = process.env.THINGSPEAK_READ_KEY || "";     // only if your channel is private
const THINGSPEAK_URL =
  `https://api.thingspeak.com/channels/${THINGSPEAK_CHANNEL}/feeds.json?results=2` +
  (THINGSPEAK_READ_KEY ? `&api_key=${THINGSPEAK_READ_KEY}` : "");

const SITE_LAT = Number(process.env.SITE_LAT ?? -37.8136);  // Melbourne
const SITE_LON = Number(process.env.SITE_LON ?? 144.9631);

/* -------- Static files & JSON body parsing -------- */
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/* -------- Weather API proxy -------- */
app.get("/api/weather", async (_req, res) => {
  try {
    const r = await fetch(THINGSPEAK_URL);
    if (!r.ok) throw new Error(`ThingSpeak error ${r.status}`);
    const data = await r.json();
    const latest = data.feeds?.[data.feeds.length - 1] || {};
    const reading = {
      temperature: asNum(latest.field1),
      humidity: asNum(latest.field2),
      pressure: asNum(latest.field3),
      windSpeed: asNum(latest.field4),
      readAt: latest.created_at
    };
    res.json({ ok: true, reading });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});
const asNum = v => (Number.isFinite(Number(v)) ? Number(v) : null);

/* -------- Simple object catalog + visibility -------- */
const CATALOG = [
  { id:"M31", name:"M31 - Andromeda Galaxy", ra:"00h 42m 44s", dec:"+41° 16′ 09″", magnitude:3.4, type:"Spiral Galaxy", fov:"1.2° × 0.8°" },
  { id:"M42", name:"M42 - Orion Nebula",    ra:"05h 35m 17s", dec:"-05° 23′ 28″", magnitude:4.0, type:"Emission Nebula", fov:"1.0° × 0.7°" },
  { id:"M45", name:"M45 - Pleiades",        ra:"03h 47m 24s", dec:"+24° 07′ 00″", magnitude:1.6, type:"Open Cluster",   fov:"2.0° × 1.5°" },
  { id:"M13", name:"M13 - Hercules Cluster",ra:"16h 41m 41s", dec:"+36° 27′ 37″", magnitude:5.8, type:"Globular Cluster",fov:"0.5° × 0.5°" }
];

app.get("/api/objects", (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  if (!q) return res.json(CATALOG);
  const results = CATALOG.filter(
    o => o.id.toLowerCase().includes(q) ||
         o.name.toLowerCase().includes(q) ||
         o.type.toLowerCase().includes(q)
  );
  res.json(results);
});

app.get("/api/objects/visible", (req, res) => {
  const lat = Number(req.query.lat ?? SITE_LAT);
  const lon = Number(req.query.lon ?? SITE_LON);
  const iso = req.query.time ? new Date(req.query.time) : new Date();
  const minAlt = Number(req.query.minAlt ?? 15);

  const out = CATALOG.map(o => {
    const raDeg  = raToDeg(o.ra);
    const decDeg = decToDeg(o.dec);
    const alt = altitudeDeg(iso, lat, lon, raDeg, decDeg);
    return { ...o, altitude: Number(alt.toFixed(1)), visible: alt >= minAlt };
  });

  res.json(out.filter(x => x.visible));
});

/* -------- Telescope state (simulated) -------- */
let trackingActive = true;
let scope = {
  az: 127.5, el: 35.2,
  ra: CATALOG[0].ra, dec: CATALOG[0].dec,
  target: CATALOG[0].name,
  exposure: 30, filter: "Luminance", binning: "1x1", gain: 100, roi: null,
  fov: CATALOG[0].fov
};

app.get("/api/telescope/status", (_req, res) => {
  res.json({ ...scope, trackingActive });
});

app.post("/api/telescope/config", (req, res) => {
  const { exposure, filter, binning, gain, tracking, roi } = req.body || {};
  if (exposure != null) scope.exposure = Number(exposure);
  if (filter) scope.filter = String(filter);
  if (binning) scope.binning = String(binning);
  if (gain != null) scope.gain = Number(gain);
  if (tracking != null) trackingActive = !!tracking;
  if (roi) scope.roi = roi;
  res.json({ ok: true, scope });
});

app.post("/api/telescope/target", (req, res) => {
  const { id } = req.body || {};
  const found = CATALOG.find(o => o.id === id);
  if (!found) return res.status(404).json({ ok: false, error: "Object not found" });
  scope = { ...scope, ra: found.ra, dec: found.dec, target: found.name, fov: found.fov };
  trackingActive = true;
  res.json({ ok: true, scope });
});

/* -------- Astro math helpers -------- */
function raToDeg(hms){
  const m = /(\d+)\D+(\d+)\D+(\d+(?:\.\d+)?)/.exec(hms);
  if (!m) return 0;
  const h = Number(m[1]), mi = Number(m[2]), s = Number(m[3]);
  return (h + mi/60 + s/3600) * 15.0;
}
function decToDeg(dms){
  const m = /([+\-]?\d+)\D+(\d+)\D+(\d+(?:\.\d+)?)/.exec(dms.replace("−","-"));
  if (!m) return 0;
  const sign = Number(m[1]) < 0 ? -1 : 1;
  const d = Math.abs(Number(m[1])), mi = Number(m[2]), s = Number(m[3]);
  return sign * (d + mi/60 + s/3600);
}
function altitudeDeg(dateUTC, latDeg, lonDeg, raDeg, decDeg){
  const jd = julianDate(dateUTC);
  const gst = greenwichSiderealTime(jd);
  const lst = (gst + lonDeg + 360) % 360;
  const ha = toRad(((lst - raDeg + 540) % 360) - 180);
  const dec = toRad(decDeg);
  const lat = toRad(latDeg);
  const sinAlt = Math.sin(dec)*Math.sin(lat) + Math.cos(dec)*Math.cos(lat)*Math.cos(ha);
  return toDeg(Math.asin(sinAlt));
}
function julianDate(date){ return date.getTime()/86400000 + 2440587.5; }
function greenwichSiderealTime(jd){
  const T = (jd - 2451545.0)/36525.0;
  let th = 280.46061837 + 360.98564736629*(jd - 2451545.0) + 0.000387933*T*T - T*T*T/38710000.0;
  return ((th % 360) + 360) % 360;
}
const toRad = d => d*Math.PI/180;
const toDeg = r => r*180/Math.PI;

/* -------- Start (with port fallback) -------- */
function start(port) {
  const server = app.listen(port, () => {
    console.log(`Remote Astronomy Portal running on http://localhost:${port}`);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const next = port + 1;
      console.warn(`Port ${port} in use. Trying ${next}...`);
      start(next);
    } else {
      throw err;
    }
  });
}
start(BASE_PORT);
