import { randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from '../prisma/tenant-migrator';
import { tenantTestClient } from '../prisma/tenant-test-client';
import { TenantContextService } from '../context/tenant-context.service';
import { OtplibTotpService } from '../security/totp.service';
import { PrismaUserRepository } from './user.repository';

/**
 * The staff second factor's guard against a real Postgres (migration 0101):
 * a code is accepted once, wrong codes are counted per account, and enough of
 * them stop the account checking codes for a while.
 *
 * The first test is security audit N-1 as it was found: the same code at step
 * S and again at S+1. It runs through the real otplib adapter and the real
 * conditional write, so it fails if either goes back to the clock's step.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_totp_guard_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const SECRET = authenticator.generateSecret();
const STEP_MS = 30_000;
const S = 59_000_000;
const POLICY = { maxFailures: 5, lockSeconds: 900 };

const atStep = (step: number, intoStepMs = 10_000) => new Date(step * STEP_MS + intoStepMs);

function codeAt(at: Date): string {
  const app = authenticator.clone();
  app.options = { epoch: at.getTime(), step: 30 };
  return app.generate(SECRET);
}

describeIfDb('the TOTP guard (PrismaUserRepository + OtplibTotpService)', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let users: PrismaUserRepository;
  const totp = new OtplibTotpService();

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-totp', tenantSlug: 'totp', schemaName: SCHEMA, prisma: db }, work);

  async function enrolledStaff(): Promise<string> {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'STAFF',
        tenantSlug: 'totp',
        email: `admin-${id}@totp.gov.lb`,
        passwordHash: 'hash',
        firstName: 'مدير',
        lastName: 'النظام',
        role: 'SUPER_ADMIN',
        totpSecret: SECRET,
        totpConfirmedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    return id;
  }

  const row = (id: string) =>
    db.user.findUniqueOrThrow({
      where: { id },
      select: { lastTotpStep: true, totpFailedAttempts: true, totpLockedUntil: true },
    });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    users = new PrismaUserRepository(context);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('refuses at S+1 a code it accepted at S (N-1), and accepts the next code', async () => {
    const id = await enrolledStaff();
    const code = codeAt(atStep(S));

    const first = totp.matchStep(code, SECRET, atStep(S));
    expect(first).toBe(S);
    expect(await within(() => users.recordTotpStep(id, first!, atStep(S)))).toEqual({ accepted: true });

    const again = totp.matchStep(code, SECRET, atStep(S + 1));
    expect(again).not.toBeNull(); // it still verifies…
    expect(await within(() => users.recordTotpStep(id, again!, atStep(S + 1)))).toEqual({
      accepted: false,
      lockedUntil: null,
    }); // …and is refused as spent.

    const next = totp.matchStep(codeAt(atStep(S + 1)), SECRET, atStep(S + 1));
    expect(next).toBe(S + 1);
    expect(await within(() => users.recordTotpStep(id, next!, atStep(S + 1)))).toEqual({ accepted: true });
    expect((await row(id)).lastTotpStep).toBe(BigInt(S + 1));
  });

  it('lets one of two sign-ins racing with the same code win', async () => {
    const id = await enrolledStaff();
    const now = atStep(S);

    const outcomes = await Promise.all([
      within(() => users.recordTotpStep(id, S, now)),
      within(() => users.recordTotpStep(id, S, now)),
    ]);

    expect(outcomes.filter((outcome) => outcome.accepted)).toHaveLength(1);
  });

  it('locks on the fifth wrong code and starts the count again', async () => {
    const id = await enrolledStaff();
    const now = atStep(S);

    for (let i = 1; i < POLICY.maxFailures; i += 1) {
      expect(await within(() => users.recordTotpFailure(id, POLICY, now))).toEqual({ lockedUntil: null });
    }
    expect((await row(id)).totpFailedAttempts).toBe(POLICY.maxFailures - 1);

    const { lockedUntil } = await within(() => users.recordTotpFailure(id, POLICY, now));
    expect(lockedUntil?.getTime()).toBe(now.getTime() + POLICY.lockSeconds * 1000);
    expect(await row(id)).toMatchObject({ totpFailedAttempts: 0, totpLockedUntil: lockedUntil });
  });

  it('refuses a right code while locked, and the first right code after clears it', async () => {
    const id = await enrolledStaff();
    const now = atStep(S);
    for (let i = 0; i < POLICY.maxFailures; i += 1) {
      await within(() => users.recordTotpFailure(id, POLICY, now));
    }
    const { totpLockedUntil } = await row(id);

    const during = atStep(S + 2);
    expect(await within(() => users.recordTotpStep(id, S + 2, during))).toEqual({
      accepted: false,
      lockedUntil: totpLockedUntil,
    });
    expect((await row(id)).lastTotpStep).toBeNull(); // nothing was burned

    const after = new Date(totpLockedUntil!.getTime() + 1_000);
    const step = Math.floor(after.getTime() / STEP_MS);
    expect(await within(() => users.recordTotpStep(id, step, after))).toEqual({ accepted: true });
    expect(await row(id)).toMatchObject({ totpFailedAttempts: 0, totpLockedUntil: null });
  });

  it('counts two wrong codes sent together as two', async () => {
    const id = await enrolledStaff();
    const now = atStep(S);

    await Promise.all([
      within(() => users.recordTotpFailure(id, POLICY, now)),
      within(() => users.recordTotpFailure(id, POLICY, now)),
    ]);

    expect((await row(id)).totpFailedAttempts).toBe(2);
  });

  it('a right code clears the count of wrong ones before it', async () => {
    const id = await enrolledStaff();
    const now = atStep(S);
    await within(() => users.recordTotpFailure(id, POLICY, now));
    await within(() => users.recordTotpFailure(id, POLICY, now));

    await within(() => users.recordTotpStep(id, S, now));

    expect((await row(id)).totpFailedAttempts).toBe(0);
  });

  it('disabling the factor clears the count and the lockout', async () => {
    const id = await enrolledStaff();
    for (let i = 0; i < POLICY.maxFailures; i += 1) {
      await within(() => users.recordTotpFailure(id, POLICY, atStep(S)));
    }

    await within(() => users.disableTotp(id));

    expect(await row(id)).toMatchObject({ lastTotpStep: null, totpFailedAttempts: 0, totpLockedUntil: null });
  });

  /*
    A second factor being replaced (audit SEC-02, migration 0116): the new
    secret waits in `totpPendingSecret`, the confirmed one keeps signing in, and
    the confirmation moves the secret it verified or nothing.
  */
  const factor = (id: string) =>
    db.user.findUniqueOrThrow({
      where: { id },
      select: { totpSecret: true, totpConfirmedAt: true, totpPendingSecret: true, tokenVersion: true },
    });

  it('keeps the confirmed factor while a new one waits, and swaps them on confirmation', async () => {
    const id = await enrolledStaff();
    const before = await factor(id);

    await within(() => users.savePendingTotpSecret(id, 'NEWSECRET'));
    expect(await factor(id)).toMatchObject({
      totpSecret: SECRET,
      totpConfirmedAt: before.totpConfirmedAt,
      totpPendingSecret: 'NEWSECRET',
      tokenVersion: before.tokenVersion,
    });

    expect(await within(() => users.promotePendingTotp(id, 'NEWSECRET'))).toBe(true);
    const after = await factor(id);
    expect(after).toMatchObject({ totpSecret: 'NEWSECRET', totpPendingSecret: null });
    expect(after.totpConfirmedAt).not.toBeNull();
    // Every session of the account ends.
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
  });

  it('promotes nothing when another enrolment replaced the secret since', async () => {
    const id = await enrolledStaff();
    await within(() => users.savePendingTotpSecret(id, 'FIRST'));
    await within(() => users.savePendingTotpSecret(id, 'SECOND'));

    expect(await within(() => users.promotePendingTotp(id, 'FIRST'))).toBe(false);
    expect(await factor(id)).toMatchObject({ totpSecret: SECRET, totpPendingSecret: 'SECOND' });
  });

  it('never promotes over a citizen row, nor a confirmed secret with no pending one', async () => {
    const id = await enrolledStaff();
    // The confirmed factor itself is not "waiting": confirming it again is refused.
    expect(await within(() => users.promotePendingTotp(id, SECRET))).toBe(false);

    const citizen = randomUUID();
    await db.user.create({
      data: {
        id: citizen,
        kind: 'CITIZEN',
        tenantSlug: 'totp',
        firstName: 'مواطن',
        middleName: 'محمد',
        lastName: 'تجريبي',
        referenceNumber: `REF-${citizen.slice(0, 8)}`,
        phone: '+96170123456',
        totpPendingSecret: 'PLANTED',
      },
    });
    await within(() => users.savePendingTotpSecret(citizen, 'X'));
    expect(await within(() => users.promotePendingTotp(citizen, 'PLANTED'))).toBe(false);
    expect((await factor(citizen)).totpPendingSecret).toBe('PLANTED');
  });

  it('disabling clears a pending secret too and ends every session', async () => {
    const id = await enrolledStaff();
    await within(() => users.savePendingTotpSecret(id, 'NEWSECRET'));
    const before = await factor(id);

    await within(() => users.disableTotp(id));

    expect(await factor(id)).toMatchObject({
      totpSecret: null,
      totpConfirmedAt: null,
      totpPendingSecret: null,
      tokenVersion: before.tokenVersion + 1,
    });
  });
});
