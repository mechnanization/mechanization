import { cache } from 'react';
import type { PublicTenantConfig } from '@/lib/api-client';
import { API_URL } from '@/lib/public-config';

/**
 * The municipality's public config, fetched on the server — once per request
 * (DRY-14).
 *
 * Three layouts and the manifest route each fetched `GET t/<slug>/tenant/config`
 * with a copy of the same function, trusting Next to dedupe the identical
 * `fetch`es. `cache()` makes that a promise of ours rather than a hope: however
 * many of them ask in one request, one answer comes back. Revalidated every
 * 5 minutes across requests.
 *
 * Null for an unknown municipality or an API that did not answer; `TenantLayout`
 * turns that into `notFound()`, and the callers that only want the name (the
 * header, the manifest) fall back to a generic one.
 */
export const fetchTenantConfig = cache(async (slug: string): Promise<PublicTenantConfig | null> => {
  try {
    const response = await fetch(`${API_URL}/t/${slug}/tenant/config`, {
      next: { revalidate: 300 },
    });
    if (!response.ok) return null;
    return (await response.json()) as PublicTenantConfig;
  } catch {
    return null;
  }
});

/** The municipality's name in the page's language (Arabic where the English is missing, and the reverse), or undefined. */
export async function tenantDisplayName(slug: string, locale: string = 'ar'): Promise<string | undefined> {
  const config = await fetchTenantConfig(slug);
  if (!config) return undefined;
  return locale === 'en' ? (config.name ?? config.nameAr) : (config.nameAr ?? config.name);
}
