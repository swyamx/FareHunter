'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { MapContainer, TileLayer, Marker, Circle, Polyline, ScaleControl, useMap } from 'react-leaflet';
import L, { DivIcon } from 'leaflet';
import 'leaflet/dist/leaflet.css';

const MAPBOX = process.env.NEXT_PUBLIC_MAPBOX_TOKEN!;
const AUSTIN = { center: { lat: 30.2672, lng: -97.7431 } } as const;

type LatLng = { lat: number; lng: number };
type RouteGeo = { distance: number; duration: number; coords: [number, number][]; label: string; color: string; kind: 'regular' | 'alternate' };

const DEG2RAD = Math.PI / 180;
const EARTH_M = 6371000;
const M_TO_FT = 3.28084;

// ---------- tight tuning (strict pass) ----------
const TAIL_FRACTION = 0.22;      // sample only last ~22% of each route
const SAMPLE_COUNT = 16;         // candidate points per route tail
const DIST_FACTOR = 0.88;        // candidate drive must be <= 88% baseline distance (>=12% shorter)
const TIME_FACTOR = 0.88;        // candidate drive must be <= 88% baseline time (>=12% faster)
const PCT_IMPROVE = 0.12;        // modeled fare must be >=12% cheaper than cheapest regular
const ABS_IMPROVE_MIN = 1.75;    // AND by at least $1.75

// ---------- relaxed pass (used only if strict yields too few) ----------
const RELAX_DIST = 0.97;         // allow <= 97% of route distance (or equal-ish)
const RELAX_TIME = 0.97;         // allow <= 97% of route time (or equal-ish)
const MIN_SUGGESTIONS = 2;       // ensure at least this many suggestions overall
const MAX_SUGGESTIONS = 4;       // cap total suggestions shown

const ALT_OVERLAP_TOL_M = 60;
const ALT_MAX = 3;               // up to 3 alternates (map only)
const REG_MAX = 2;               // up to 2 regulars (listed)

// ---------- icons & helpers ----------
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

// ---------- zone penalties ----------
type Box = { minLat: number; maxLat: number; minLng: number; maxLng: number };
const ZONES: { name: 'Downtown' | 'Airport'; box: Box; penaltyUSD: number }[] = [
  { name: 'Downtown', box: { minLat: 30.260, maxLat: 30.275, minLng: -97.753, maxLng: -97.734 }, penaltyUSD: 0.75 },
  { name: 'Airport',  box: { minLat: 30.187, maxLat: 30.217, minLng: -97.706, maxLng: -97.648 }, penaltyUSD: 1.25 },
];
function inBox(p: LatLng, b: Box) { return p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng; }
function zonePenaltyUSD(p: LatLng) {
  let sum = 0;
  for (const z of ZONES) if (inBox(p, z.box)) sum += z.penaltyUSD;
  return sum;
}

// ---------- price model with consistent surge ----------
function modeledPriceUSD(distance_m: number, duration_s: number, surge = 1.0, penaltyUSD = 0) {
  const miles = distance_m / 1609.34;
  const mins = duration_s / 60;
  const base = 2.25, perMile = 1.50, perMin = 0.33, service = 1.2;
  const est = (base + perMile * miles + perMin * mins + service) * surge + penaltyUSD;
  const center = Math.max(5, est);
  return { low: Math.max(4.5, center * 0.9), high: center * 1.12, center };
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
async function mapboxDrive(pu: LatLng, to: LatLng) {
  const r = await mapboxDirections([pu, to], { profile: 'driving-traffic', alternatives: false });
  return r?.[0] ?? null;
}
async function mapboxWalk(a: LatLng, b: LatLng) {
  const r = await mapboxDirections([a, b], { profile: 'walking', alternatives: false });
  return r?.[0] ?? null;
}

// ---------- reverse geocode (short) ----------
async function reverseShort(p: LatLng) {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${p.lng},${p.lat}.json?access_token=${MAPBOX}&limit=1&types=address,poi`;
  const r = await fetch(url);
  if (!r.ok) return '';
  const j = await r.json();
  const f = j?.features?.[0];
  if (!f) return '';
  const place = String(f.place_name || '');
  const first = place.split(',')[0]?.trim();
  if ((f.properties as any)?.address && !/\d/.test(first)) return `${first} · ${(f.properties as any).address}`;
  return first || (f as any).text || place;
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

// ---------- debounced ----------
function useDebounced<T>(value: T, delay = 250) {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), delay); return () => clearTimeout(id); }, [value, delay]);
  return v;
}
function priceText(q?: { low?: number; high?: number; center?: number }) {
  if (!q) return '…';
  if (q.low && q.high) return `$${q.low.toFixed(2)} – $${q.high.toFixed(2)}`;
  if (q.center) return `$${q.center.toFixed(2)}`;
  return '—';
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

// ---------- geometry comparison (overlap %) ----------
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

// ---------- synthesize alternates by forcing a VIA ----------
function bearingDeg(a: LatLng, b: LatLng) {
  const y = Math.sin((b.lng - a.lng) * DEG2RAD) * Math.cos(b.lat * DEG2RAD);
  const x = Math.cos(a.lat * DEG2RAD) * Math.sin(b.lat * DEG2RAD) -
    Math.sin(a.lat * DEG2RAD) * Math.cos(b.lat * DEG2RAD) * Math.cos((b.lng - a.lng) * DEG2RAD);
  let brng = Math.atan2(y, x) / DEG2RAD;
  return (brng + 360) % 360;
}
function offsetPointMeters(p: LatLng, bearingDegCW: number, meters: number): LatLng {
  const dByR = meters / EARTH_M;           // angular distance in radians
  const br = bearingDegCW * DEG2RAD;       // bearing in radians
  const lat1 = p.lat * DEG2RAD;
  const lng1 = p.lng * DEG2RAD;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dByR) +
    Math.cos(lat1) * Math.sin(dByR) * Math.cos(br)
  );

  const lng2 = lng1 + Math.atan2(
    Math.sin(br) * Math.sin(dByR) * Math.cos(lat1),
    Math.cos(dByR) - Math.sin(lat1) * Math.sin(lat2) // <-- fixed here
  );

  return { lat: lat2 / DEG2RAD, lng: lng2 / DEG2RAD };
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
const REG_COLORS = ['#60a5fa', '#a78bfa'];             // Regular A/B
const ALT_COLORS = ['#34d399', '#f59e0b', '#ef4444'];  // Alternate 1–3

// ---------- CandidateCard ----------
function CandidateCard({
  idx, pickup, candidate, baseForRouteLabel, baseForRoute,
}: {
  idx: number;
  pickup: LatLng;
  candidate: {
    drop: LatLng;
    walkMin: number;
    drive: { distance_m: number; duration_s: number };
    routeIdx: string;
    surge: number;
    reason: 'strict' | 'fallback';
  };
  baseForRouteLabel: string;
  baseForRoute?: RouteGeo;
}) {
  const [addr, setAddr] = useState<string>('…');
  useEffect(() => { (async () => { const s = await reverseShort(candidate.drop); if (s) setAddr(s); })(); }, [candidate.drop.lat, candidate.drop.lng]);

  const penalty = zonePenaltyUSD(candidate.drop);
  const price = modeledPriceUSD(candidate.drive.distance_m, candidate.drive.duration_s, candidate.surge, penalty);
  const basePrice = baseForRoute ? modeledPriceUSD(baseForRoute.distance, baseForRoute.duration, candidate.surge, zonePenaltyUSD({ lat: baseForRoute.coords.at(-1)?.[1] ?? 0, lng: baseForRoute.coords.at(-1)?.[0] ?? 0 })) : undefined;
  const saved = (() => {
    const baseVal = basePrice?.center ?? 0;
    const candVal = price.center;
    return baseVal > 0 ? Math.max(0, baseVal - candVal) : null;
  })();
  const walkFt = metersToFeet((candidate.walkMin * 60) * 1.33);

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

  return (
    <div className="rounded-2xl p-4 bg-zinc-900/60 border border-zinc-800 hover:border-zinc-600">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs text-zinc-400">{baseForRouteLabel.toUpperCase()}</div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${candidate.reason === 'strict' ? 'border-emerald-600 text-emerald-300 bg-emerald-500/15' : 'border-zinc-600 text-zinc-300 bg-zinc-500/10'}`}>
          {candidate.reason === 'strict' ? 'Strict' : 'Fallback'}
        </span>
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-2xl font-semibold">{priceText(price)}</div>
        <div className="text-xs text-zinc-400">#{idx + 1}</div>
      </div>
      <div className="mt-1 flex items-center gap-2 text-sm text-zinc-300">
        <span>Exact drop-off:</span>
        <span className="font-medium">{addr}</span>
        <button className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800"
                onClick={() => navigator.clipboard.writeText(addr)}>Copy address</button>
      </div>
      <div className="mt-1 text-sm text-zinc-300">
        Walk to final: <span className="font-medium">~{candidate.walkMin} min</span> ({walkFt.toLocaleString()} ft)
      </div>
      <div className="mt-3 flex gap-2">
        <a href={uberLink(pickup, candidate.drop, addr)} target="_blank" rel="noreferrer"
           className="px-3 py-2 rounded-xl bg-emerald-400 text-zinc-950 font-semibold hover:bg-emerald-300">Open in Uber</a>
        <button className="px-3 py-2 rounded-xl border border-zinc-700 hover:bg-zinc-800"
                onClick={() => navigator.clipboard.writeText(`${candidate.drop.lat.toFixed(6)}, ${candidate.drop.lng.toFixed(6)}`)}>
          Copy coords
        </button>
      </div>
      {saved !== null && (
        <div className={`mt-2 inline-block text-[11px] px-2 py-0.5 rounded-full ${saved > 0 ? 'bg-emerald-500/15 border-emerald-600 text-emerald-300' : 'bg-zinc-500/10 border-zinc-600 text-zinc-300'} border`}>
          {saved > 0 ? `Save ~$${saved.toFixed(2)}` : 'Similar price'}
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

  // surge proxy per search
  const [surgeProxy, setSurgeProxy] = useState<number>(1.0);

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

  // build routes (regular + alternates; alternates are drawn on map but not listed)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pickup || !drop) return;

      // traffic-aware routes
      const routesTraffic = await mapboxDirections([pickup, drop], { profile: 'driving-traffic', alternatives: true });
      if (!routesTraffic || routesTraffic.length === 0) { setRegularRoutes([]); setAltRoutes([]); return; }
      routesTraffic.sort((a, b) => a.duration - b.duration);

      // compute free-flow to derive surge proxy (use fastest traffic route)
      let surge = 1.0;
      try {
        const fastest = routesTraffic[0];
        const free = await mapboxDirections([pickup, drop], { profile: 'driving', alternatives: false });
        const freeDur = free?.[0]?.duration ?? fastest.duration;
        const ratio = Math.max(1.0, Math.min(1.3, fastest.duration / Math.max(1, freeDur)));
        surge = ratio;
      } catch { /* keep 1.0 */ }
      if (alive) setSurgeProxy(surge);

      // regular A/B
      const regs: RouteGeo[] = routesTraffic.slice(0, REG_MAX).map((r, i) => ({
        ...r,
        label: `Regular ${String.fromCharCode(65 + i)}`,
        color: REG_COLORS[i % REG_COLORS.length],
        kind: 'regular'
      }));

      // alternates directly from Mapbox beyond regs (map only)
      const altsFromAPI: RouteGeo[] = routesTraffic.slice(REG_MAX, REG_MAX + ALT_MAX).map((r, i) => ({
        ...r,
        label: `Alternate ${i + 1}`,
        color: ALT_COLORS[i % ALT_COLORS.length],
        kind: 'alternate'
      }));

      // (Optional) synthesize alternates if fewer than ALT_MAX… (kept from previous version)
      let alts: RouteGeo[] = [...altsFromAPI];
      // — trimmed to keep the file focused; you can keep your prior synthesis block if you want more alternates —

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

  // cheapest regular route (for comparisons & “regular price”)
  const cheapestRegular = useMemo(() => {
    if (regularRoutes.length === 0) return null;
    const best = [...regularRoutes].sort((a, b) => a.duration - b.duration)[0];
    return best;
  }, [regularRoutes]);

  const regularPrice = useMemo(() => {
    if (!cheapestRegular) return null;
    const penalty = zonePenaltyUSD({ lat: cheapestRegular.coords.at(-1)?.[1] ?? 0, lng: cheapestRegular.coords.at(-1)?.[0] ?? 0 });
    return modeledPriceUSD(cheapestRegular.distance, cheapestRegular.duration, surgeProxy, penalty);
  }, [cheapestRegular, surgeProxy]);

  // candidates (strictly inside radius, then relaxed fallback if needed)
  const [candidates, setCandidates] = useState<
    { drop: LatLng; walkMin: number; drive: { distance_m: number; duration_s: number }; routeIdx: string; surge: number; reason: 'strict' | 'fallback' }[]
  >([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!pickup || !drop) { setCandidates([]); return; }

      const visible: RouteGeo[] = [
        ...(showRegular ? regularRoutes : []),
        ...(showAlternates ? altRoutes : []),
      ];

      const bestReg = [...regularRoutes].sort((a, b) => a.duration - b.duration)[0];
      if (!bestReg) { setCandidates([]); return; }

      const bestPenalty = zonePenaltyUSD({ lat: bestReg.coords.at(-1)?.[1] ?? 0, lng: bestReg.coords.at(-1)?.[0] ?? 0 });
      const bestPrice = modeledPriceUSD(bestReg.distance, bestReg.duration, surgeProxy, bestPenalty).center;

      const strictAll: { drop: LatLng; walkMin: number; drive: { distance_m: number; duration_s: number }; routeIdx: string; surge: number; reason: 'strict' }[] = [];

      // ---------- STRICT PASS ----------
      for (const r of visible) {
        const baseDist = r.distance, baseTime = r.duration;
        const tailPts = sampleTail(r.coords, SAMPLE_COUNT, TAIL_FRACTION);

        for (const p of tailPts) {
          // HARD radius cap and avoid exact-final
          const radial = haversineMeters(p, drop);
          if (radial > radiusM || radial < 12) continue;

          // walking feasibility
          const wk = await mapboxWalk(p, drop);
          const walkMin = wk ? Math.round(wk.duration / 60) : metersToMinWalk(radial);

          // drive pickup -> candidate
          const drv = await mapboxDrive(pickup, p);
          if (!drv) continue;

          // strictly shorter by time & distance vs THIS route
          const distOK = drv.distance <= DIST_FACTOR * baseDist;
          const timeOK = drv.duration <= TIME_FACTOR * baseTime;
          if (!(distOK && timeOK)) continue;

          // price improvement vs CHEAPEST regular
          const candPenalty = zonePenaltyUSD(p);
          const candPrice = modeledPriceUSD(drv.distance, drv.duration, surgeProxy, candPenalty).center;
          const absImprove = bestPrice - candPrice;
          const pctImprove = absImprove / bestPrice;

          if (absImprove < ABS_IMPROVE_MIN) continue;
          if (pctImprove < PCT_IMPROVE) continue;

          strictAll.push({ drop: p, walkMin, drive: { distance_m: drv.distance, duration_s: drv.duration }, routeIdx: r.label, surge: surgeProxy, reason: 'strict' });
        }
      }

      // sort strict by savings, then quality
      strictAll.sort((a, b) => {
        const aPrice = modeledPriceUSD(a.drive.distance_m, a.drive.duration_s, surgeProxy, zonePenaltyUSD(a.drop)).center;
        const bPrice = modeledPriceUSD(b.drive.distance_m, b.drive.duration_s, surgeProxy, zonePenaltyUSD(b.drop)).center;
        const aSave = bestPrice - aPrice;
        const bSave = bestPrice - bPrice;
        if (bSave !== aSave) return bSave - aSave;
        return (a.drive.distance_m * 1.5 + a.drive.duration_s) - (b.drive.distance_m * 1.5 + b.drive.duration_s);
      });

      // cap strict: at most 2 per route & MAX_SUGGESTIONS total
      const perRouteStrict: Record<string, number> = {};
      const strictCapped: typeof strictAll = [];
      for (const c of strictAll) {
        perRouteStrict[c.routeIdx] = (perRouteStrict[c.routeIdx] ?? 0) + 1;
        if (perRouteStrict[c.routeIdx] <= 2) strictCapped.push(c);
        if (strictCapped.length >= MAX_SUGGESTIONS) break;
      }

      let results: { drop: LatLng; walkMin: number; drive: { distance_m: number; duration_s: number }; routeIdx: string; surge: number; reason: 'strict' | 'fallback' }[] = [...strictCapped];

      // ---------- RELAXED PASS (only if we need more) ----------
      if (results.length < MIN_SUGGESTIONS) {
        const relaxedAll: { drop: LatLng; walkMin: number; drive: { distance_m: number; duration_s: number }; routeIdx: string; surge: number; reason: 'fallback' }[] = [];

        for (const r of visible) {
          const baseDist = r.distance, baseTime = r.duration;
          const tailPts = sampleTail(r.coords, SAMPLE_COUNT, TAIL_FRACTION);

          for (const p of tailPts) {
            const radial = haversineMeters(p, drop);
            if (radial > radiusM || radial < 12) continue;

            const wk = await mapboxWalk(p, drop);
            const walkMin = wk ? Math.round(wk.duration / 60) : metersToMinWalk(radial);

            const drv = await mapboxDrive(pickup, p);
            if (!drv) continue;

            // relaxed: must be at least *not worse* than route by small margin (<=97%)
            const distOK = drv.distance <= RELAX_DIST * baseDist;
            const timeOK = drv.duration <= RELAX_TIME * baseTime;
            if (!(distOK && timeOK)) continue;

            relaxedAll.push({ drop: p, walkMin, drive: { distance_m: drv.distance, duration_s: drv.duration }, routeIdx: r.label, surge: surgeProxy, reason: 'fallback' });
          }
        }

        // sort relaxed by modeled price (cheapest first)
        relaxedAll.sort((a, b) => {
          const ap = modeledPriceUSD(a.drive.distance_m, a.drive.duration_s, surgeProxy, zonePenaltyUSD(a.drop)).center;
          const bp = modeledPriceUSD(b.drive.distance_m, b.drive.duration_s, surgeProxy, zonePenaltyUSD(b.drop)).center;
          return ap - bp;
        });

        // de-dup vs strict, cap to fill MIN..MAX
        const have = new Set(results.map(c => `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`));
        for (const c of relaxedAll) {
          const key = `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`;
          if (have.has(key)) continue;
          results.push(c);
          have.add(key);
          if (results.length >= Math.max(MIN_SUGGESTIONS, MAX_SUGGESTIONS)) break;
        }
      }

      // ---------- LAST-RESORT “closest tail pins” (inside radius) ----------
      if (results.length < MIN_SUGGESTIONS) {
        const closestAll: { drop: LatLng; walkMin: number; drive: { distance_m: number; duration_s: number }; routeIdx: string; surge: number; reason: 'fallback' }[] = [];
        for (const r of visible) {
          const tailPts = sampleTail(r.coords, SAMPLE_COUNT, TAIL_FRACTION);
          for (const p of tailPts) {
            const radial = haversineMeters(p, drop);
            if (radial > radiusM || radial < 12) continue;
            const wk = await mapboxWalk(p, drop);
            const walkMin = wk ? Math.round(wk.duration / 60) : metersToMinWalk(radial);
            const drv = await mapboxDrive(pickup, p);
            if (!drv) continue;
            closestAll.push({ drop: p, walkMin, drive: { distance_m: drv.distance, duration_s: drv.duration }, routeIdx: r.label, surge: surgeProxy, reason: 'fallback' });
          }
        }
        // sort by radial distance (closest to final) then price
        closestAll.sort((a, b) => {
          const ra = haversineMeters(a.drop, drop!);
          const rb = haversineMeters(b.drop, drop!);
          if (ra !== rb) return ra - rb;
          const ap = modeledPriceUSD(a.drive.distance_m, a.drive.duration_s, surgeProxy, zonePenaltyUSD(a.drop)).center;
          const bp = modeledPriceUSD(b.drive.distance_m, b.drive.duration_s, surgeProxy, zonePenaltyUSD(b.drop)).center;
          return ap - bp;
        });

        const have = new Set(results.map(c => `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`));
        for (const c of closestAll) {
          const key = `${c.drop.lat.toFixed(6)},${c.drop.lng.toFixed(6)}`;
          if (have.has(key)) continue;
          results.push(c);
          have.add(key);
          if (results.length >= MIN_SUGGESTIONS) break;
        }
      }

      // final hard cap
      results = results.slice(0, MAX_SUGGESTIONS);

      if (alive) setCandidates(results);
    })();
    return () => { alive = false; };
  }, [
    showRegular, showAlternates,
    regularRoutes.map(r => r.label).join('|'),
    altRoutes.map(r => r.label).join('|'),
    pickup?.lat, pickup?.lng, drop?.lat, drop?.lng, radiusM, surgeProxy
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

  return (
    <main className="min-h-screen w-full bg-zinc-950 text-zinc-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tight">Fare-Hunter</h1>
        <p className="text-zinc-300 mt-2">
          Shows **1–2 regular routes** and up to **3 alternates** (map only). You’ll **always** get some suggestions inside your radius—
          strict cheaper ones first, then clearly on-route fallback options if needed.
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
                Show Alternates (map only)
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

            {/* alternates on map only */}
            {showAlternates && altRoutes.map((r, i) => (
              <Polyline key={`alt-${i}`} positions={r.coords.map(([lng, lat]) => [lat, lng]) as any}
                        pathOptions={{ color: r.color, weight: 4, opacity: 0.75, dashArray: '8 6' }} />
            ))}

            {/* candidate pins (strict + fallback) */}
            {candidates.map((c, idx) => (
              <Marker key={`cand-${idx}`} position={[c.drop.lat, c.drop.lng]} icon={labeledIcon('#f59e0b', `#${idx + 1}`)} />
            ))}

            <FlyTo center={mapCenter} />
          </MapContainer>
        </div>

        {/* Regular price (cheapest of regulars) */}
        {pickup && drop && cheapestRegular && (
          <div className="mt-6 rounded-2xl p-4 bg-zinc-900/60 border border-zinc-800">
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">Regular price (cheapest)</div>
              {baselineETA !== null && (
                <div className="text-sm text-zinc-400">ETA (mock): <span className="text-zinc-200 font-medium">{baselineETA} min</span></div>
              )}
            </div>
            <div className="mt-1 flex items-center gap-2 text-sm text-zinc-300">
              <span>Exact drop-off:</span>
              <span className="font-medium">{baselineAddr || dropAddr}</span>
              <button
                className="text-xs px-2 py-0.5 rounded border border-zinc-700 hover:bg-zinc-800"
                onClick={() => navigator.clipboard.writeText(baselineAddr || dropAddr)}
              >
                Copy address
              </button>
            </div>
            <div className="mt-1 text-2xl font-semibold">{priceText(regularPrice || undefined)}</div>
            <div className="mt-3">
              {pickup && drop && (
                <a href={uberLink(pickup, drop)} target="_blank" rel="noreferrer" className="px-3 py-2 rounded-xl bg-emerald-400 text-zinc-950 font-semibold hover:bg-emerald-300">Open in Uber</a>
              )}
            </div>
          </div>
        )}

        {/* Always-on suggestions (strict first, then fallback) */}
        <div className="mt-8">
          <h3 className="text-lg font-semibold">On-the-way drop-offs inside your radius</h3>
          {candidates.length === 0 && (
            <div className="mt-2 text-sm text-zinc-400">
              Still looking sparse. Try increasing the walk radius or nudging pickup/drop a little.
            </div>
          )}
          <div className="mt-3 grid md:grid-cols-2 gap-4">
            {candidates.map((c, idx) => {
              const baseForRoute = [...regularRoutes, ...altRoutes].find(r => r.label === c.routeIdx);
              return (
                <CandidateCard
                  key={`candc-${idx}`}
                  idx={idx}
                  pickup={pickup!}
                  candidate={c}
                  baseForRouteLabel={c.routeIdx}
                  baseForRoute={baseForRoute}
                />
              );
            })}
          </div>

          <div className="mt-4 text-xs text-zinc-500">
            We first surface **clearly cheaper** (Strict) picks. If none qualify, we still show **on-route** (Fallback) pins inside your radius that are
            near the destination and at least not worse than their route by a small margin.
          </div>
        </div>
      </div>
    </main>
  );
}
