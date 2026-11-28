import { PipeTransform } from '@nestjs/common';
import { TypeOf, ZodTypeAny } from 'zod';
import { ValidationError } from '../exceptions';

/**
 * Validates a request body against a schema shared with the frontend, so a field
 * cannot be optional in the form and required on the server.
 *
 * Throws a domain `ValidationError` rather than Nest's `BadRequestException`:
 * error-to-HTTP translation happens in exactly one place (DomainExceptionFilter),
 * and a pipe reaching for an HTTP exception would be the first crack in that.
 */
export class ZodValidationPipe<S extends ZodTypeAny>
  implements PipeTransform<unknown, TypeOf<S>>
{
  /**
   * Generic over the *schema*, not over a bare output type. Several schemas here
   * carry a `.transform()` — `contactDetailsSchema` fills `whatsapp` from
   * `phone` — so their input and output shapes genuinely differ. Declaring
   * `ZodSchema<T>` collapses the two and hands callers the pre-transform type.
   */
  constructor(private readonly schema: S) {}

  transform(value: unknown): TypeOf<S> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      // Field-level detail is returned to the client on purpose: the wizard
      // highlights the offending step, and every message here is already
      // user-facing Arabic written for a citizen, not a stack trace.
      throw new ValidationError({
        code: 'REQUEST_BODY_INVALID',
        message: 'The request body failed validation',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    return result.data;
  }
}
