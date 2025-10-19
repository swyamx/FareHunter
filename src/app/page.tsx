'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Polyline, ScaleControl, useMap } from 'react-leaflet';
import L, { DivIcon, LatLngBoundsExpression } from 'leaflet';
import 'leaflet/dist/leaflet.css';

const MAPBOX = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;
const AUSTIN = { center: { lat: 30.2672, lng: -97.7431 } } as const;

type LatLng = { lat: number; lng: number };
type RouteGeo = { distance: number; duration: number; coords: [number, number][]; label: string; color: string };

const DEG2RAD = Math.PI / 180;
const EARTH_M = 6371000;
const M_TO_FT = 3.28084;

// ---------- tuning ----------
const TAIL_FRACTION = 0.22;      // sample only last ~22% of each route
const SAMPLE_COUNT  = 16;        // candidate points per route tail
const DIST_FACTOR   = 0.90;      // candidate drive must be <= 90% of parent distance (>=10% shorter)
const TIME_FACTOR   = 0.90;      // candidate drive must be <= 90% of parent time
const PRICE_IMPROVE = 0.08;      // modeled fare must be >=8% cheaper vs parent
const CAND_MAX      = 3;         // show at most 3 real alternates

// ---------- icons & helpers ----------
const labeledIcon = (bg: string, text: string) =>
  new DivIcon({
    className: 'custom-pin',
    html: `<div style="display:flex;align-items:center;gap:6px;">
      <div style="width:14px;height:14px;border-radius:50%;background:${bg};box-shadow:0 0 0 3px ${bg}33"></div>
      <span style="background:#0b0b0b;border:1px solid #3f3f46;color:#e5e7eb;font-size:12px;padding:2px 6px;border-radius:8px">${text}</span>
    </div>`
  });

function FlyToBounds({ bounds }: { bounds: LatLngBoundsExpression | null }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    try {
      map.fitBounds(bounds, { padding: [30, 30] });
    } catch { /* ignore */ }
  }, [bounds, map]);
  return null;
}

function haversineMeters(a: LatLng, b: LatLng) {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const lat1 = a.lat * DEG2RAD;
  const lat2 = b.lat * DEG2RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
const metersToFeet = (m: number) => Math.round(m * M_TO_FT);
const metersToMinWalk = (m: number, speedMps = 1.33) => Math.round(m / speedMps / 60);
function seededRand(seed: number) { const x = Math.sin(seed) * 10000; return x - Math.floor(x); }
function estimateETAmin(pickup: LatLng, seed = Date.now() / 30000) { return Math.floor(2 + seededRand(seed + pickup.lat + pickup.lng) * 6); }

// ---------- price model (fallback) ----------
function modeledPriceUSD(distance_m: number, duration_s: number) {
  const miles = distance_m / 1609.34;
  const mins  = duration_s / 60;
  const base = 2.25, perMile = 1.50, perMin = 0.33, service = 1.2;
  const h = new Date().getHours();
  const rush = (h >= 7 && h <= 9) || (h >= 16 && h <= 19);
  const surge = rush ? 1.18 + seededRand(Math.floor(Date.now() / 60000)) * 0.35 : 1.0 + seededRand(Math.floor(Date.now() / 120000)) * 0.18;
  const est = (base + perMile * miles + perMin * mins + service) * surge;
  const center = Math.max(5, est);
  return { low: Math.max(4.5, center * 0.9), high: center * 1.12, center };
}

// ---------- Mapbox Directions ----------
async function mapboxDirections(
  points: LatLng[],
  opts?: { alternatives?: boolean; profile?: 'driving-traffic' | 'driving' | 'walking'; geometries?: 'geojson' | 'polyline' }
) {
  const profile = opts?.profile ?? 'driving-traffic';
  const geoms   = opts?.geometries ?? 'geojson';
  const coords  = points.map(p => `${p.lng},${p.lat}`).join(';');
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/${coords}?access_token=${MAPBOX}` +
    `&alternatives=${opts?.alternatives ? 'true' : 'false'}` +
    `&geometries=${geoms}&overview=full&annotations=duration,distance`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const routes = (j?.routes || []) as any[];
  return routes.map(rt => ({
    distance: rt.distance as number,
    duration: rt.duration as number,
    coords: (rt.geometry?.coordinates ?? []) as [number, number][],
  })) as { distance: number; duration: number; coords: [number, number][] }[];
}

async function mapboxDrive(pu: LatLng, to: LatLng) {
  const r = await mapboxDirections([pu, to], { profile: 'driving-traffic', alternatives: false });
  return r?.[0] ?? null;
}
async function mapboxWalk(a: LatLng, b: LatLng) {
  const r = await mapboxDirections([a, b], { profile: 'walking', alternatives: false });
  return r?.[0] ?? null;
}

// ---------- reverse geocode (short line) ----------
async function reverseShort(p: LatLng) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${p.lng},${p.lat}.json?access_token=${MAPBOX}&limit=1&types=address,poi`;
  const r = await fetch(url);
  if (!r.ok) return '';
  const j = await r.json();
  const f = j?.features?.[0];
  if (!f) return '';
  const place = String(f.place_name || '');
  const first = place.split(',')[0]?.trim();
  if (f.properties?.address && !/\d/.test(first)) return `${first} · ${f.properties.address}`;
  return first || f.text || place;
}

// ---------- Foursquare (legacy v2 proxy) ----------
async function fsqSuggest(q: string, proximity?: LatLng) {
  const ll = proximity ? `${proximity.lat},${proximity.lng}` : '';
  const url = `/api/places/search?q=${encodeURIComponent(q)}&limit=10${ll ? `&ll=${encodeURIComponent(ll)}` : '&near=Austin,TX'}`;
  const r = await fetch(url);
  if (!r.ok) return [];
  const j = await r.json();
  return (j?.features || []) as { label: string; subtitle?: string; lat: number; lng: number }[];
}

// ---------- small utils ----------
function useDebounced<T>(value: T, delay = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), delay); return () => clearTimeout(id); }, [value, delay]);
  return v;
}
function priceText(q?: { low?: number; high?: number; center?: number }) {
  if (!q) return '…';
  if (q.low && q.high) return `$${q.low.toFixed(2)} – $${q.high.toFixed(2)}`;
  if (q.center)       return `$${q.center.toFixed(2)}`;
  return '—';
}
function savings(candidate: { center?: number; low?: number }, base?: { center?: number; low?: number }) {
  const baseVal = (base?.center ?? base?.low ?? 0);
  const candVal = (candidate.center ?? candidate.low ?? 0);
  if (!baseVal || !candVal) return null;
  return Math.max(0, baseVal - candVal);
}

// ---------- route-tail sampling ----------
function sampleTail(coords: [number, number][], count = SAMPLE_COUNT, fraction = TAIL_FRACTION) {
  if (!coords.length) return [];
  const n = coords.length;
  const startIdx = Math.max(0, Math.floor(n * (1 - fraction)) - 1);
  const slice = coords.slice(startIdx, n - 1);
  const out: LatLng[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const idx = Math.min(slice.length - 1, Math.floor(t * (slice.length - 1)));
    const [lng, lat] = slice[idx];
    out.push({ lat, lng });
  }
  // dedupe close
  const uniq: LatLng[] = [];
  const seen = new Set<string>();
  for (const p of out) {
    const key = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(p); }
  }
  return uniq;
}

// ---------- AddressInput ----------
function AddressInput({
  label, value, setValue, onPick, proximity
}: {
  label: string; value: string; setValue: (s: string) => void;
  onPick: (p: { lat: number; lng: number; label: string }) => void;
  proximity?: LatLng | null;
}) {
  const [open, setOpen] = useState(false);
  const [sugs, setSugs] = useState<{ label: string; subtitle?: string; lat: number; lng: number }[]>([]);
  const deb = useDebounced(value, 250);

  useEffect(() => {
    let ok = true;
    (async () => {
      if (deb.trim().length < 2) { setSugs([]); return; }
      const r = await fsqSuggest(deb.trim(), proximity || undefined);
      if (ok) setSugs(r);
    })();
    return () => { ok = false; };
  }, [deb, proximity]);

  return (
    <div className="relative">
      <div className="text-sm text-zinc-400 mb-1">{label}</div>
      <input
        value={value}
        onChange={(e) => { setValue(e.target.value); setOpen(true); }}
        placeholder="Search places or addresses (e.g., PCL, P. Terry’s, ION)"
        className="w-full bg-zinc-800/70 rounded-xl px-3 py-2 outline-none"
      />
      {open && sugs.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-72 overflow-auto w-full bg-zinc-900 border border-zinc-700 rounded-xl shadow">
          {sugs.map((s, i) => (
            <button
              key={i}
              className="w-full text-left px-3 py-2 hover:bg-zinc-800 text-sm"
              onClick={() => {
                setValue(s.subtitle ? `${s.label} · ${s.subtitle}` : s.label);
                setOpen(false);
                onPick({ lat: s.lat, lng: s.lng, label: s.label });
              }}
            >
              <div className="font-medium">{s.label}</div>
              {s.subtitle && <div className="text-[12px] text-zinc-400">{s.subtitle}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- colors ----------
const REG_COLORS  = ['#60a5fa', '#a78bfa'];             // Regular A/B
const CAND_COLORS = ['#34d399', '#f59e0b', '#ef4444'];  // Candidate 1–3

type Candidate = {
  drop: LatLng;
  walkMin: number;
  drive: { distance_m: number; duration_s: number; coords: [number, number][] };
  walk:  { distance_m: number; duration_s: number; coords: [number, number][] };
  parent: 'Regular A' | 'Regular B';
  color: string;
};

export default function Page() {
  const [pickupAddr, setPickupAddr] = useState('Lark Austin');
  const [dropAddr,   setDropAddr]   = useState('UT Austin Main Building');
  const [pickup, setPickup] = useState<LatLng | null>(null);
  const [drop,   setDrop]   = useState<LatLng | null>(null);
  const [radiusM, setRadiusM] = useState<number>(400);

  const [regularRoutes, setRegularRoutes] = useState<RouteGeo[]>([]);
  const [baselineAddr,  setBaselineAddr]  = useState<string>('');

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [addrMap, setAddrMap] = useState<Record<string, string>>({}); // key: "lat,lng" -> addr

  // quick resolve defaults
  useEffect(() => {
    (async () => {
      if (!pickup) {
        const r = await fsqSuggest('Lark Austin');
        if (r[0]) setPickup({ lat: r[0].lat, lng: r[0].lng });
      }
      if (!drop) {
        const r = await fsqSuggest('UT Austin Main Building');
        if (r[0]) setDrop({ lat: r[0].lat, lng: r[0].lng });
      }
    })();
  }, []); // eslint-disable-line

  // build regular routes (traffic-aware, up to 2)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pickup || !drop) return;

      const routes = await mapboxDirections([pickup, drop], { profile: 'driving-traffic', alternatives: true });
      if (!routes || routes.length === 0) { if (alive) setRegularRoutes([]); return; }

      // sort by duration (fastest first), keep 1–2
      routes.sort((a, b) => a.duration - b.duration);
      const regs = routes.slice(0, 2).map((r, i) => ({
        ...r,
        label: `Regular ${String.fromCharCode(65 + i)}`,
        color: REG_COLORS[i % REG_COLORS.length],
      })) as RouteGeo[];

      if (!alive) return;
      setRegularRoutes(regs);

      try {
        const rev = await reverseShort(drop);
        if (alive && rev) setBaselineAddr(rev);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [pickup?.lat, pickup?.lng, drop?.lat, drop?.lng]); // eslint-disable-line

  // compute real alternates (candidates) from the tail of each regular route
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pickup || !drop || regularRoutes.length === 0) { setCandidates([]); return; }

      const all: Candidate[] = [];

      for (const r of regularRoutes) {
        const parentLabel = r.label as 'Regular A' | 'Regular B';
        const baseDist = r.distance, baseTime = r.duration;
        const tailPts = sampleTail(r.coords, SAMPLE_COUNT, TAIL_FRACTION);

        for (const p of tailPts) {
          if (haversineMeters(p, drop) < 12) continue;

          // walking constraint
          const wk = await mapboxWalk(p, drop);
          const walkMin = wk ? Math.round(wk.duration / 60) : metersToMinWalk(haversineMeters(p, drop));
          if (walkMin > metersToMinWalk(radiusM) + 1) continue;

          // drive pickup -> candidate
          const drv = await mapboxDrive(pickup, p);
          if (!drv) continue;

          // strictly shorter by time & distance vs parent
          const distOK = drv.distance <= DIST_FACTOR * baseDist;
          const timeOK = drv.duration <= TIME_FACTOR * baseTime;
          if (!(distOK && timeOK)) continue;

          // price improvement vs parent
          const baseModel = modeledPriceUSD(baseDist, baseTime).center;
          const candModel = modeledPriceUSD(drv.distance, drv.duration).center;
          if ((baseModel - candModel) / baseModel < PRICE_IMPROVE) continue;

          all.push({
            drop: p,
            walkMin,
            drive: { distance_m: drv.distance, duration_s: drv.duration, coords: drv.coords },
            walk:  { distance_m: wk?.distance ?? 0, duration_s: wk?.duration ?? walkMin * 60, coords: wk?.coords ?? [[p.lng,p.lat],[drop.lng,drop.lat]] },
            parent: parentLabel,
            color: CAND_COLORS[all.length % CAND_COLORS.length],
          });
        }
      }

      // sort by modeled fare then stricter distance/time, de-dup & cap to 3
      all.sort((a, b) => {
        const am = modeledPriceUSD(a.drive.distance_m, a.drive.duration_s).center;
        const bm = modeledPriceUSD(b.drive.distance_m, b.drive.duration_s).center;
        if (am !== bm) return am - bm;
        return (a.drive.distance_m * 1.5 + a.drive.duration_s) - (b.drive.distance_m * 1.5 + b.drive.duration_s);
      });

      const dedup: Candidate[] = [];
      const seen = new Set<string>();
      for (const c of all) {
        const key = `${c.drop.lat.toFixed(5)},${c.drop.lng.toFixed(5)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(c);
        if (dedup.length >= CAND_MAX) break;
      }

      if (alive) setCandidates(dedup);
    })();
    return () => { alive = false; };
  }, [regularRoutes.map(r => r.label).join('|'), radiusM, pickup?.lat, pickup?.lng, drop?.lat, drop?.lng]); // eslint-disable-line

  // fetch addresses for candidates (no hooks-in-loop)
  useEffect(() => {
    let alive = true;
    (async () => {
      const entries = await Promise.all(
        candidates.map(async (c) => {
          const key = `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`;
          if (addrMap[key]) return [key, addrMap[key]] as const;
          const s = await reverseShort(c.drop);
          return [key, s || ''] as const;
        })
      );
      if (!alive) return;
      const next = { ...addrMap };
      for (const [k, v] of entries) if (v) next[k] = v;
      setAddrMap(next);
    })();
    return () => { alive = false; };
  }, [candidates.map(c => `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`).join('|')]); // eslint-disable-line

  // UI helpers
  const radiusFt    = Math.round(radiusM * M_TO_FT);
  const maxWalkMin  = metersToMinWalk(radiusM);
  const baselineETA = pickup ? estimateETAmin(pickup) : null;

  function uberLink(pu: LatLng, to: LatLng, nickname?: string) {
    const qs = new URLSearchParams({
      action: 'setPickup',
      'pickup[latitude]': String(pu.lat),
      'pickup[longitude]': String(pu.lng),
      'dropoff[latitude]': String(to.lat),
      'dropoff[longitude]': String(to.lng),
    });
    if (nickname) qs.set('dropoff[nickname]', nickname);
    return `https://m.uber.com/ul/?${qs.toString()}`;
  }

  // map bounds
  const mapBounds = useMemo<LatLngBoundsExpression | null>(() => {
    if (!pickup || !drop) return null;
    const pts: [number, number][] = [
      [pickup.lat, pickup.lng],
      [drop.lat,   drop.lng],
    ];
    for (const r of regularRoutes) {
      for (const [lng, lat] of r.coords) pts.push([lat, lng]);
    }
    for (const c of candidates) {
      for (const [lng, lat] of c.drive.coords) pts.push([lat, lng]);
      for (const [lng, lat] of c.walk.coords)  pts.push([lat, lng]);
    }
    if (pts.length < 2) return null;
    const latMin = Math.min(...pts.map(p => p[0])), latMax = Math.max(...pts.map(p => p[0]));
    const lngMin = Math.min(...pts.map(p => p[1])), lngMax = Math.max(...pts.map(p => p[1]));
    return [[latMin, lngMin], [latMax, lngMax]];
  }, [pickup?.lat, pickup?.lng, drop?.lat, drop?.lng, regularRoutes.map(r => r.coords.length).join(','), candidates.length]);

  // map center fallback
  const mapCenter = drop || pickup || AUSTIN.center;

  return (
    <main className="min-h-screen w-full bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Fare-Hunter</h1>
        <p className="text-zinc-300 mt-2">Shows **two traffic-aware regular routes** and up to **three real money-saving drop-offs** taken from the routes’ tails. Each alternate **reduces drive time & distance** and keeps your walk under the limit.</p>

        {/* Inputs */}
        <div className="mt-6 grid md:grid-cols-3 gap-4">
          <div className="rounded-2xl p-4 bg-zinc-900/50 border border-zinc-800">
            <AddressInput label="Pickup" value={pickupAddr} setValue={setPickupAddr} proximity={pickup}
              onPick={(p) => setPickup({ lat: p.lat, lng: p.lng })} />
            <div className="mt-2 flex gap-2">
              <button onClick={() => {
                if (!('geolocation' in navigator)) return alert('Geolocation not supported.');
                navigator.geolocation.getCurrentPosition(
                  (pos) => setPickup({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
                  (err) => alert('Location error: ' + err.message),
                  { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
                );
              }} className="px-3 py-1.5 rounded-lg border border-zinc-700 hover:bg-zinc-800 text-xs">Use my location</button>
            </div>
          </div>

          <div className="rounded-2xl p-4 bg-zinc-900/50 border border-zinc-800">
            <AddressInput label="Drop-off (final)" value={dropAddr} setValue={setDropAddr} proximity={pickup}
              onPick={(p) => setDrop({ lat: p.lat, lng: p.lng })} />
          </div>

          <div className="rounded-2xl p-4 bg-zinc-900/50 border border-zinc-800">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-zinc-400">Max walk to final</div>
                <div className="text-lg font-medium">{radiusFt.toLocaleString()} ft</div>
                <div className="text-xs text-zinc-400">≈ {maxWalkMin} min walk</div>
              </div>
              <input className="w-40" type="range" min={150} max={1200} step={25}
                     value={radiusM} onChange={(e) => setRadiusM(parseInt(e.target.value))} />
            </div>
          </div>
        </div>

        {/* Map */}
        <div className="mt-6 rounded-2xl overflow-hidden border border-zinc-800">
          <MapContainer center={[mapCenter.lat, mapCenter.lng]} zoom={13} style={{ height: 520, width: '100%' }} scrollWheelZoom className="bg-zinc-900">
            <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <ScaleControl imperial metric={false} position="bottomleft" />

            {pickup && <Marker position={[pickup.lat, pickup.lng]} icon={labeledIcon('#38bdf8', 'Pickup')} />}
            {drop   && <Marker position={[drop.lat, drop.lng]}   icon={labeledIcon('#22c55e', 'Final')} />}
            {drop   && <Circle center={[drop.lat, drop.lng]} radius={radiusM} pathOptions={{ color: '#e879f9', dashArray: '6 6', weight: 2, opacity: 0.8 }} />}

            {/* regular routes (A/B) */}
            {regularRoutes.map((r, i) => (
              <Polyline key={`reg-${i}`} positions={r.coords.map(([lng, lat]) => [lat, lng]) as any}
                        pathOptions={{ color: r.color, weight: 5, opacity: 0.9 }} />
            ))}

            {/* real alternates: drive (solid) + walk (dashed) */}
            {candidates.map((c, i) => (
              <React.Fragment key={`cand-path-${i}`}>
                <Polyline positions={c.drive.coords.map(([lng, lat]) => [lat, lng]) as any}
                          pathOptions={{ color: c.color, weight: 4, opacity: 0.85 }} />
                <Polyline positions={c.walk.coords.map(([lng, lat]) => [lat, lng]) as any}
                          pathOptions={{ color: c.color, weight: 2, opacity: 0.8, dashArray: '6 6' }} />
                <Marker position={[c.drop.lat, c.drop.lng]} icon={labeledIcon(c.color, `Alt ${i + 1}`)} />
              </React.Fragment>
            ))}

            <FlyToBounds bounds={mapBounds} />
          </MapContainer>
        </div>

        {/* Regular routes list */}
        <div className="mt-6 rounded-2xl p-4 bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Regular routes</h3>
            {baselineETA !== null && <div className="text-sm text-zinc-400">ETA (mock): {baselineETA} min</div>}
          </div>
          {regularRoutes.length === 0 && <div className="text-sm text-zinc-400 mt-2">No regular routes.</div>}
          {regularRoutes.map((r, i) => {
            const price = modeledPriceUSD(r.distance, r.duration);
            return (
              <div key={`regc-${i}`} className="mt-3 p-3 rounded-xl border border-zinc-800">
                <div className="text-sm font-medium" style={{ color: r.color }}>● {r.label}</div>
                <div className="text-xs text-zinc-400">{Math.round(r.duration/60)} min • {(r.distance/1609.34).toFixed(1)} mi</div>
                <div className="mt-1 text-2xl font-semibold">{priceText(price)}</div>
                <div className="mt-1 flex items-center gap-2 text-sm text-zinc-300">
                  <span>Exact drop-off:</span>
                  <span className="font-medium">{baselineAddr || dropAddr}</span>
                  <button className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800"
                          onClick={() => navigator.clipboard.writeText(baselineAddr || dropAddr)}>
                    Copy address
                  </button>
                </div>
                {pickup && drop && (
                  <div className="mt-2">
                    <a href={uberLink(pickup, drop)} target="_blank" rel="noreferrer"
                       className="px-3 py-2 rounded-xl bg-emerald-400 text-zinc-950 font-semibold hover:bg-emerald-300">Open in Uber</a>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Real alternates (money-saving) */}
        <div className="mt-8">
          <h3 className="text-lg font-semibold">Cheaper on-the-way drop-offs</h3>
          {candidates.length === 0 && (
            <div className="text-sm text-zinc-400 mt-2">No cheaper on-the-way options within your walk limit yet.</div>
          )}
          <div className="mt-3 grid md:grid-cols-2 gap-4">
            {candidates.map((c, idx) => {
              const price = modeledPriceUSD(c.drive.distance_m, c.drive.duration_s);
              const parent = regularRoutes.find(r => r.label === c.parent);
              const basePrice = parent ? modeledPriceUSD(parent.distance, parent.duration) : undefined;
              const saved = savings(price, basePrice);
              const key = `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`;
              const addr = addrMap[key] || '…';
              const walkFt = metersToFeet((c.walkMin * 60) * 1.33);
              const deltaMin  = parent ? ((parent.duration - c.drive.duration_s) / 60) : 0;
              const deltaDist = parent ? (1 - c.drive.distance_m / parent.distance) * 100 : 0;

              return (
                <div key={`candc-${idx}`} className="rounded-2xl p-4 bg-zinc-900/60 border border-zinc-800 hover:border-zinc-600">
                  <div className="text-sm font-medium" style={{ color: c.color }}>● Alternate {idx + 1} (vs {c.parent})</div>
                  <div className="text-xs text-zinc-400">{Math.round(c.drive.duration_s/60)} min drive • {(c.drive.distance_m/1609.34).toFixed(1)} mi</div>
                  <div className="mt-1 text-2xl font-semibold">{priceText(price)}</div>

                  <div className="mt-1 flex items-center gap-2 text-sm text-zinc-300">
                    <span>Exact drop-off to save $:</span>
                    <span className="font-medium">{addr}</span>
                    <button className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800"
                            onClick={() => navigator.clipboard.writeText(addr)}>Copy address</button>
                  </div>

                  <div className="mt-1 text-sm text-zinc-300">
                    Walk to final: <span className="font-medium">~{c.walkMin} min</span> ({walkFt.toLocaleString()} ft) •
                    Drive vs {c.parent}: <span className="font-medium">−{deltaMin.toFixed(1)} min, −{deltaDist.toFixed(0)}%</span>
                  </div>

                  {pickup && (
                    <div className="mt-3 flex gap-2">
                      <a href={uberLink(pickup, c.drop, addr)} target="_blank" rel="noreferrer"
                         className="px-3 py-2 rounded-xl bg-emerald-400 text-zinc-950 font-semibold hover:bg-emerald-300">Open in Uber</a>
                      <button className="px-3 py-2 rounded-xl border border-zinc-700 hover:bg-zinc-800"
                              onClick={() => navigator.clipboard.writeText(`${c.drop.lat.toFixed(6)}, ${c.drop.lng.toFixed(6)}`)}>
                        Copy coords
                      </button>
                    </div>
                  )}

                  {saved !== null && saved > 0 && (
                    <div className="mt-2 inline-block text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-600 text-emerald-300">
                      Save ~${saved.toFixed(2)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4 text-xs text-zinc-500">
            We request Mapbox’s traffic-aware routes, then find drop-offs along the visible routes’ tails that shorten actual drive time & distance while keeping your walk within the selected limit. Alternates are drawn on the map: solid = drive, dashed = walk.
          </div>
        </div>
      </div>
    </main>
  );
}
