import { Injectable } from '@nestjs/common';
import {
  adminCreateCitizenSchema,
  buildCitizenPayload,
  IMPORT_COLUMNS,
  isSpecificErrorCode,
} from '@mechanization/shared-schemas';
import type {
  AdminCitizenSubmission,
  CitizenImportResult,
  CitizenImportRowResult,
  ImportRow,
} from '@mechanization/shared-schemas';
import { DomainError } from '../../common/exceptions';
import { CitizenDuplicatesService } from './citizen-duplicates.service';
import { CitizensService } from './citizens.service';

/**
 * Turns a Zod issue path into the Arabic column header the clerk sees.
 *
 * The message alone ("الطابق مطلوب") is not enough to act on when the file has
 * twenty-nine columns: the clerk needs to know which one to look at. Paths are
 * nested (`properties.0.units.0.floor`) while the spreadsheet is flat, so the
 * leaf name is what identifies the column — except inside `units`, where the
 * flat template prefixes the header to keep it distinct from the property's own
 * `side`/`unitArea`.
 */
function columnHeaderFor(path: ReadonlyArray<PropertyKey> | undefined): string | undefined {
  if (!path || path.length === 0) return undefined;

  const leaf = path.filter((segment): segment is string => typeof segment === 'string').at(-1);
  if (!leaf) return undefined;

  const key = path.includes('units') && leaf === 'floor' ? 'unitFloor' : leaf;
  return IMPORT_COLUMNS.find((column) => column.key === key)?.header;
}

/**
 * A row the import could not file, as the dialog reads it: a coded refusal by
 * its code and params, whose words are the screen's (its `message` is an
 * English log line), and anything else by the text it carried — Arabic prose
 * from a throw site not converted yet.
 */
function importFailure(caught: unknown): Pick<CitizenImportRowResult, 'error' | 'code' | 'params'> {
  if (caught instanceof DomainError && isSpecificErrorCode(caught.code)) {
    return { code: caught.code, ...(caught.params ? { params: caught.params } : {}) };
  }
  return { error: caught instanceof Error ? caught.message : 'تعذّر إنشاء السجل' };
}

/**
 * «استيراد السجل»: a municipality's existing register, filed row by row
 * through the one write path a new file takes (`CitizensService.create`).
 *
 * Its own service since audit GOD-11 (2026-11-27). It owns no write of its
 * own: every row is shaped, validated and then either screened (a dry run) or
 * filed by `create`, so the guarantees of a filing stay in one place.
 */
@Injectable()
export class CitizenImportService {
  constructor(
    private readonly citizens: CitizensService,
    private readonly duplicates: CitizenDuplicatesService,
  ) {}

  /**
   * Bulk import — a municipality's existing register, one spreadsheet row per
   * citizen.
   *
   * Three decisions worth stating, because each has an obvious wrong answer:
   *
   * **Rows are independent.** One malformed row does not abort the batch and
   * does not roll back the rows before it. A register of two hundred typed by
   * hand over years will contain a handful of bad rows, and an all-or-nothing
   * import means the clerk fixes one, re-uploads, and discovers the next — two
   * hundred round trips to load two hundred citizens. Each row reports its own
   * outcome and the clerk re-uploads only what failed.
   *
   * **Sequential, not `Promise.all`.** Every row resolves parcels and writes a
   * registration inside a transaction; the tenant pool is five connections
   * (`connection_limit=5`), so a parallel map over two hundred rows exhausts it
   * and fails rows for reasons that have nothing to do with their data.
   *
   * **`dryRun` writes nothing.** It runs the identical shaping and validation
   * and reports what would happen, which is what makes the preview screen
   * trustworthy — it is not a second, weaker check written for the UI.
   */
  async importMany(input: {
    tenantSlug: string;
    rows: ReadonlyArray<ImportRow>;
    /** Row number of `rows[0]` in the clerk's file, so batches stay addressable. */
    startRow: number;
    dryRun: boolean;
    actor: { id: string; role: string };
  }): Promise<CitizenImportResult> {
    const results: CitizenImportRowResult[] = [];

    for (const [index, raw] of input.rows.entries()) {
      const row = input.startRow + index;
      // Name is echoed back even on failure: "الصف ٧ فشل" is far harder to act
      // on than "الصف ٧ — علي حسن فشل" when the clerk is scanning a spreadsheet.
      const name = [raw['firstName'], raw['lastName']].filter(Boolean).join(' ').trim() || undefined;

      const parsed = adminCreateCitizenSchema.safeParse(buildCitizenPayload(raw));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        results.push({
          row,
          ok: false,
          name,
          error: issue?.message ?? 'صف غير صالح',
          column: columnHeaderFor(issue?.path),
        });
        continue;
      }

      /*
        A spreadsheet row carries no `UNESTABLISHED` flags, and cannot.

        «غير مؤكَّد» is a statement by a named officer about one field they
        personally could not establish, with their reason. A bulk import is
        a municipality's existing paper register arriving in one file, with
        nobody standing behind any individual gap — so a row is either
        complete enough for `adminCreateCitizenSchema`, which validated it
        above, or it is reported as a failed row for the clerk to fix.

        An imported row can still end up carrying an `UNVERIFIED` one, and
        that is the point: the submit path checks every رقم العقار against
        the cadastre and annotates the ones it cannot find. A register typed
        up over years is exactly where those live, and a row that used to be
        rejected outright — losing the household's data over a parcel the
        survey office has not exported yet — now lands as «يتطلب مراجعة»
        with the number intact and the reason attached.
      */
      /*
        A spreadsheet row carries no blanket reason either, and could not.
        The reason is a sentence an officer says about a visit they made;
        a row typed from a ledger years ago has no visit behind it, and
        inventing one would put words in somebody's mouth on a record that
        outlives them.
      */
      const payload: AdminCitizenSubmission = {
        ...parsed.data,
        // A register typed up from paper is a register of households; an
        // owner record is a decision somebody makes at a doorstep.
        residence: 'RESIDENT',
        flags: [],
        blanketFlagReason: undefined,
        // Nor a note, and for the same reason: a note is something an
        // officer observed at a door. A spreadsheet row has no visit
        // behind it to have observed anything.
        notes: undefined,
        clientSubmissionId: undefined,
      };

      /*
        The dry run asks the duplicate question the import will, on the payload
        it will file: a row certainly somebody on file fails here as it would
        there, and one that only resembles somebody is said to, since it will
        land at «يتطلب مراجعة». Rows are not compared with each other: a
        person listed twice in one file passes the preview, and the import
        refuses or holds the second against the first it has just written.
      */
      if (input.dryRun) {
        try {
          const { open } = await this.duplicates.screenForDuplicates({ payload, actor: input.actor });
          results.push({
            row,
            ok: true,
            name,
            ...(open.possibleDuplicates.length > 0
              ? { possibleDuplicateOf: open.possibleDuplicates.map((candidate) => candidate.fullName) }
              : {}),
          });
        } catch (caught) {
          results.push({ row, ok: false, name, ...importFailure(caught) });
        }
        continue;
      }

      try {
        const created = await this.citizens.create({ tenantSlug: input.tenantSlug, payload, actor: input.actor });
        results.push({ row, ok: true, name, referenceNumber: created.referenceNumber });
      } catch (caught) {
        // A duplicate identity document is the commonest real failure — the
        // same person already on the register, or listed twice in the file —
        // and it is a fact about that row, not a reason to stop the batch.
        results.push({ row, ok: false, name, ...importFailure(caught) });
      }
    }

    return {
      dryRun: input.dryRun,
      created: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  }
}
