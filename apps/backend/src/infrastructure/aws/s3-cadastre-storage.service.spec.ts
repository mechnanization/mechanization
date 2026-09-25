import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { S3CadastreStorageService } from './s3-cadastre-storage.service';

/**
 * Three properties carry this adapter, and none of them is visible from the
 * happy path.
 *
 * The first is the object key. The cadastre layers were copied into S3 at the
 * keys Supabase used, so `{tenantSlug}/{assetName}` is an address, not a
 * convention — a change to it does not throw, it makes a municipality's map
 * come up blank as though nothing had ever been imported.
 *
 * The second is what `read` does with a failure. It returns null either way,
 * because its callers only handle null, so the *log* is the only thing left
 * separating "this municipality has no cadastre" from "S3 was unreachable for
 * ninety seconds". These tests assert the logging, not only the return value.
 *
 * The third is *when* configuration is read. This adapter is bound in a
 * `@Global` module, so Nest builds it during bootstrap on every machine — and a
 * developer's `apps/backend/.env` is pinned to a local database while only
 * production's objects were migrated into S3. An adapter that demanded AWS variables in its
 * constructor would be asking developers to point `pnpm dev` at the production
 * buckets in order to boot. So construction must stay silent, and the
 * complaint — naming the variable — must arrive on the first call that actually
 * needs the bucket.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  /** Records its input the way the real commands do, so `send` can be read. */
  class FakeCommand {
    constructor(public readonly input: Record<string, unknown>) {}
  }

  return {
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    PutObjectCommand: class PutObjectCommand extends FakeCommand {},
    GetObjectCommand: class GetObjectCommand extends FakeCommand {},
  };
});

/** The mocked constructor, so tests can ask whether a client was built at all. */
const S3ClientMock = S3Client as unknown as jest.Mock;

/**
 * Stands in for Nest's ConfigService.
 *
 * It offers `get` and nothing else, deliberately. The adapter must resolve its
 * variables through a check that names the missing one in a message an operator
 * can act on; a reversion to `getOrThrow` would fail here as a TypeError rather
 * than pass quietly with a message naming the DI container instead.
 */
function configWith(values: Record<string, string | undefined>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

const ENV: Record<string, string | undefined> = {
  AWS_REGION: 'eu-west-3',
  S3_CADASTRE_BUCKET: 'municipality-cadastre-test',
  AWS_ACCESS_KEY_ID: 'AKIA-TEST',
  AWS_SECRET_ACCESS_KEY: 'secret-test',
};

const service = (overrides: Record<string, string | undefined> = {}) =>
  new S3CadastreStorageService(configWith({ ...ENV, ...overrides }));

/** The command handed to `send`, and the S3 input it carries. */
const sentCommand = (index = 0) =>
  mockSend.mock.calls[index][0] as { input: Record<string, unknown> };

const sentInput = (index = 0) => sentCommand(index).input;

/** How the client config was built — asserts nothing was hardcoded. */
const clientConfig = (index = 0) =>
  S3ClientMock.mock.calls[index][0] as Record<string, unknown>;

const GEOJSON = '{"type":"FeatureCollection","features":[]}';

/**
 * Nothing is resolved in the constructor any more, so a question about the
 * client's configuration can only be answered after a call that needed one.
 * This drives the adapter exactly that far and hands back what the SDK was
 * constructed with.
 */
const clientConfigAfterFirstUse = async (
  overrides: Record<string, string | undefined> = {},
) => {
  mockSend.mockResolvedValue({});
  await service(overrides).upload('albazourieh', 'cadastre.geojson', GEOJSON);
  return clientConfig();
};

/** How the SDK hands back an object body. */
const bodyOf = (text: string) => ({ Body: { transformToString: async () => text } });

/** An SDK error: a name, and the `$metadata` every ServiceException carries. */
const s3Error = (name: string, httpStatusCode?: number) =>
  Object.assign(new Error(`simulated ${name}`), { name, $metadata: { httpStatusCode } });

/**
 * A throw from outside the SDK — a socket giving up, a wrapper that lost the
 * original — carrying the name every `Error` has and nothing more specific. For
 * these the status code is the only evidence there is.
 */
const genericError = (httpStatusCode?: number) =>
  Object.assign(new Error('simulated generic failure'), { $metadata: { httpStatusCode } });

let errorLog: jest.SpyInstance;

beforeEach(() => {
  // clearAllMocks, not resetAllMocks: a reset would wipe the S3Client factory
  // implementation, and every construction after it yields a client with no
  // `send` — a failure mode that reads like a bug in the adapter.
  jest.clearAllMocks();
  errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorLog.mockRestore();
});

describe('S3CadastreStorageService configuration', () => {
  /**
   * The boot path, asserted as a property rather than assumed. Nest constructs
   * this adapter in every environment because the module is `@Global`; if that
   * construction read configuration, the only way to start the API on a machine
   * without AWS variables would be to hand it credentials for the production
   * buckets. Nothing may be read, and no client may be built, until somebody
   * asks for an object.
   */
  it('constructs with no AWS configuration at all, so the API still boots', () => {
    expect(() => new S3CadastreStorageService(configWith({}))).not.toThrow();
    expect(S3ClientMock).not.toHaveBeenCalled();
  });

  it('takes region and bucket from configuration rather than a literal', async () => {
    mockSend.mockResolvedValue({});
    await service().upload('albazourieh', 'cadastre.geojson', GEOJSON);

    expect(clientConfig()).toMatchObject({ region: 'eu-west-3' });
    expect(sentInput().Bucket).toBe('municipality-cadastre-test');
  });

  /**
   * The bucket has no default, unlike the Supabase adapter this replaced: a
   * plausible S3 bucket name may well exist and belong to somebody else. The
   * refusal now lands on the first call instead of at construction, and it has
   * to say which variable is unset and where to set it — whoever reads it is
   * looking at a failed import on the server, not at this file.
   */
  it.each([
    ['AWS_REGION', undefined],
    ['S3_CADASTRE_BUCKET', undefined],
    // The empty string is not a lesser case of unset — it is what a variable
    // left as `S3_CADASTRE_BUCKET=` on the server actually produces, and a
    // guard that only checks `undefined` reads it as a configured bucket named
    // "". Every request then fails against the wrong name with no mention of
    // the variable.
    ['AWS_REGION', ''],
    ['S3_CADASTRE_BUCKET', '   '],
  ])(
    'refuses the first call that needs storage when %s is %p, instead of guessing one',
    async (missing, value) => {
      const attempt = service({ [missing]: value }).upload(
        'albazourieh',
        'cadastre.geojson',
        GEOJSON,
      );

      await expect(attempt).rejects.toThrow(new RegExp(`${missing} is not set`));
      await expect(attempt).rejects.toThrow(/\.env/);
      // Nothing reached S3, so there is no half-written object to reason about
      // afterwards.
      expect(mockSend).not.toHaveBeenCalled();
    },
  );

  /**
   * One client per adapter, not one per call. A client rebuilt on every upload
   * would leak its socket pool and re-resolve credentials each time, and the
   * leak would surface only under the load of a bulk parcel import.
   */
  it('builds its client once and reuses it across calls', async () => {
    mockSend.mockResolvedValue({});
    const storage = service();
    await storage.upload('albazourieh', 'cadastre.geojson', GEOJSON);
    await storage.upload('albazourieh', 'parcels.geojson', GEOJSON);

    expect(S3ClientMock).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('passes explicit credentials when both halves are configured', async () => {
    const config = await clientConfigAfterFirstUse();

    expect(config).toMatchObject({
      credentials: { accessKeyId: 'AKIA-TEST', secretAccessKey: 'secret-test' },
    });
    // And no session token unless one was configured. A permanent key signed
    // with an empty `x-amz-security-token` is rejected as InvalidAccessKeyId,
    // which sends the reader after the wrong variable.
    expect(config.credentials).not.toHaveProperty('sessionToken');
  });

  /**
   * Temporary credentials — SSO, an assumed role, anything from STS — arrive as
   * a triple and are only valid as one. Dropping the token while keeping the
   * other two signs requests without `x-amz-security-token`, and S3 answers
   * InvalidAccessKeyId: an error accusing the key of being wrong when it is
   * merely incomplete.
   */
  it('carries a session token through when the credentials are temporary', async () => {
    const config = await clientConfigAfterFirstUse({ AWS_SESSION_TOKEN: 'FwoGZXIvYXdzE-test' });

    expect(config).toMatchObject({
      credentials: {
        accessKeyId: 'AKIA-TEST',
        secretAccessKey: 'secret-test',
        sessionToken: 'FwoGZXIvYXdzE-test',
      },
    });
  });

  /**
   * Half a credential pair must not be forwarded: it replaces the default
   * provider chain rather than supplementing it, so a host that signs with an
   * attached instance role would start failing every request because one
   * variable was misspelled.
   */
  it.each([['AWS_ACCESS_KEY_ID'], ['AWS_SECRET_ACCESS_KEY']])(
    'omits credentials entirely when only %s is missing',
    async (missing) => {
      const config = await clientConfigAfterFirstUse({ [missing]: undefined });

      expect(config).not.toHaveProperty('credentials');
    },
  );
});

describe('S3CadastreStorageService.upload', () => {
  it('writes to {tenantSlug}/{assetName}, the key the copied layers live at', async () => {
    mockSend.mockResolvedValue({});
    await service().upload('albazourieh', 'cadastre.geojson', GEOJSON);

    expect(sentCommand()).toBeInstanceOf(PutObjectCommand);
    expect(sentInput().Key).toBe('albazourieh/cadastre.geojson');
    expect(sentInput().Body).toBe(GEOJSON);
  });

  it('keeps each municipality inside its own prefix', async () => {
    mockSend.mockResolvedValue({});
    const storage = service();
    await storage.upload('albazourieh', 'city-boundary.geojson', GEOJSON);
    await storage.upload('zahle', 'city-boundary.geojson', GEOJSON);

    expect(sentInput(0).Key).toBe('albazourieh/city-boundary.geojson');
    expect(sentInput(1).Key).toBe('zahle/city-boundary.geojson');
  });

  it('labels the object as GeoJSON', async () => {
    mockSend.mockResolvedValue({});
    await service().upload('albazourieh', 'parcels.geojson', GEOJSON);

    expect(sentInput().ContentType).toBe('application/geo+json');
  });

  /**
   * The asymmetry with the documents adapter, asserted rather than assumed: a
   * document must never be overwritten, a cadastre must be. If that adapter's
   * `IfNoneMatch: '*'` were ever copied over here, every municipality would be
   * frozen on its first import and the second one would fail with a
   * precondition error nobody could explain.
   */
  it('does not guard against overwriting, because a re-import is a correction', async () => {
    mockSend.mockResolvedValue({});
    await service().upload('albazourieh', 'cadastre.geojson', GEOJSON);

    expect(sentInput()).not.toHaveProperty('IfNoneMatch');
  });

  it('rethrows a failed write instead of reporting a silent success', async () => {
    mockSend.mockRejectedValue(s3Error('AccessDenied', 403));

    await expect(service().upload('albazourieh', 'cadastre.geojson', GEOJSON)).rejects.toThrow(
      /AccessDenied/,
    );
    // Pinned, not merely counted. A failed import is a staff action somebody is
    // watching, and this line is what tells them which municipality, which
    // layer and why — AccessDenied and NoSuchBucket are very different repairs.
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0][0])).toContain('albazourieh/cadastre.geojson');
    expect(String(errorLog.mock.calls[0][0])).toContain('AccessDenied');
  });
});

describe('S3CadastreStorageService.read', () => {
  it('reads from {tenantSlug}/{assetName} and returns the object text verbatim', async () => {
    mockSend.mockResolvedValue(bodyOf(GEOJSON));

    await expect(service().read('albazourieh', 'parcel-polygons.geojson')).resolves.toBe(GEOJSON);
    expect(sentCommand()).toBeInstanceOf(GetObjectCommand);
    expect(sentInput().Key).toBe('albazourieh/parcel-polygons.geojson');
    expect(sentInput().Bucket).toBe('municipality-cadastre-test');
  });

  /**
   * The ordinary state of a municipality that has not imported yet. It recurs
   * on every map load for that tenant, so it must not log — noise here is what
   * teaches people to scroll past the line that matters.
   *
   * The third case is the only one where a bare 404 decides anything: the error
   * carries no name worth reading, so the status is all there is to go on.
   */
  it.each([
    ['NoSuchKey on a GET', s3Error('NoSuchKey', 404)],
    ['NotFound with no status attached', s3Error('NotFound')],
    ['a 404 carried only in $metadata, on an error with no specific name', genericError(404)],
  ])('returns null without logging for %s', async (_label, error) => {
    mockSend.mockRejectedValue(error);

    await expect(service().read('albazourieh', 'cadastre.geojson')).resolves.toBeNull();
    expect(errorLog).not.toHaveBeenCalled();
  });

  /**
   * The distinction a status code cannot make, and the whole reason the name is
   * read first.
   *
   * `NoSuchBucket` is a 404 exactly as an absent object is. Judging by the
   * status would file a wrong or inaccessible `S3_CADASTRE_BUCKET` as "this
   * municipality has no cadastre" — for every tenant, on every map load,
   * without one line in the log to find it by. The return value is still null,
   * because callers of this port handle nothing else; the log is the entire
   * difference between a configuration mistake somebody can fix and a map that
   * is permanently, confidently blank.
   */
  it.each([
    ['NoSuchBucket', s3Error('NoSuchBucket', 404)],
    ['AccessDenied answered as a 404', s3Error('AccessDenied', 404)],
  ])('does not file %s as a missing layer, though it is a 404', async (_label, error) => {
    mockSend.mockRejectedValue(error);

    await expect(service().read('albazourieh', 'cadastre.geojson')).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0][0])).toContain('albazourieh/cadastre.geojson');
    expect(String(errorLog.mock.calls[0][0])).toContain((error as Error).message);
  });

  /**
   * The case the log exists for. Callers only handle null, so null it is — but
   * an outage returning null silently would present to every reader as a
   * municipality with no cadastre, which is a wrong map rather than a missing
   * one. The key is in the message so the log says which tenant and layer.
   */
  it('returns null for an unexpected failure, but logs it at error level', async () => {
    mockSend.mockRejectedValue(s3Error('ThrottlingException', 503));

    await expect(service().read('albazourieh', 'cadastre.geojson')).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0][0])).toContain('albazourieh/cadastre.geojson');
  });

  /**
   * Reading is where the deferred configuration check surfaces most quietly:
   * `read` swallows every throw, so an unset bucket comes back as null and the
   * map is simply empty. Null is the right return — nothing downstream handles
   * a throw — but it means the log line is the only evidence that the blankness
   * is an unset variable rather than a municipality that never imported. So it
   * has to name the variable.
   */
  it('logs the unset variable when a read is attempted without configuration', async () => {
    const storage = service({ S3_CADASTRE_BUCKET: undefined });

    await expect(storage.read('albazourieh', 'cadastre.geojson')).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(String(errorLog.mock.calls[0][0])).toContain('S3_CADASTRE_BUCKET');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null and logs when a success arrives with no body', async () => {
    mockSend.mockResolvedValue({});

    await expect(service().read('albazourieh', 'cadastre.geojson')).resolves.toBeNull();
    expect(errorLog).toHaveBeenCalledTimes(1);
    // The message is pinned because deleting the `!response.Body` guard
    // entirely still yields null and still logs once: `transformToString` would
    // throw a TypeError, the generic catch would swallow it, and the operator's
    // log would read "Cannot read properties of undefined" instead of a
    // statement about S3's response shape. Only the wording distinguishes the
    // deliberate branch from the accident.
    expect(String(errorLog.mock.calls[0][0])).toContain('no body');
    expect(String(errorLog.mock.calls[0][0])).toContain('albazourieh/cadastre.geojson');
  });
});
