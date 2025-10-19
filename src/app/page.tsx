// src/app/page.tsx (SERVER component – no 'use client')
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import NextDynamic from 'next/dynamic'; // <-- alias to avoid name clash

// Load the client UI without SSR
const PageClient = NextDynamic(() => import('./PageClient'), { ssr: false });

export default function Page() {
  return <PageClient />;
}
