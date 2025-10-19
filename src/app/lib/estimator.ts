// lib/estimator.ts
const M_TO_MI = 0.000621371;
const SEC_TO_MIN = 1 / 60;

type LatLng = { lat: number; lng: number };

export type PriceRange = {
  low: number;
  high: number;
  center: number;
  meta: {
    miles: number;
    driveMin: number;
    todFactor: number;
    bandPct: number;
  };
};

/**
 * Simple Austin baseline (tunable per city).
 * You can store per-city configs if you expand beyond ATX.
 */
const AUSTIN_RATECARD = {
  base: 2.25,        // base fee $
  perMile: 1.55,     // $ / mile
  perMin: 0.28,      // $ / minute
  booking: 2.00,     // fixed booking/taxes ballpark
  minFare: 7.00,     // clamp minimum fare
};

/** Hour-of-day × day-of-week factor (rough guess; improve with data). */
function timeOfDayFactor(d: Date) {
  const h = d.getHours();
  const dow = d.getDay(); // 0=Sun
  let f = 1.0;

  // Weekday peaks
  const weekday = dow >= 1 && dow <= 5;
  if (weekday && ((h >= 7 && h <= 9) || (h >= 16 && h <= 19))) f *= 1.25;

  // Fri/Sat evening
  if ((dow === 5 || dow === 6) && (h >= 20 || h <= 2)) f *= 1.35;

  return f;
}

/** Mapbox Directions (driving) for distance & duration. */
export async function getDriveStats(
  pickup: LatLng,
  drop: LatLng,
  mapboxToken: string
) {
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${pickup.lng},${pickup.lat};${drop.lng},${drop.lat}` +
              `?alternatives=false&overview=false&annotations=distance,duration&access_token=${encodeURIComponent(mapboxToken)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Mapbox directions error ${res.status}`);
  const json = await res.json();
  const route = json?.routes?.[0];
  const meters = route?.distance ?? 0;
  const seconds = route?.duration ?? 0;
  return {
    miles: meters * M_TO_MI,
    driveMin: seconds * SEC_TO_MIN
  };
}

/** Deterministic baseline + banded range. */
export async function estimatePriceRange(
  pickup: LatLng,
  drop: LatLng,
  mapboxToken: string,
  now = new Date()
): Promise<PriceRange> {
  const { miles, driveMin } = await getDriveStats(pickup, drop, mapboxToken);

  const r = AUSTIN_RATECARD;
  let price =
    r.base +
    r.perMile * miles +
    r.perMin * driveMin +
    r.booking;

  // time-of-day factor
  const tod = timeOfDayFactor(now);
  price *= tod;

  // clamp minimum fare
  price = Math.max(price, r.minFare);

  // Band: tighter off-peak, wider in peaks
  const baseBand = tod > 1.2 ? 0.28 : 0.18; // ±18% normal, ±28% in peaks
  const low = Math.max(r.minFare, round2(price * (1 - baseBand)));
  const high = round2(price * (1 + baseBand));

  return {
    low,
    high,
    center: round2(price),
    meta: { miles: round2(miles), driveMin: Math.round(driveMin), todFactor: round2(tod), bandPct: baseBand }
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
