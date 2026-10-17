/**
 * The municipality's name in the page's language.
 *
 * On `/en/` it is the English name the municipality entered in الإعدادات
 * (`MunicipalitySettings.nameEn`, «يُستخدم في المستندات والمراسلات باللغة
 * الإنكليزية»), and the Arabic name until one has been entered. Elsewhere it is
 * the Arabic name. `nameAr` is the caller's Arabic name as it already prints
 * it — the registry's `nameAr`, falling back to its `name` — so a page that
 * starts using this changes nothing on its Arabic screens.
 */
export function municipalityNameFor(
  locale: string,
  names: { nameAr?: string | null; nameEn?: string | null },
): string {
  const arabic = names.nameAr?.trim() ?? '';
  if (locale !== 'en') return arabic;
  return names.nameEn?.trim() || arabic;
}
