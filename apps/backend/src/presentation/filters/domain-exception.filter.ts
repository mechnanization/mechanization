import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { Request, Response } from 'express';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  TenantMismatchError,
  TenantNotProvisionedError,
  UnauthorizedError,
  ValidationError,
} from '../../application/common/exceptions';
import { reportException } from '../config/sentry';
import { redactUrl } from '../config/sentry-redaction';

const STATUS_BY_ERROR: Array<[new (...args: never[]) => DomainError, HttpStatus]> = [
  [NotFoundError, HttpStatus.NOT_FOUND],
  [ConflictError, HttpStatus.CONFLICT],
  [ValidationError, HttpStatus.UNPROCESSABLE_ENTITY],
  [UnauthorizedError, HttpStatus.UNAUTHORIZED],
  [TenantMismatchError, HttpStatus.FORBIDDEN],
  [TenantNotProvisionedError, HttpStatus.SERVICE_UNAVAILABLE],
  [ForbiddenError, HttpStatus.FORBIDDEN],
];

/**
 * The one place errors become HTTP.
 *
 * Controllers contain no try/catch at all — that is deliberate. Scattering
 * error handling across handlers is how response shapes silently drift apart,
 * and how an internal message eventually reaches a citizen's screen.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const correlationId = request.correlationId;

    const { status, body } = this.describe(exception, correlationId);

    // Leads with `error (STATUS): message` so the terminal reads the same way
    // as the frontend's own console output — the request context (method,
    // path, correlationId) trails it rather than burying the message behind
    // an arrow.
    if (status >= 500) {
      // The client only ever gets the generic body message; the log gets the
      // real exception detail (and full stack, never sent to the client).
      const detail = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(
        `error (${status}): ${detail} — ${request.method} ${request.originalUrl} [${correlationId}]`,
        exception instanceof Error ? exception.stack : undefined,
      );

      /*
        Sentry gets 5xx and nothing else, and the boundary is the point.

        A 404 on a citizen who was never registered, a 409 on a duplicate
        filing, a 422 from Zod — these are the system working. They are the
        overwhelming majority of what this filter sees, and routing them to an
        issue tracker would bury the handful of events that mean a bug under
        thousands that mean a clerk mistyped a number. What lands here at 500 is
        the `INTERNAL_ERROR` branch of `describe` below: something unrecognised,
        which is the definition of a bug.

        `correlationId` is what ties the report to everything else. It is
        already in the response the client holds and in the log line above, so a
        citizen quoting "it said try again later" reaches the right issue
        without anyone having to name the citizen.
      */
      reportException(exception, {
        correlationId,
        method: request.method,
        route: redactUrl(request.originalUrl ?? ''),
        tenant: request.tenant?.slug,
      });
    } else {
      this.logger.warn(
        `error (${status}): ${body.message} — ${request.method} ${request.originalUrl} [${correlationId}]`,
      );
    }

    response.status(status).json(body);
  }

  private describe(
    exception: unknown,
    correlationId?: string,
  ): { status: HttpStatus; body: Record<string, unknown> } {
    if (exception instanceof DomainError) {
      const match = STATUS_BY_ERROR.find(([type]) => exception instanceof type);
      const status = match?.[1] ?? HttpStatus.BAD_REQUEST;

      return {
        status,
        body: {
          code: exception.code,
          message: exception.message,
          // Both error types carry an optional payload the client has to act
          // on — the fields that failed, or the buildings already on the parcel.
          ...((exception instanceof ValidationError || exception instanceof ConflictError) &&
          exception.details
            ? { details: exception.details }
            : {}),
          correlationId,
        },
      };
    }

    // Nest's own exceptions (404 on an unmatched route, payload-too-large from
    // the body parser) still need a consistent shape.
    if (exception instanceof HttpException) {
      const payload = exception.getResponse();
      return {
        status: exception.getStatus(),
        body: {
          code: 'HTTP_ERROR',
          message:
            typeof payload === 'string'
              ? payload
              : ((payload as { message?: string }).message ?? exception.message),
          correlationId,
        },
      };
    }

    /**
     * Anything unrecognised is a bug. The client gets a generic message and the
     * correlation id — enough for a citizen to quote to the municipality, and
     * nothing about the database, the stack, or which table failed.
     */
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'حدث خطأ غير متوقع. يرجى المحاولة لاحقاً أو مراجعة البلدية.',
        correlationId,
      },
    };
  }
}
