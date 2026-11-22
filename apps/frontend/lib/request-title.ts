import type { RequestFormRef, RequestType } from '@mechanization/shared-schemas';

/**
 * What a request is called on a screen: its form's name in the page's language, falling back to Arabic (every request is on
 * a form since the built-in types went, open decisions §24 F1). The type label stands in only for a request that has no
 * form to name it — never one filed after 0112.
 */
export function requestTitle(
  request: { form: Pick<RequestFormRef, 'nameAr' | 'nameEn'> | null; requestType: RequestType },
  locale: string,
  typeLabels: Record<RequestType, string>,
): string {
  const { form } = request;
  if (form) return locale === 'en' && form.nameEn ? form.nameEn : form.nameAr;
  return typeLabels[request.requestType];
}
