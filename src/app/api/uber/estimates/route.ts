import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const EARTH_M = 6371000;
const DEG2RAD = Math.PI / 180;

function haversine(a: {lat:number,lng:number}, b:{lat:number,lng:number}) {
  const dLat = (b.lat - a.lat) * DEG2RAD;
  const dLng = (b.lng - a.lng) * DEG2RAD;
  const lat1 = a.lat * DEG2RAD, lat2 = b.lat * DEG2RAD;
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function modeledPriceUSD(distance_m: number, duration_s?: number) {
  // duration_s is optional server-side; approximate if missing
  const miles = distance_m / 1609.34;
  const mins = duration_s ? duration_s/60 : Math.max(5, miles * 2.2);
  const base = 2.25, perMile = 1.50, perMin = 0.33, service = 1.2;
  const h = new Date().getHours();
  const rush = (h >= 7 && h <= 9) || (h >= 16 && h <= 19);
  const rnd = Math.sin(Math.floor(Date.now()/60000)) * 0.5 + 0.5;
  const surge = rush ? 1.15 + rnd * 0.35 : 1.0 + rnd * 0.2;
  const center = Math.max(5, (base + perMile*miles + perMin*mins + service) * surge);
  return { low: center * 0.9, high: center * 1.15, center };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const startLat = Number(url.searchParams.get('startLat'));
    const startLng = Number(url.searchParams.get('startLng'));
    const endLat = Number(url.searchParams.get('endLat'));
    const endLng = Number(url.searchParams.get('endLng'));

    if (![startLat,startLng,endLat,endLng].every(Number.isFinite)) {
      return NextResponse.json({ error: 'bad params' }, { status: 400 });
    }

    const d = haversine({lat:startLat,lng:startLng}, {lat:endLat,lng:endLng});
    const range = modeledPriceUSD(d);
    return NextResponse.json({ mode: 'model', range }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ mode: 'model', range: modeledPriceUSD(2000) }, { status: 200 });
  }
}
