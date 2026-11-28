import 'reflect-metadata';
import { PipeTransform } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ValidationError } from '../../application/common/exceptions';
import { AuthController } from './auth.controller';
import { CitizenLandlordLinksController } from './citizen-landlord-links.controller';

/**
 * The bodies SEC-03 put behind a schema, run through the pipe each handler
 * carries — not the schema alone — so the route and its contract are tested
 * together. Before, `@Body('citizenId')` handed «x» to Prisma as a uuid and
 * `@Body('candidateIds')` dropped what was not a string: a 500 and a Sentry
 * event, or a silent nothing. Now each is a `ValidationError`, which
 * `DomainExceptionFilter` answers 400 (`VALIDATION_FAILED`).
 */
const ID = '3f2a0000-0000-4000-8000-00000000abcd';

function bodyPipe(controller: object, method: string): PipeTransform {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<
    string,
    { pipes?: PipeTransform[] }
  >;
  const body = Object.entries(args).find(([key]) => key.startsWith(`${RouteParamtypes.BODY}:`));
  const pipe = body?.[1].pipes?.[0];
  if (!pipe) throw new Error(`${method} has no body pipe`);
  return pipe;
}

const refused = (pipe: PipeTransform, value: unknown) => {
  try {
    pipe.transform(value, { type: 'body' });
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('the owner-link answers validate their bodies (SEC-03)', () => {
  const confirm = bodyPipe(CitizenLandlordLinksController, 'confirmLandlordLink');

  it('takes a citizen id', () => {
    expect(confirm.transform({ citizenId: ID }, { type: 'body' })).toEqual({ citizenId: ID });
  });

  it.each([[{}], [{ citizenId: 'x' }], [{ citizenId: 42 }], [null], ['x']])('refuses %j as a 400', (body) => {
    expect(refused(confirm, body)).toBeInstanceOf(ValidationError);
  });

  describe.each(['dismissLandlordLink', 'restoreLandlordLink'])('%s', (method) => {
    const pipe = bodyPipe(CitizenLandlordLinksController, method);

    it('takes the ids, and leaves an empty list to the service’s own coded refusal', () => {
      expect(pipe.transform({ candidateIds: [ID] }, { type: 'body' })).toEqual({ candidateIds: [ID] });
      expect(pipe.transform({ candidateIds: [] }, { type: 'body' })).toEqual({ candidateIds: [] });
    });

    it.each([
      [{}],
      [{ candidateIds: 'x' }],
      [{ candidateIds: ['x'] }],
      [{ candidateIds: [ID, 7] }],
      [{ candidateIds: Array.from({ length: 101 }, () => ID) }],
    ])('refuses %j as a 400', (body) => {
      expect(refused(pipe, body)).toBeInstanceOf(ValidationError);
    });
  });
});

describe('«إرسال رابط إعادة التعيين» validates its body (SEC-03)', () => {
  const pipe = bodyPipe(AuthController, 'sendResetPasswordEmail');

  it('takes a page to open, or none', () => {
    expect(pipe.transform({ redirectTo: 'https://baladyia.com/t/x/reset-password' }, { type: 'body' })).toEqual({
      redirectTo: 'https://baladyia.com/t/x/reset-password',
    });
    expect(pipe.transform({}, { type: 'body' })).toEqual({});
  });

  it.each([[{ redirectTo: 42 }], [{ redirectTo: 'x'.repeat(2049) }], [null]])('refuses %j as a 400', (body) => {
    expect(refused(pipe, body)).toBeInstanceOf(ValidationError);
  });
});
