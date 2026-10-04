import { ArgumentsHost, HttpStatus, NotFoundException } from '@nestjs/common';
import { ConflictError, ValidationError } from '../../application/common/exceptions';
import { DomainExceptionFilter } from './domain-exception.filter';

/** Runs the filter against a fake response and returns what it sent. */
function send(exception: unknown): { status: number; body: Record<string, unknown> } {
  const sent: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
  const response = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      sent.body = body;
      return this;
    },
  };
  const request = { method: 'POST', originalUrl: '/api/v1/t/x/fees', correlationId: 'c-1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;

  const filter = new DomainExceptionFilter();
  // Keep test output quiet; the filter logs every refusal.
  (filter as unknown as { logger: { warn: () => void; error: () => void } }).logger = {
    warn: () => undefined,
    error: () => undefined,
  };
  filter.catch(exception, host);
  return sent;
}

describe('DomainExceptionFilter', () => {
  it('sends a coded refusal as code, kind and params, with the English message for logs', () => {
    const { status, body } = send(
      new ConflictError({
        code: 'PAYMENT_EXCEEDS_BALANCE',
        message: 'Amount 20 exceeds the balance 10',
        params: { amount: 20, outstanding: 10 },
      }),
    );

    expect(status).toBe(HttpStatus.CONFLICT);
    expect(body).toEqual({
      code: 'PAYMENT_EXCEEDS_BALANCE',
      kind: 'CONFLICT',
      message: 'Amount 20 exceeds the balance 10',
      params: { amount: 20, outstanding: 10 },
      correlationId: 'c-1',
    });
  });

  it('sends a prose refusal with its kind as the code and its details', () => {
    const { status, body } = send(new ValidationError('نص', [{ path: 'phone', message: 'x' }]));

    expect(status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(body).toEqual({
      code: 'VALIDATION_FAILED',
      kind: 'VALIDATION_FAILED',
      message: 'نص',
      details: [{ path: 'phone', message: 'x' }],
      correlationId: 'c-1',
    });
  });

  it('gives Nest exceptions and unknown errors a kind too', () => {
    expect(send(new NotFoundException()).body).toMatchObject({ code: 'HTTP_ERROR', kind: 'HTTP_ERROR' });

    const internal = send(new Error('relation "x" does not exist'));
    expect(internal.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(internal.body).toMatchObject({ code: 'INTERNAL_ERROR', kind: 'INTERNAL_ERROR' });
    expect(String(internal.body.message)).not.toContain('does not exist');
  });
});
