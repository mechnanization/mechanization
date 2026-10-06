import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  The words live in `messages/{ar,en}.json`, under `auditActions` and
  `auditEntities`. They are plain labels with no placeholders, so these are
  lookups, not translators. A new audit action gets its label there, in both
  files (apps/backend/CLAUDE.md, «Events and audit»).
*/
const ACTIONS: Record<'ar' | 'en', Record<string, string>> = { ar: ar.auditActions, en: en.auditActions };
const ENTITIES: Record<'ar' | 'en', Record<string, string>> = { ar: ar.auditEntities, en: en.auditEntities };

/**
 * What an audit action is called, in words a clerk recognises.
 *
 * The audit page carried its own map of nineteen actions, written when those
 * were the nineteen that existed. The register has recorded twenty-five
 * distinct actions since, and the missing ones — `BUILDING_CREATED`,
 * `LANDLORD_LINKED`, `OCCUPANCY_RECORDED` among them — fell through to their
 * raw constant. «OCCUPANCY_RECORDED» on an Arabic screen is not a label, it is
 * an apology.
 *
 * So the map lives here instead, beside nothing, and both the whole-portal
 * trail and a single record's history read from it.
 *
 * An unknown action still falls back to its own code rather than to something
 * vague like «إجراء». A code somebody can search the source for beats a word
 * that tells them nothing.
 */
export function auditActionLabel(action: string, locale: string): string {
  return ACTIONS[locale === 'en' ? 'en' : 'ar'][action] ?? action;
}

/**
 * Which `entityType` a screen should ask for.
 *
 * Worth stating because it is not guessable: a citizen's own trail is filed
 * under `User`, not `Citizen`. `users` holds staff and citizens both, and the
 * audit log names the table rather than the kind — so «ربط مالك بمستأجر» on a
 * citizen sits under `User` beside that citizen's id.
 */
export const AUDIT_ENTITY = {
  citizen: 'User',
  building: 'Building',
  registration: 'Registration',
  zone: 'Zone',
  case: 'Case',
} as const;

/** What kind of record an entry is about, in words — for the filter and the fallback target. */
export function auditEntityLabel(entityType: string, locale: string): string {
  return ENTITIES[locale === 'en' ? 'en' : 'ar'][entityType] ?? entityType;
}
