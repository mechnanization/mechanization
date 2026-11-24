import { adminCreateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import type { CitizenFormValues } from './citizen-form-values';
import { toSubmission } from './citizen-form-payload';

/*
  The citizen form's validation, which is the server's own schema run on what
  the server would receive (GOD-22). Moved out of
  `components/admin/citizen-form.tsx` as it was.
*/

/**
 * Validates the whole record at once, against the same schema the server
 * validates against.
 *
 * Not "the same rules" — the same object. `adminCreateCitizenSubmissionSchema`
 * is what the controller's validation pipe runs, so what this form accepts and
 * what the server accepts cannot drift, and neither can the subtler half: which
 * complaints a «غير مؤكَّد» flag is allowed to excuse. That matters most in the
 * case this feature exists for, where the officer is offline and the server is
 * hours away from seeing the record — a browser that were more permissive would
 * queue registrations that fail on arrival, in a settlement nobody is going
 * back to.
 *
 * The wizard checked one step per «التالي» because that was the only moment it
 * could. A single page has no such moment, so everything is checked on save —
 * and the caller gets one flat error map covering all three sections, which is
 * what lets a mistake in البيانات الشخصية surface while the clerk is looking
 * at العقارات.
 */
export function validate(values: CitizenFormValues): Record<string, string> {
  return submissionFieldErrors(values, adminCreateCitizenSubmissionSchema);
}

/**
 * The shared schema's complaints about this record, keyed by the dot-path of
 * the field each is about — the same check the server runs, run before
 * anything is sent. `schema` is the create or the update submission schema,
 * whichever the caller is about to submit through.
 */
export function submissionFieldErrors(
  values: CitizenFormValues,
  schema: {
    safeParse: (input: unknown) =>
      | { success: true }
      | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  },
): Record<string, string> {
  const result = schema.safeParse(toSubmission(values));
  if (result.success) return {};

  const flagPaths = [...values.flags.keys()];
  const out: Record<string, string> = {};

  for (const issue of result.error.issues) {
    /*
      A complaint about a flag is shown on the field it excuses.

      Zod reports it at `flags.3.reason`, which names nothing on screen — the
      officer sees a reason box under رقم العقار, not a numbered list of flags.
      Resolving the index back to the path is what puts "يرجى ذكر سبب…"
      underneath the box it is about.
    */
    if (issue.path[0] === 'flags') {
      const key = flagPaths[Number(issue.path[1])];
      if (key && !(key in out)) out[key] = issue.message;
      continue;
    }

    const key = issue.path.join('.');
    if (!(key in out)) out[key] = issue.message;
  }

  return out;
}
