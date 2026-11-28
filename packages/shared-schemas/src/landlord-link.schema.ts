import { z } from 'zod';
import { uuid } from './primitives';

/**
 * The bodies of the owner-link answers (روابط المالكين), validated where they
 * arrive (audit SEC-03, 2026-11-27). Read raw before, a body that was not the
 * shape (`citizenId: "x"`, `candidateIds: "x"`) reached the database as a
 * malformed uuid: a 500 and a Sentry event, not the 400 it is.
 */

/**
 * The most citizens one «لا أحد منهم» or its «تراجع» names: the candidates a
 * card's number matches (`candidatesFor`), every active citizen on one phone.
 * A household line holds a few; a hundred is a request that is not one.
 */
export const LANDLORD_LINK_CANDIDATES_MAX = 100;

/** «نعم، هذا هو المالك»: the citizen the clerk says owns the card. */
export const confirmLandlordLinkSchema = z.object({
  citizenId: uuid,
});
export type ConfirmLandlordLink = z.infer<typeof confirmLandlordLinkSchema>;

/**
 * «لا أحد منهم» and its «تراجع»: the citizens the clerk was shown. An empty
 * list passes the schema and is refused by the service with its own code
 * (`DISMISS_CANDIDATES_REQUIRED`), which the screen words.
 */
export const landlordLinkCandidatesSchema = z.object({
  candidateIds: z.array(uuid).max(LANDLORD_LINK_CANDIDATES_MAX),
});
export type LandlordLinkCandidates = z.infer<typeof landlordLinkCandidatesSchema>;
