import { Prisma } from '../../generated/tenant-client';

/**
 * The folded text a citizen search token is matched against, for a `users`
 * row aliased `alias` (`users."searchText"`, migrations 0018 and 0044).
 *
 * For «مشاهد فقط» the citizen's رقم مرجعي is taken out first, in both forms the
 * column holds it: spaced inside the folded run («bzr 2608 nz58vk») and
 * compacted after it («bzr2608nz58vk»). That role is shown the reference
 * masked (`ViewerCredentialMaskInterceptor`), and a search that still matched
 * on it would answer "does this citizen come back for `nz5`?" for any fragment
 * — a few hundred such questions spell out a credential that signs in alone.
 * Every other role is shown the reference, so its search is unchanged.
 *
 * `replace` with an empty pattern returns its input, so a citizen with no
 * reference is matched on everything else exactly as before.
 *
 * `S` is the tenant schema reference (`tenantSchemaRef`): the fold functions
 * live in each tenant schema and raw SQL never relies on `search_path` (D22).
 * `alias` is a constant from the call site, never input.
 */
export function citizenSearchText(S: Prisma.Sql, role: string | null | undefined, alias = 'u'): Prisma.Sql {
  const column = Prisma.raw(`${alias}."searchText"`);
  if (role !== 'VIEWER') return column;
  const reference = Prisma.raw(`${alias}."referenceNumber"`);
  return Prisma.sql`replace(replace(${column}, ${S}search_compact(${reference}), ''), ${S}search_normalize(${reference}), '')`;
}
