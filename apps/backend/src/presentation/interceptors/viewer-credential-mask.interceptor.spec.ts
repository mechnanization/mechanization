import { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { ViewerCredentialMaskInterceptor, maskCredentials } from './viewer-credential-mask.interceptor';

/*
  «مشاهد فقط» reads citizens and their data, never a login credential: every
  response to a VIEWER token carries the رقم مرجعي masked; nobody else's does.
*/

const REFERENCE = 'BZR-2609-ABCDEF';

function contextFor(user: { kind: string; role?: string } | undefined) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

async function respond(user: { kind: string; role?: string } | undefined, body: unknown) {
  const interceptor = new ViewerCredentialMaskInterceptor();
  return lastValueFrom(interceptor.intercept(contextFor(user), { handle: () => of(body) }));
}

describe('ViewerCredentialMaskInterceptor', () => {
  const body = {
    items: [{ id: 'c1', fullName: 'علي', referenceNumber: REFERENCE, phone: '+96170123456' }],
    citizenReferenceNumber: REFERENCE,
    total: 1,
  };

  it('masks every رقم مرجعي in a VIEWER response, deep in lists and objects, and keeps the data', async () => {
    const answer = (await respond({ kind: 'STAFF', role: 'VIEWER' }, body)) as typeof body;
    expect(answer.items[0]!.referenceNumber).toBe('BZR-2609-••••••');
    expect(answer.citizenReferenceNumber).toBe('BZR-2609-••••••');
    expect(answer.items[0]!.phone).toBe('+96170123456');
    expect(answer.items[0]!.fullName).toBe('علي');
  });

  it('leaves every other role’s response exactly as it was', async () => {
    for (const role of ['SUPER_ADMIN', 'AUDITOR', 'ADMINISTRATIVE_OFFICER', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT']) {
      expect(await respond({ kind: 'STAFF', role }, body)).toBe(body);
    }
  });

  it('leaves a citizen’s own response alone, and a public one', async () => {
    expect(await respond({ kind: 'CITIZEN' }, body)).toBe(body);
    expect(await respond(undefined, body)).toBe(body);
  });

  it('masks the reference under every key that carries one, listed or not', () => {
    const answer = maskCredentials({
      payments: [{ id: 'p1', citizenReference: REFERENCE, citizenName: 'علي' }],
      landlord: { landlordReferenceNumber: REFERENCE },
      // A key nobody listed, and a reference inside a sentence.
      tenant: { reference: REFERENCE },
      note: `أُعيد الملف ${REFERENCE} إلى الموظف`,
    }) as Record<string, unknown>;
    expect(answer).toEqual({
      payments: [{ id: 'p1', citizenReference: 'BZR-2609-••••••', citizenName: 'علي' }],
      landlord: { landlordReferenceNumber: 'BZR-2609-••••••' },
      tenant: { reference: 'BZR-2609-••••••' },
      note: 'أُعيد الملف BZR-2609-•••••• إلى الموظف',
    });
  });

  it('hides a named key whole when its value does not fit the format', () => {
    expect(maskCredentials({ referenceNumber: 'legacy-0042' })).toEqual({ referenceNumber: '••••••' });
  });

  it('leaves strings that only look like a reference alone', () => {
    const lookalikes = ['2026-10-06', 'BZR-2609', 'Z01-0304-A', '+96170123456', 'BZR-2609-ABCDE1'];
    expect(maskCredentials(lookalikes)).toEqual(lookalikes);
  });

  it('passes dates, nulls and non-plain values through untouched', () => {
    const at = new Date('2026-10-05T10:00:00Z');
    expect(maskCredentials({ at, referenceNumber: null, nested: [1, 'x', null] })).toEqual({
      at,
      referenceNumber: null,
      nested: [1, 'x', null],
    });
    expect(maskCredentials('a,b,c')).toBe('a,b,c');
  });
});
