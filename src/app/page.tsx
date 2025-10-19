// src/app/page.tsx  (SERVER component – no 'use client')
export const dynamic = 'force-dynamic';
export const revalidate = 0;

import PageClient from './PageClient'; // <-- plain import (PageClient has 'use client')

export default function Page() {
  return <PageClient />;
}
