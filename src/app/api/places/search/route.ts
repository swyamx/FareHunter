import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const FSQ_V2_ID = process.env.FSQ_CLIENT_ID || '';
const FSQ_V2_SECRET = process.env.FSQ_CLIENT_SECRET || '';
const V2_VERSION = '20231001';
const NEAR_DEFAULT = process.env.FSQ_NEAR_DEFAULT || 'Austin, TX';

function addV2Auth(u: URL) {
  u.searchParams.set('client_id', FSQ_V2_ID);
  u.searchParams.set('client_secret', FSQ_V2_SECRET);
  u.searchParams.set('v', V2_VERSION);
}

export async function GET(req: Request) {
  try {
    if (!FSQ_V2_ID || !FSQ_V2_SECRET) {
      return NextResponse.json({ error: 'Missing FSQ v2 creds' }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const q = (searchParams.get('q') || '').trim();
    const ll = (searchParams.get('ll') || '').trim(); // "lat,lng"
    const near = (searchParams.get('near') || NEAR_DEFAULT).trim();
    const limit = Math.max(1, Math.min(15, Number(searchParams.get('limit') || '10')));

    if (!q || q.length < 2) {
      return NextResponse.json({ features: [] }, { status: 200 });
    }

    const base = 'https://api.foursquare.com/v2';
    const headers: Record<string, string> = { accept: 'application/json' };

    // 1) suggestcompletion
    const uSuggest = new URL(`${base}/venues/suggestcompletion`);
    uSuggest.searchParams.set('query', q);
    uSuggest.searchParams.set('limit', String(limit));
    if (ll) uSuggest.searchParams.set('ll', ll); else uSuggest.searchParams.set('near', near);
    uSuggest.searchParams.set('intent', 'browse');
    addV2Auth(uSuggest);

    // 2) search (fallback/augment)
    const uSearch = new URL(`${base}/venues/search`);
    uSearch.searchParams.set('query', q);
    uSearch.searchParams.set('limit', String(limit));
    if (ll) uSearch.searchParams.set('ll', ll); else uSearch.searchParams.set('near', near);
    uSearch.searchParams.set('intent', 'browse');
    addV2Auth(uSearch);

    const [sugRes, seaRes] = await Promise.all([
      fetch(uSuggest.toString(), { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(uSearch.toString(), { headers }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);

    const out: { label: string; subtitle?: string; lat: number; lng: number }[] = [];
    const seen = new Set<string>();
    const push = (label?: string, subtitle?: string, lat?: number, lng?: number) => {
      if (!label || typeof lat !== 'number' || typeof lng !== 'number') return;
      const key = `${label}|${lat.toFixed(6)},${lng.toFixed(6)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ label, subtitle, lat, lng });
    };

    const minis = sugRes?.response?.minivenues || [];
    for (const v of minis) {
      const name = v?.name as string | undefined;
      const loc = v?.location;
      const lat = loc?.lat, lng = loc?.lng;
      const subtitle = Array.isArray(loc?.formattedAddress)
        ? loc.formattedAddress.join(', ')
        : [loc?.address, loc?.city, loc?.state].filter(Boolean).join(', ');
      push(name, subtitle, lat, lng);
    }

    const venues = seaRes?.response?.venues || [];
    for (const v of venues) {
      const name = v?.name as string | undefined;
      const loc = v?.location;
      const lat = loc?.lat, lng = loc?.lng;
      const subtitle = Array.isArray(loc?.formattedAddress)
        ? loc.formattedAddress.join(', ')
        : [loc?.address, loc?.city, loc?.state].filter(Boolean).join(', ');
      push(name, subtitle, lat, lng);
    }

    return NextResponse.json({ features: out.slice(0, limit) }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ error: 'fsq v2 proxy failed' }, { status: 500 });
  }
}
