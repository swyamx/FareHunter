'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Polyline, ScaleControl, useMap } from 'react-leaflet';
import L, { DivIcon } from 'leaflet';
import 'leaflet/dist/leaflet.css';

const MAPBOX = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;
const AUSTIN = { center: { lat: 30.2672, lng: -97.7431 } } as const;

type LatLng = { lat: number; lng: number };
type RouteGeo = {
  distance: number; duration: number; coords: [number, number][];
  label: string; color: string; kind: 'regular' | 'alternate'
};

const DEG2RAD = Math.PI / 180;
const EARTH_M = 6371000;
const M_TO_FT = 3.28084;

// ---------- tuning (strict pass) ----------
const TAIL_FRACTION = 0.22;
const SAMPLE_COUNT  = 16;
const DIST_FACTOR   = 0.90;
const TIME_FACTOR   = 0.90;
const PRICE_IMPROVE = 0.08;
const ALT_OVERLAP_TOL_M = 60;
const ALT_MAX = 3;
const REG_MAX = 2;

// ---------- fallback (lenient) ----------
const LOOSE_DIST_FACTOR = 0.98;
const LOOSE_TIME_FACTOR = 0.98;
const LOOSE_PRICE_IMPROVE = 0.00;

// ---------- icons ----------
const labeledIcon = (bg: string, text: string) =>
  new DivIcon({
    className: 'custom-pin',
    html: `<div style="display:flex;align-items:center;gap:6px;">
      <div style="width:14px;height:14px;border-radius:50%;background:${bg};box-shadow:0 0 0 3px ${bg}33"></div>
      <span style="background:#0b0b0b;border:1px solid #3f3f46;color:#e5e7eb;font-size:12px;padding:2px 6px;border-radius:8px">${text}</span>
    </div>`
  });

function FlyTo({ center }: { center: LatLng | null }) {
  const map = useMap();
  useEffect(() => {
    if (center) map.flyTo([center.lat, center.lng], Math.max(map.getZoom(), 13), { duration: 0.6 });
  }, [center, map]);
  return null;
}

// ---------- math helpers ----------
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

// ---------- price model ----------
function modeledPriceUSD(distance_m: number, duration_s: number) {
  const miles = distance_m / 1609.34;
  const mins = duration_s / 60;
  const base = 2.25, perMile = 1.50, perMin = 0.33, service = 1.2;
  const h = new Date().getHours();
  const rush = (h >= 7 && h <= 9) || (h >= 16 && h <= 19);
  const surge = rush ? 1.18 + seededRand(Math.floor(Date.now() / 60000)) * 0.35 : 1.0 + seededRand(Math.floor(Date.now() / 120000)) * 0.18;
  const est = (base + perMile * miles + perMin * mins + service) * surge;
  const center = Math.max(5, est);
  return { low: Math.max(4.5, center * 0.9), high: center * 1.12, center };
}
function priceLowerApprox(q?: { low?: number; center?: number }) {
  if (!q) return '≈ —';
  const v = (q.low ?? q.center);
  return isFinite(v as number) ? `≈ $${(v as number).toFixed(2)}` : '≈ —';
}
function priceUpperApprox(q?: { high?: number; center?: number }) {
  if (!q) return '≈ —';
  const v = (q.high ?? q.center);
  return isFinite(v as number) ? `≈ $${(v as number).toFixed(2)}` : '≈ —';
}
function savingsLowFirst(
  candidate: { center?: number; low?: number },
  base?: { center?: number; low?: number }
) {
  const baseVal = (base?.low ?? base?.center ?? 0);
  const candVal = (candidate.low ?? candidate.center ?? 0);
  if (!baseVal || !candVal) return null;
  return Math.max(0, baseVal - candVal);
}

// ---------- Mapbox Directions ----------
async function mapboxDirections(
  points: LatLng[],
  opts?: { alternatives?: boolean; profile?: 'driving-traffic' | 'driving' | 'walking'; geometries?: 'geojson' | 'polyline' }
) {
  const profile = opts?.profile ?? 'driving-traffic';
  const geoms = opts?.geometries ?? 'geojson';
  const coords = points.map(p => `${p.lng},${p.lat}`).join(';');
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

async function mapboxDrive(a: LatLng, b: LatLng) {
  const r = await mapboxDirections([a, b], { profile: 'driving-traffic', alternatives: false });
  return r?.[0] ?? null;
}
async function mapboxWalk(a: LatLng, b: LatLng) {
  const r = await mapboxDirections([a, b], { profile: 'walking', alternatives: false });
  return r?.[0] ?? null;
}

// ---------- reverse geocode ----------
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

// ---------- route-tail sampling ----------
function sampleTail(coords: [number, number][], count = SAMPLE_COUNT, fraction = TAIL_FRACTION) {
  if (!coords.length) return [];
  const n = coords.length;
  const startIdx = Math.max(0, Math.floor(n * (1 - fraction)) - 1);
  const slice = coords.slice(startIdx, n - 1); // exclude exact final point
  const out: LatLng[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const idx = Math.min(slice.length - 1, Math.floor(t * (slice.length - 1)));
    const [lng, lat] = slice[idx];
    out.push({ lat, lng });
  }
  // de-dupe close neighbors
  const uniq: LatLng[] = [];
  const seen = new Set<string>();
  for (const p of out) {
    const key = `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(p); }
  }
  return uniq;
}

// ---------- geometry comparison ----------
function pathOverlapPct(base: [number, number][], alt: [number, number][], tolM = ALT_OVERLAP_TOL_M) {
  if (!base.length || !alt.length) return 1;
  const step = Math.max(1, Math.floor(base.length / 200));
  const basePts = base.filter((_, i) => i % step === 0).map(([lng, lat]) => ({ lat, lng }));
  let within = 0;
  for (const [lng, lat] of alt) {
    const p = { lat, lng };
    let best = Infinity;
    for (const b of basePts) {
      const d = haversineMeters(p, b);
      if (d < best) best = d;
      if (best <= tolM) break;
    }
    if (best <= tolM) within += 1;
  }
  return within / alt.length;
}

// ---------- synthesize alternates ----------
function bearingDeg(a: LatLng, b: LatLng) {
  const y = Math.sin((b.lng - a.lng) * DEG2RAD) * Math.cos(b.lat * DEG2RAD);
  const x = Math.cos(a.lat * DEG2RAD) * Math.sin(b.lat * DEG2RAD) -
    Math.sin(a.lat * DEG2RAD) * Math.cos(b.lat * DEG2RAD) * Math.cos((b.lng - a.lng) * DEG2RAD);
  let brng = Math.atan2(y, x) / DEG2RAD;
  return (brng + 360) % 360;
}
function offsetPointMeters(p: LatLng, bearingDegCW: number, meters: number): LatLng {
  const dByR = meters / EARTH_M;
  const br = bearingDegCW * DEG2RAD;
  const lat1 = p.lat * DEG2RAD;
  const lng1 = p.lng * DEG2RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(dByR) + Math.cos(lat1) * Math.sin(dByR) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(dByR) * Math.cos(lat1), Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / DEG2RAD, lng: lng2 / DEG2RAD };
}

// ---------- colors ----------
const REG_COLORS = ['#60a5fa', '#a78bfa'];
const ALT_COLORS = ['#34d399', '#f59e0b', '#ef4444'];
const CAND_COLORS = ['#f59e0b', '#34d399', '#ef4444', '#22d3ee', '#eab308'];

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

export default function Page() {
  const [pickupAddr, setPickupAddr] = useState('Lark Austin');
  const [dropAddr, setDropAddr] = useState('UT Austin Main Building');
  const [pickup, setPickup] = useState<LatLng | null>(null);
  const [drop, setDrop] = useState<LatLng | null>(null);
  const [radiusM, setRadiusM] = useState<number>(400);

  const [regularRoutes, setRegularRoutes] = useState<RouteGeo[]>([]);
  const [altRoutes, setAltRoutes] = useState<RouteGeo[]>([]);
  const [baselineAddr, setBaselineAddr] = useState<string>('');

  const [showRegular, setShowRegular] = useState(true);
  const [showAlternates, setShowAlternates] = useState(true);

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

  // build routes
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pickup || !drop) return;

      const routes = await mapboxDirections([pickup, drop], { profile: 'driving-traffic', alternatives: true });
      if (!routes || routes.length === 0) { setRegularRoutes([]); setAltRoutes([]); return; }

      routes.sort((a, b) => a.duration - b.duration);

      const regs: RouteGeo[] = routes.slice(0, REG_MAX).map((r, i) => ({
        ...r,
        label: `Regular ${String.fromCharCode(65 + i)}`,
        color: REG_COLORS[i % REG_COLORS.length],
        kind: 'regular'
      }));

      let alts: RouteGeo[] = routes.slice(REG_MAX).slice(0, ALT_MAX).map((r, i) => ({
        ...r,
        label: `Alternate ${i + 1}`,
        color: ALT_COLORS[i % ALT_COLORS.length],
        kind: 'alternate'
      }));

      const need = ALT_MAX - alts.length;
      if (need > 0 && regs.length > 0) {
        const base = regs[0];
        const coords = base.coords;
        const n = coords.length;
        const picks = [Math.floor(n * 0.6), Math.floor(n * 0.75)];
        const offsets = [350, -350, 600];
        for (let pi = 0; pi < picks.length && alts.length < ALT_MAX; pi++) {
          const idx = Math.min(n - 2, Math.max(1, picks[pi]));
          const p1 = { lng: coords[idx - 1][0], lat: coords[idx - 1][1] };
          const p2 = { lng: coords[idx][0], lat: coords[idx][1] };
          const br = bearingDeg(p1, p2);
          const perpL = (br + 270) % 360;
          const perpR = (br + 90) % 360;
          for (const off of offsets) {
            const bearing = off < 0 ? perpL : perpR;
            const via = offsetPointMeters({ lat: p2.lat, lng: p2.lng }, bearing, Math.abs(off));
            const multi = await mapboxDirections([pickup, via, drop], { profile: 'driving-traffic', alternatives: false });
            if (!multi || !multi[0]) continue;
            const route = multi[0];

            if (route.distance > base.distance * 1.6) continue;
            const overlap = pathOverlapPct(base.coords, route.coords, ALT_OVERLAP_TOL_M);
            if (overlap > 0.75) continue;
            const dup = alts.some(a => pathOverlapPct(a.coords, route.coords, ALT_OVERLAP_TOL_M) > 0.85);
            if (dup) continue;

            alts.push({
              ...route,
              label: `Alternate ${alts.length + 1}`,
              color: ALT_COLORS[alts.length % ALT_COLORS.length],
              kind: 'alternate'
            });
            if (alts.length >= ALT_MAX) break;
          }
        }
      }

      if (!alive) return;
      setRegularRoutes(regs);
      setAltRoutes(alts.slice(0, ALT_MAX));

      try {
        const rev = await reverseShort(drop);
        if (alive && rev) setBaselineAddr(rev);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [pickup?.lat, pickup?.lng, drop?.lat, drop?.lng]); // eslint-disable-line

  // candidates from visible routes
  const [candidates, setCandidates] = useState<
    { drop: LatLng; walkMin: number; drive: { distance_m: number; duration_s: number }; routeIdx: string }[]
  >([]);

  // cache for candidate addresses
  const [addrCache, setAddrCache] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pickup || !drop) { setCandidates([]); return; }

      const visible: RouteGeo[] = [
        ...(showRegular ? regularRoutes : []),
        ...(showAlternates ? altRoutes : []),
      ];
      if (visible.length === 0) { setCandidates([]); return; }

      const build = async (strict: boolean) => {
        const all: { drop: LatLng; walkMin: number; drive: { distance_m: number; duration_s: number }; routeIdx: string }[] = [];

        for (const r of visible) {
          const baseDist = r.distance, baseTime = r.duration;
          const tailPts = sampleTail(r.coords, SAMPLE_COUNT, TAIL_FRACTION);

          for (const p of tailPts) {
            if (haversineMeters(p, drop) < 12) continue;

            const wk = await mapboxWalk(p, drop);
            const walkMin = wk ? Math.round(wk.duration / 60) : metersToMinWalk(haversineMeters(p, drop));
            if (walkMin > metersToMinWalk(radiusM) + 1) continue;

            const drv = await mapboxDrive(pickup, p);
            if (!drv) continue;

            const distOK = drv.distance <= (strict ? DIST_FACTOR : LOOSE_DIST_FACTOR) * baseDist;
            const timeOK = drv.duration <= (strict ? TIME_FACTOR : LOOSE_TIME_FACTOR) * baseTime;
            if (!(distOK && timeOK)) continue;

            const baseModel = modeledPriceUSD(baseDist, baseTime).center;
            const candModel = modeledPriceUSD(drv.distance, drv.duration).center;
            const cheaper = (baseModel - candModel) / baseModel >= (strict ? PRICE_IMPROVE : LOOSE_PRICE_IMPROVE);
            if (!cheaper) continue;

            all.push({ drop: p, walkMin, drive: { distance_m: drv.distance, duration_s: drv.duration }, routeIdx: r.label });
          }
        }

        // sort by savings first, then by shown (lower) price
        all.sort((a, b) => {
          const aPrice = modeledPriceUSD(a.drive.distance_m, a.drive.duration_s);
          const bPrice = modeledPriceUSD(b.drive.distance_m, b.drive.duration_s);
          const aBase = visible.find(v => v.label === a.routeIdx);
          const bBase = visible.find(v => v.label === b.routeIdx);
          const aBasePrice = aBase ? modeledPriceUSD(aBase.distance, aBase.duration) : undefined;
          const bBasePrice = bBase ? modeledPriceUSD(bBase.distance, bBase.duration) : undefined;
          const aSaved = savingsLowFirst(aPrice, aBasePrice) ?? 0;
          const bSaved = savingsLowFirst(bPrice, bBasePrice) ?? 0;
          if (aSaved !== bSaved) return bSaved - aSaved;
          const aShown = (aPrice.low ?? aPrice.center ?? Infinity);
          const bShown = (bPrice.low ?? bPrice.center ?? Infinity);
          return aShown - bShown;
        });

        // cap: top 2 per route label
        const perRoute: Record<string, number> = {};
        const capped: typeof all = [];
        for (const c of all) {
          perRoute[c.routeIdx] = (perRoute[c.routeIdx] ?? 0) + 1;
          if (perRoute[c.routeIdx] <= 2) capped.push(c);
        }
        return capped;
      };

      let out = await build(true);
      if (out.length === 0) out = await build(false);

      if (!alive) return;
      setCandidates(out);

      // warm address cache
      const updates: Record<string, string> = {};
      await Promise.all(out.map(async (c) => {
        const key = `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`;
        if (!addrCache[key]) {
          const s = await reverseShort(c.drop);
          if (s) updates[key] = s;
        }
      }));
      if (alive && Object.keys(updates).length) setAddrCache(prev => ({ ...prev, ...updates }));
    })();
    return () => { alive = false; };
  }, [
    showRegular, showAlternates,
    regularRoutes.map(r => r.label).join('|'),
    altRoutes.map(r => r.label).join('|'),
    pickup?.lat, pickup?.lng, drop?.lat, drop?.lng, radiusM
  ]); // eslint-disable-line

  // UI helpers
  const radiusFt = Math.round(radiusM * M_TO_FT);
  const maxWalkMin = metersToMinWalk(radiusM);
  const baselineETA = pickup ? estimateETAmin(pickup) : null;
  const mapCenter = drop || pickup || AUSTIN.center;

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

  const candidateLines = useMemo(() => {
    if (!pickup) return [];
    return candidates.slice(0, 8).map((c, i) => ({
      key: `candline-${i}`,
      color: CAND_COLORS[i % CAND_COLORS.length],
      coords: [[pickup.lat, pickup.lng], [c.drop.lat, c.drop.lng]] as [number, number][],
    }));
  }, [pickup?.lat, pickup?.lng, candidates.map(c => `${c.drop.lat},${c.drop.lng}`).join('|')]); // eslint-disable-line

  return (
    <main className="min-h-screen w-full bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Fare-Hunter</h1>
        <p className="text-zinc-300 mt-2">
          Drop off a short walk away and pay less. We map traffic-aware routes from your pickup to your destination,
          then find drop-off points <b>along the route</b> that keep your walk under your limit and <b>shorten the actual drive</b>.
          You’ll see your regular route price (conservatively shown with an upper estimate) and <b>cheaper</b> on-the-way options
          (shown with their lower estimate) — plus how much you’d save.
        </p>

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

            <div className="mt-4 flex items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showRegular} onChange={(e) => setShowRegular(e.target.checked)} />
                Show Regular
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={showAlternates} onChange={(e) => setShowAlternates(e.target.checked)} />
                Show Alternates
              </label>
            </div>
          </div>
        </div>

        {/* Map */}
        <div className="mt-6 rounded-2xl overflow-hidden border border-zinc-800">
          <MapContainer center={[mapCenter.lat, mapCenter.lng]} zoom={13} style={{ height: 520, width: '100%' }} scrollWheelZoom className="bg-zinc-900">
            <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            <ScaleControl imperial metric={false} position="bottomleft" />

            {pickup && <Marker position={[pickup.lat, pickup.lng]} icon={labeledIcon('#38bdf8', 'Pickup')} />}
            {drop && <Marker position={[drop.lat, drop.lng]} icon={labeledIcon('#22c55e', 'Final')} />}
            {drop && <Circle center={[drop.lat, drop.lng]} radius={radiusM} pathOptions={{ color: '#e879f9', dashArray: '6 6', weight: 2, opacity: 0.8 }} />}

            {/* regular routes */}
            {showRegular && regularRoutes.map((r, i) => (
              <Polyline key={`reg-${i}`} positions={r.coords.map(([lng, lat]) => [lat, lng]) as any}
                        pathOptions={{ color: r.color, weight: 5, opacity: 0.9 }} />
            ))}

            {/* alternates (map only) */}
            {showAlternates && altRoutes.map((r, i) => (
              <Polyline key={`alt-${i}`} positions={r.coords.map(([lng, lat]) => [lat, lng]) as any}
                        pathOptions={{ color: r.color, weight: 4, opacity: 0.75, dashArray: '8 6' }} />
            ))}

            {/* candidate lines PU -> candidate */}
            {candidateLines.map((ln) => (
              <Polyline key={ln.key} positions={ln.coords} pathOptions={{ color: ln.color, weight: 2.5, opacity: 0.85, dashArray: '2 6' }} />
            ))}

            {/* candidate pins */}
            {candidates.map((c, idx) => (
              <Marker key={`cand-${idx}`} position={[c.drop.lat, c.drop.lng]} icon={labeledIcon('#f59e0b', `#${idx + 1}`)} />
            ))}

            <FlyTo center={mapCenter} />
          </MapContainer>
        </div>

        {/* Regular routes card */}
        <div className="mt-6">
          <div className="rounded-2xl p-4 bg-zinc-900/60 border border-zinc-800">
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
                  {/* REGULAR: show UPPER estimate with ≈ */}
                  <div className="mt-1 text-2xl font-semibold">
                    {priceUpperApprox(price)} <span className="text-sm font-normal text-zinc-400">(upper est.)</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-sm text-zinc-300">
                    <span>Exact drop-off:</span>
                    <span className="font-medium">{baselineAddr || dropAddr}</span>
                    <button className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800"
                            onClick={() => navigator.clipboard.writeText(baselineAddr || dropAddr)}>
                      Copy address
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Cheaper along-route options */}
        <div className="mt-8">
          <h3 className="text-lg font-semibold">Cheaper on-the-way drop-offs (by visible routes)</h3>
          <div className="mt-3 grid md:grid-cols-2 gap-4">
            {candidates.map((c, idx) => {
              const price = modeledPriceUSD(c.drive.distance_m, c.drive.duration_s);
              const baseForRoute = [...regularRoutes, ...altRoutes].find(r => r.label === c.routeIdx);
              const basePrice = baseForRoute ? modeledPriceUSD(baseForRoute.distance, baseForRoute.duration) : undefined;
              const saved = savingsLowFirst(price, basePrice);
              const key = `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`;
              const addr = addrCache[key] || '…';
              const walkFt = metersToFeet((c.walkMin * 60) * 1.33);
              const saveBadge = saved !== null && saved > 0;

              return (
                <div key={`candc-${idx}`} className="rounded-2xl p-4 bg-zinc-900/60 border border-zinc-800 hover:border-zinc-600">
                  <div className="flex items-start justify-between">
                    <div>
                      {/* ALTERNATE (suggestions): show LOWER estimate with ≈ */}
                      <div className="text-2xl font-semibold">{priceLowerApprox(price)}</div>
                    </div>
                    {saveBadge ? (
                      <div className="text-right">
                        <div className="text-xl font-extrabold text-emerald-400">Save ${saved!.toFixed(2)}</div>
                      </div>
                    ) : (
                      <div className="text-right text-[11px] text-zinc-500">No guaranteed savings</div>
                    )}
                  </div>

                  <div className="mt-2 flex items-center gap-2 text-sm text-zinc-300">
                    <span>Exact drop-off:</span>
                    <span className="font-medium">{addr}</span>
                    <button className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800"
                            onClick={() => navigator.clipboard.writeText(addr)}>Copy address</button>
                  </div>

                  <div className="mt-1 text-sm text-zinc-300">
                    Walk to final: <span className="font-medium">~{c.walkMin} min</span> ({walkFt.toLocaleString()} ft) •{' '}
                    Drive vs route: <span className="font-medium">
                      −{(((baseForRoute?.duration ?? 0) - c.drive.duration_s) / 60).toFixed(1)} min, −{((1 - c.drive.distance_m / (baseForRoute?.distance ?? 1)) * 100).toFixed(0)}%
                    </span>
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
                </div>
              );
            })}
          </div>

          <div className="mt-4 text-xs text-zinc-500">
            We request Mapbox’s traffic-aware routes. If strict savings filters find nothing, we’ll still show close,
            on-the-way options within your radius using a gentler pass so you always get suggestions.
          </div>
        </div>
      </div>
    </main>
  );
}
