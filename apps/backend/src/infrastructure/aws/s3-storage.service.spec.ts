import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../domain/errors/domain-error';
import type { UploadRequest } from '../../domain/interfaces/image-storage-service.interface';

/**
 * What these tests are really guarding is the object key.
 *
 * The documents in this bucket were migrated out of Supabase Storage under keys
 * this adapter's `buildPath` produced, so key shape is a data contract, not an
 * implementation detail — a fifth segment or a `.JPG` left uppercased orphans
 * every scan already recorded in `documents.storage_path`, and nothing throws
 * to say so. The second thing being guarded is what the key must *not* contain:
 * the citizen's own filename ("بطاقة هوية.jpg" describes its contents and is a
 * traversal surface), and, in the error path, the key must not reach the
 * browser at all — it carries the citizen id.
 *
 * Two further things are guarded here because the service was reshaped to hold
 * them:
 *
 * - **Constructing is always safe.** This provider is bound in a `@Global`
 *   module, so Nest builds it during bootstrap in every environment. If the
 *   constructor demanded AWS configuration, the way to make `pnpm dev` boot on a
 *   developer machine would be to fill the variables in — and `apps/backend/.env`
 *   is pinned to staging while only *production's* documents were migrated into
 *   S3, so the only values that work are the production bucket's. That is
 *   AGENTS.md §8.5 with citizens' identity documents instead of rows. The
 *   configuration is therefore resolved lazily, and the first-use tests below
 *   check that the failure still arrives — naming the variable — the moment
 *   anything actually reaches for storage.
 * - **`createSignedUrl` can still fail.** Presigning is local arithmetic, so
 *   without the `HeadObject` round trip this method had no failure mode at all:
 *   a document whose key did not survive the migration returned a valid-looking
 *   URL that renders S3's XML error page, *after* DocumentService had already
 *   emitted the `document.viewed` audit event for a read that never happened.
 *
 * The AWS SDK is mocked wholesale. Nothing here reaches the network, which is
 * the point: these assertions are about the command we hand the SDK.
 */

const mockSend = jest.fn();
const mockGetSignedUrl = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  /** Stands in for the SDK command classes: keeps `input`, does nothing else. */
  class FakeCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }

  return {
    S3Client: jest.fn().mockImplementation((config: unknown) => ({
      // `config` is kept so the credentials/region tests can read what the
      // service asked for without a live client.
      config,
      send: (...args: unknown[]) => mockSend(...args),
    })),
    PutObjectCommand: class PutObjectCommand extends FakeCommand {},
    GetObjectCommand: class GetObjectCommand extends FakeCommand {},
    DeleteObjectCommand: class DeleteObjectCommand extends FakeCommand {},
    // The read path sends two different commands now; `send` has to be able to
    // tell them apart, and so do the assertions.
    HeadObjectCommand: class HeadObjectCommand extends FakeCommand {},
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => mockGetSignedUrl(...args),
}));

// `jest.mock` is hoisted above these requires, so the service and the command
// classes below are the fakes, not the SDK.
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3StorageService } from './s3-storage.service';

const ENV = {
  AWS_REGION: 'eu-west-3',
  S3_DOCUMENTS_BUCKET: 'municipality-documents-private',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'secret-example',
};

/** Stands in for Nest's ConfigService — only `get` and `getOrThrow` are used. */
function configWith(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`Configuration key "${key}" does not exist`);
      return value;
    },
  } as unknown as ConfigService;
}

const service = (overrides: Record<string, string> = {}) =>
  new S3StorageService(configWith({ ...ENV, ...overrides }));

const request = (overrides: Partial<UploadRequest> = {}): UploadRequest => ({
  tenantSlug: 'albazourieh',
  citizenId: 'citizen-1111',
  registrationId: 'registration-2222',
  propertyEntryId: null,
  fileName: 'scan.jpg',
  mimeType: 'image/jpeg',
  content: Buffer.from('not-really-a-jpeg'),
  ...overrides,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The command handed to `send` on the nth call (0-based). */
function sentCommand(index = 0): { input: Record<string, unknown> } {
  const call = mockSend.mock.calls[index];
  if (!call) throw new Error(`send() was not called ${index + 1} time(s)`);
  return call[0];
}

/** Returns the rejection rather than letting a resolved promise pass silently. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** An SDK failure as the client-s3 rejects it: name is the wire error code. */
function s3Error(name: string, message: string, httpStatusCode: number): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode } });
}

/** The options the adapter handed the S3Client constructor, on the nth build. */
function clientOptions(index = 0): Record<string, unknown> {
  const call = (S3Client as unknown as jest.Mock).mock.calls[index];
  if (!call) throw new Error(`S3Client was not constructed ${index + 1} time(s)`);
  return call[0];
}

/**
 * Nothing is read from config until something asks for storage, so every
 * assertion about region, bucket or credentials has to provoke a first use.
 * `remove` is the cheapest provocation: it swallows whatever S3 does, so the
 * client is built and the connection resolved without the test having to stage
 * a successful round trip.
 */
async function afterFirstUse(overrides: Record<string, string> = {}): Promise<void> {
  await service(overrides).remove('albazourieh/citizen-1111/reg/abc.jpg');
}

let loggedErrors: string[];

beforeEach(() => {
  jest.clearAllMocks();
  // `clearAllMocks` forgets calls but keeps implementations, and these two are
  // shared across every describe below — a `mockResolvedValue` set for an upload
  // test would otherwise still be answering in a signing test.
  mockSend.mockReset();
  mockGetSignedUrl.mockReset();
  loggedErrors = [];
  jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
    loggedErrors.push(String(message));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('S3StorageService construction', () => {
  /**
   * The reason the whole class was reshaped, stated as an assertion.
   *
   * This provider is bound in a `@Global` module: Nest constructs it at boot in
   * every environment, including the developer machines that must never hold a
   * credential for the production documents bucket. A constructor that demanded
   * AWS variables would take the API down at boot everywhere they are absent,
   * and the obvious fix — filling them in locally — means pointing `pnpm dev`
   * at production's objects, because that is the only place the migrated scans
   * exist. Booting is therefore unconditional; the cost is paid at first use.
   */
  it('constructs with no AWS configuration at all, because bootstrap must not need any', () => {
    expect(() => new S3StorageService(configWith({}))).not.toThrow();

    // And builds nothing: no client, so no credential resolution, no endpoint,
    // nothing that could reach an account this machine should not touch.
    expect(S3Client as unknown as jest.Mock).not.toHaveBeenCalled();
  });

  it('reads nothing from config until something actually needs storage', async () => {
    const read: string[] = [];
    const record = (key: string) => {
      read.push(key);
      return (ENV as Record<string, string>)[key];
    };
    // Both accessors are counted, so the old shape — a constructor calling
    // `getOrThrow('AWS_REGION')` — fails this by name rather than by TypeError.
    const counting = { get: record, getOrThrow: record } as unknown as ConfigService;

    const subject = new S3StorageService(counting);

    expect(read).toEqual([]);

    // ...and the very same instance reads it once something asks for storage,
    // which is what keeps this from passing for a service that reads nothing.
    mockSend.mockResolvedValue({});
    await subject.remove('albazourieh/citizen-1111/reg/abc.jpg');

    expect(read).toContain('AWS_REGION');
    expect(read).toContain('S3_DOCUMENTS_BUCKET');
  });

  it('takes region and bucket from config rather than a constant', async () => {
    await afterFirstUse();

    expect(clientOptions().region).toBe('eu-west-3');
    expect(sentCommand().input.Bucket).toBe('municipality-documents-private');
  });

  /**
   * The same two values again, with nothing a hard-coded fallback could be
   * mistaken for: if either were a literal in the adapter, one of these fails.
   */
  it('follows config when the region and bucket are not the usual ones', async () => {
    await afterFirstUse({ AWS_REGION: 'me-south-1', S3_DOCUMENTS_BUCKET: 'some-other-bucket' });

    expect(clientOptions().region).toBe('me-south-1');
    expect(sentCommand().input.Bucket).toBe('some-other-bucket');
  });

  it('passes explicit credentials when both halves are configured', async () => {
    await afterFirstUse();

    // `toStrictEqual`, not `toEqual`, and the difference is the whole assertion:
    // `toEqual` ignores keys whose value is `undefined`, so it would pass just
    // as happily against `{ accessKeyId, secretAccessKey, sessionToken: undefined }`
    // — the exact half-filled shape the comment below claims is avoided. The
    // `in` check says it a second way, because a signer handed an explicit
    // `undefined` does not behave like one handed nothing.
    expect(clientOptions().credentials).toStrictEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example',
    });
    expect('sessionToken' in (clientOptions().credentials as object)).toBe(false);
  });

  /**
   * Temporary credentials (SSO, an assumed role, anything out of STS) always
   * arrive as a triple. Signing with two thirds of one produces requests without
   * `x-amz-security-token`, which S3 rejects as InvalidAccessKeyId — an error
   * that sends whoever reads it looking at the wrong variable.
   */
  it('carries the session token when one is configured alongside both halves', async () => {
    await afterFirstUse({ AWS_SESSION_TOKEN: 'FwoGZXIvYXdzEXAMPLE' });

    expect(clientOptions().credentials).toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example',
      sessionToken: 'FwoGZXIvYXdzEXAMPLE',
    });
  });

  /**
   * A session token on its own is not a credential. Letting it conjure a
   * `credentials` object would hand the SDK a half-filled one and switch off the
   * provider chain, which is the only way an instance role is ever reached.
   */
  it('ignores a session token with no key to go with it', async () => {
    await afterFirstUse({
      AWS_ACCESS_KEY_ID: '',
      AWS_SECRET_ACCESS_KEY: '',
      AWS_SESSION_TOKEN: 'FwoGZXIvYXdzEXAMPLE',
    });

    expect('credentials' in clientOptions()).toBe(false);
  });

  /**
   * The key must be *absent*, not undefined: `credentials: undefined` is enough
   * for the SDK to skip its default provider chain in some versions, and the
   * chain is how the instance role and ~/.aws/credentials are reached.
   */
  it.each([
    ['only the access key id', { AWS_SECRET_ACCESS_KEY: '' }],
    ['only the secret', { AWS_ACCESS_KEY_ID: '' }],
    ['neither', { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' }],
  ])('omits credentials entirely when config has %s', async (_label, overrides) => {
    await afterFirstUse(overrides);

    expect('credentials' in clientOptions()).toBe(false);
  });

  /**
   * Resolved once and kept. Not a performance point: a second resolution would
   * mean a second `S3Client`, and a client is where the SDK caches the resolved
   * credential, so re-resolving per call would re-run the provider chain — and
   * on a box with an instance role, hit IMDS — on every document a counter
   * clerk opens.
   */
  it('resolves the connection once and reuses it across calls', async () => {
    mockSend.mockResolvedValue({});
    mockGetSignedUrl.mockResolvedValue('https://signed.example.invalid');
    const subject = service();

    await subject.upload(request());
    await subject.createSignedUrl('albazourieh/citizen-1111/reg/abc.jpg', 60);
    await subject.remove('albazourieh/citizen-1111/reg/abc.jpg');

    expect((S3Client as unknown as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('gives each instance its own connection rather than sharing one', async () => {
    await afterFirstUse();
    await afterFirstUse({ S3_DOCUMENTS_BUCKET: 'a-different-bucket' });

    expect(sentCommand(0).input.Bucket).toBe('municipality-documents-private');
    expect(sentCommand(1).input.Bucket).toBe('a-different-bucket');
  });
});

describe('S3StorageService first use without configuration', () => {
  /**
   * Boot no longer fails, so this is where the misconfiguration has to become
   * visible — and it has to name the variable. `ConfigService.getOrThrow` names
   * its container instead ("Configuration key ... does not exist"), which is why
   * the helper throws its own.
   *
   * `createSignedUrl` resolves the connection *outside* its try/catch, so the
   * naming error reaches the caller intact.
   */
  it.each([
    ['a region', { AWS_REGION: '' }, /AWS_REGION/],
    ['a bucket', { S3_DOCUMENTS_BUCKET: '' }, /S3_DOCUMENTS_BUCKET/],
  ])('refuses to read a document without %s, naming the variable', async (_l, overrides, named) => {
    const error = await rejection(service(overrides).createSignedUrl('a/b/c.jpg', 60));

    expect(error.message).toMatch(named);
    // Not a ValidationError: this is not something the officer at the counter
    // did wrong, and it must not be rendered to them as though it were.
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect((S3Client as unknown as jest.Mock)).not.toHaveBeenCalled();
  });

  /**
   * The Supabase adapter defaulted to a bucket named 'documents'. This one must
   * not: a plausible bucket name in S3 may well exist and belong to something
   * else, and a citizen's ID scan landing in it is not an outcome that should be
   * reachable by omitting a variable.
   */
  it('has no default bucket to fall back on', async () => {
    const error = await rejection(
      new S3StorageService(configWith({ AWS_REGION: 'eu-west-3' })).createSignedUrl('a/b.jpg', 60),
    );

    expect(error.message).toMatch(/S3_DOCUMENTS_BUCKET/);
    expect(error.message).not.toMatch(/documents'/);
  });

  it('names the variable when the whole AWS section is missing', async () => {
    const error = await rejection(
      new S3StorageService(configWith({})).createSignedUrl('a/b.jpg', 60),
    );

    expect(error.message).toMatch(/AWS_REGION/);
    // The message is read off a server by whoever has to fix it, so it says
    // where the file is rather than only what is wrong with it.
    expect(error.message).toMatch(/\.env/);
  });

  /**
   * `upload` resolves the connection *inside* its try, so a missing variable
   * arrives at the counter as the same opaque Arabic refusal as any other upload
   * failure. That is the right thing to show a citizen — but it means the only
   * record of *which* variable is the log line, so that is asserted here rather
   * than assumed.
   */
  it('fails an upload opaquely but logs which variable is missing', async () => {
    const error = await rejection(service({ AWS_REGION: '' }).upload(request()));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('تعذّر رفع الملف — يرجى المحاولة مرة أخرى');
    expect(error.message).not.toMatch(/AWS_REGION/);
    expect(loggedErrors.join('\n')).toMatch(/AWS_REGION/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  /**
   * `remove` swallows everything by contract (the row is already gone; throwing
   * would turn a finished operation into a user-visible failure). A missing
   * variable is swallowed with it — so the log line is the only signal, and an
   * unconfigured delete leaves the object behind. Worth knowing, not worth
   * changing the contract for.
   */
  it('swallows a misconfigured delete but leaves the variable in the log', async () => {
    await expect(
      service({ S3_DOCUMENTS_BUCKET: '' }).remove('albazourieh/citizen-1111/x.jpg'),
    ).resolves.toBeUndefined();

    expect(loggedErrors.join('\n')).toMatch(/S3_DOCUMENTS_BUCKET/);
    expect(loggedErrors.join('\n')).toContain('albazourieh/citizen-1111/x.jpg');
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('S3StorageService key shape', () => {
  beforeEach(() => mockSend.mockResolvedValue({}));

  it('leads with the tenant slug, then citizen, registration, generated name', async () => {
    const { storagePath } = await service().upload(request());
    const segments = storagePath.split('/');

    expect(segments).toHaveLength(4);
    expect(segments[0]).toBe('albazourieh');
    expect(segments[1]).toBe('citizen-1111');
    expect(segments[2]).toBe('registration-2222');
    expect(segments[3]).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(segments[3]!.slice(0, 36)).toMatch(UUID);
  });

  it('inserts the property entry as a fourth segment when the document has one', async () => {
    const { storagePath } = await service().upload(
      request({ propertyEntryId: 'property-3333' }),
    );
    const segments = storagePath.split('/');

    expect(segments).toHaveLength(5);
    expect(segments.slice(0, 4)).toEqual([
      'albazourieh',
      'citizen-1111',
      'registration-2222',
      'property-3333',
    ]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('omits the property segment when it is %s', async (_label, propertyEntryId) => {
    const { storagePath } = await service().upload(request({ propertyEntryId }));

    expect(storagePath.split('/')).toHaveLength(4);
  });

  it.each([
    ['scan.jpg', '.jpg'],
    ['SCAN.JPEG', '.jpeg'],
    ['Scan.PnG', '.png'],
    ['archive.tar.gz', '.gz'],
  ])('lowercases the extension of %s', async (fileName, expected) => {
    const { storagePath } = await service().upload(request({ fileName }));

    expect(storagePath.endsWith(expected)).toBe(true);
  });

  it.each([
    ['no extension at all', 'scan'],
    ['a dotfile, which node reports as extensionless', '.jpg'],
    ['an empty filename', ''],
  ])("falls back to '.bin' for %s", async (_label, fileName) => {
    const { storagePath } = await service().upload(request({ fileName }));

    expect(storagePath.endsWith('.bin')).toBe(true);
  });

  /**
   * The cap is what stops an attacker-supplied "extension" from becoming the
   * key: `fileName` arrives from multipart form data and is not otherwise
   * bounded.
   */
  it('truncates a long extension instead of copying it into the key', async () => {
    const { storagePath } = await service().upload(
      request({ fileName: `x.${'a'.repeat(4000)}` }),
    );
    const name = storagePath.split('/')[3]!;

    expect(name).toHaveLength(36 + 10);
    expect(name.slice(36)).toBe(`.${'a'.repeat(9)}`);
  });

  /**
   * Byte-for-byte parity with the Supabase adapter, trailing dot and all. This
   * is not a good key; it is the key the migrated objects would already have,
   * and parity is the whole point of copying `buildPath` verbatim.
   */
  it("keeps the Supabase adapter's handling of a trailing dot", async () => {
    const { storagePath } = await service().upload(request({ fileName: 'photo.' }));

    expect(storagePath.endsWith('.')).toBe(true);
  });

  it('leaves no trace of the citizen’s filename in the key', async () => {
    const { storagePath } = await service().upload(
      request({ fileName: 'بطاقة هوية.jpg', propertyEntryId: 'property-3333' }),
    );

    // Not a single Arabic codepoint survives: the filename described the
    // contents, and an object key is read by anyone who can list the bucket.
    expect(storagePath).not.toMatch(/[؀-ۿ]/);
    expect(storagePath).not.toContain('هوية');
    expect(storagePath.endsWith('.jpg')).toBe(true);
    expect(storagePath.split('/')).toHaveLength(5);
  });

  it('cannot be walked out of its tenant prefix by a crafted filename', async () => {
    const { storagePath } = await service().upload(
      request({ fileName: '../../../etc/passwd.png' }),
    );

    expect(storagePath).not.toContain('..');
    expect(storagePath).not.toContain('passwd');
    expect(storagePath.startsWith('albazourieh/')).toBe(true);
    expect(storagePath.split('/')).toHaveLength(4);
  });

  it('mints a distinct key per upload, so two files never share one', async () => {
    const subject = service();
    const first = await subject.upload(request());
    const second = await subject.upload(request());

    expect(first.storagePath).not.toBe(second.storagePath);
  });
});

describe('S3StorageService.upload', () => {
  it('sends the object to the configured bucket at the key it built', async () => {
    mockSend.mockResolvedValue({});
    const content = Buffer.from('bytes');

    const { storagePath } = await service().upload(request({ content }));
    const command = sentCommand();

    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input.Bucket).toBe('municipality-documents-private');
    expect(command.input.Key).toBe(storagePath);
    expect(command.input.Body).toBe(content);
    expect(command.input.ContentType).toBe('image/jpeg');
  });

  /**
   * The single most important assertion in this file. Without `IfNoneMatch`,
   * PutObject overwrites an existing key silently and answers 200 — one
   * citizen's identity document replaced by another's, with no error anywhere
   * and a `documents` row still pointing confidently at the key.
   */
  it("refuses to overwrite by sending IfNoneMatch '*'", async () => {
    mockSend.mockResolvedValue({});

    await service().upload(request());

    expect(sentCommand().input.IfNoneMatch).toBe('*');
  });

  it('does not make the object public', async () => {
    mockSend.mockResolvedValue({});

    await service().upload(request());

    expect(sentCommand().input.ACL).toBeUndefined();
  });

  it('surfaces a 412 PreconditionFailed as the Arabic validation error', async () => {
    mockSend.mockRejectedValue(
      s3Error(
        'PreconditionFailed',
        'At least one of the pre-conditions you specified did not hold',
        412,
      ),
    );

    const error = await rejection(service().upload(request()));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('تعذّر رفع الملف — يرجى المحاولة مرة أخرى');
    expect((error as ValidationError).code).toBe('VALIDATION_FAILED');
  });

  it.each([
    ['AccessDenied', 403],
    ['NoSuchBucket', 404],
    ['InternalError', 500],
  ])('surfaces a %s the same way, revealing nothing about the cause', async (name, status) => {
    mockSend.mockRejectedValue(s3Error(name, `${name} happened`, status));

    const error = await rejection(service().upload(request()));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('تعذّر رفع الملف — يرجى المحاولة مرة أخرى');
  });

  /**
   * The key holds the citizen id and the registration id and this message is
   * rendered in a browser, so the diagnostic detail belongs in the log and
   * nowhere else. `details` is checked too: ValidationError carries it to the
   * client, so an SDK error parked there would ship the key just as surely.
   */
  it('keeps the key, the ids and the filename out of the thrown error', async () => {
    mockSend.mockRejectedValue(s3Error('PreconditionFailed', 'precondition', 412));

    const error = await rejection(
      service().upload(request({ fileName: 'بطاقة هوية.jpg', propertyEntryId: 'property-3333' })),
    );
    const key = sentCommand().input.Key as string;

    expect(error.message).not.toContain(key);
    expect(error.message).not.toContain('citizen-1111');
    expect(error.message).not.toContain('registration-2222');
    expect(error.message).not.toContain('property-3333');
    expect(error.message).not.toContain('albazourieh');
    expect(error.message).not.toContain('هوية');
    expect((error as ValidationError).details).toBeUndefined();
    expect(error.stack ?? '').not.toContain(key);

    // The log is where it does belong — an operator cannot chase a 412 without
    // the key that collided.
    expect(loggedErrors.join('\n')).toContain(key);
  });
});

describe('S3StorageService.createSignedUrl', () => {
  /**
   * `send` now has to answer more than one command, and answering anything
   * *other* than HeadObject would be a bug worth failing on rather than
   * absorbing — a GetObject actually issued here would pull a citizen's scan
   * through the API process instead of leaving it to the signed URL.
   */
  beforeEach(() => {
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({ ContentLength: 4096, ContentType: 'image/jpeg' });
      }
      return Promise.reject(
        new Error(`createSignedUrl sent an unexpected ${(command as object)?.constructor?.name}`),
      );
    });
  });

  it('signs a GET against the configured bucket and passes the lifetime through', async () => {
    mockGetSignedUrl.mockResolvedValue('https://s3.eu-west-3.amazonaws.com/signed');

    const url = await service().createSignedUrl('albazourieh/citizen-1111/reg/abc.jpg', 120);
    const [client, command, options] = mockGetSignedUrl.mock.calls[0];

    expect(url).toBe('https://s3.eu-west-3.amazonaws.com/signed');
    // Identity, not mere existence. A presigned URL takes its region and its
    // credentials from the *client*; the command carries only Bucket and Key.
    // So handing the presigner some other client — this repo now builds two,
    // one per bucket — would sign with the wrong identity while every other
    // assertion here still passed, and the HeadObject check above would not
    // notice either: it goes through the correct client, finds the object, and
    // `document.viewed` is written for a URL S3 will refuse.
    expect((S3Client as unknown as jest.Mock).mock.results).toHaveLength(1);
    expect(client).toBe((S3Client as unknown as jest.Mock).mock.results[0].value);
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'municipality-documents-private',
      Key: 'albazourieh/citizen-1111/reg/abc.jpg',
    });
    expect(options).toEqual({ expiresIn: 120 });
  });

  it('checks the object exists, against the same bucket and key it will sign', async () => {
    mockGetSignedUrl.mockResolvedValue('https://signed.example.invalid');

    await service().createSignedUrl('albazourieh/citizen-1111/reg/abc.jpg', 120);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(sentCommand()).toBeInstanceOf(HeadObjectCommand);
    expect(sentCommand().input).toEqual({
      Bucket: 'municipality-documents-private',
      Key: 'albazourieh/citizen-1111/reg/abc.jpg',
    });
  });

  /**
   * The order is the point, not an incidental. A URL minted first and validated
   * afterwards is still a URL that was minted.
   */
  it('checks before it signs, not after', async () => {
    let signaturesAtHeadTime = -1;
    mockSend.mockImplementation(() => {
      signaturesAtHeadTime = mockGetSignedUrl.mock.calls.length;
      return Promise.resolve({});
    });
    mockGetSignedUrl.mockResolvedValue('https://signed.example.invalid');

    await service().createSignedUrl('a/b/c.jpg', 60);

    expect(signaturesAtHeadTime).toBe(0);
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1);
  });

  /**
   * The lifetime is the whole control: a link to a scan of someone's national
   * ID that outlives the visit is a leak nobody can withdraw. Whatever the
   * caller asks for must reach the presigner unmodified — no clamp, no default
   * quietly substituted.
   */
  it.each([30, 60, 300, 3600])('passes expiresIn %i through unchanged', async (expiresIn) => {
    mockGetSignedUrl.mockResolvedValue('https://signed.example.invalid');

    await service().createSignedUrl('a/b/c.jpg', expiresIn);

    expect(mockGetSignedUrl.mock.calls[0][2]).toEqual({ expiresIn });
  });

  /**
   * The assertion the HeadObject exists for.
   *
   * Presigning never touches the network, so before the head request this method
   * could not fail: a document whose key did not survive the migration out of
   * Supabase got a perfectly valid signature over a key holding nothing, and the
   * officer saw S3's XML error page — by which point DocumentService had already
   * written a `document.viewed` audit entry for a read that never happened. An
   * audit log that records reads which did not occur is worse than no audit log,
   * because it will be believed. `getSignedUrl` not being called at all is what
   * proves the failure now arrives before the caller can act on it.
   */
  it('refuses to sign a URL for an object that is not there', async () => {
    mockSend.mockRejectedValue(s3Error('NotFound', 'Not Found', 404));
    mockGetSignedUrl.mockResolvedValue('https://signed.example.invalid');

    const error = await rejection(
      service().createSignedUrl('albazourieh/citizen-1111/reg/missing.jpg', 60),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('تعذّر فتح الملف');
    expect((error as ValidationError).code).toBe('VALIDATION_FAILED');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();

    // The key is the only way to tell a botched migration from a deleted
    // document, so it goes to the log — and, as everywhere else here, nowhere
    // near the message.
    expect(loggedErrors.join('\n')).toContain('albazourieh/citizen-1111/reg/missing.jpg');
    expect(loggedErrors.join('\n')).toContain('NotFound');
    expect(error.message).not.toContain('citizen-1111');
  });

  /**
   * A 403 on the head request means the credentials or the bucket policy are
   * wrong, not that the document is missing — but the officer is told the same
   * thing either way, and nothing about the account leaks into the browser.
   */
  it.each([
    ['AccessDenied', 403],
    ['NoSuchBucket', 404],
    ['InternalError', 500],
  ])('treats a %s on the check as a refusal to open', async (name, status) => {
    mockSend.mockRejectedValue(s3Error(name, `${name} happened`, status));

    const error = await rejection(service().createSignedUrl('albazourieh/citizen-1111/x.jpg', 60));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('تعذّر فتح الملف');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
    expect(loggedErrors.join('\n')).toContain(name);
  });

  it('turns a signing failure into the Arabic validation error', async () => {
    mockGetSignedUrl.mockRejectedValue(new Error('Could not load credentials from any providers'));

    const error = await rejection(service().createSignedUrl('albazourieh/citizen-1111/x.jpg', 60));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('تعذّر فتح الملف');
    expect(error.message).not.toContain('citizen-1111');
    expect(loggedErrors.join('\n')).toContain('albazourieh/citizen-1111/x.jpg');
  });
});

describe('S3StorageService.remove', () => {
  it('deletes the key from the configured bucket', async () => {
    mockSend.mockResolvedValue({});

    await service().remove('albazourieh/citizen-1111/reg/abc.jpg');
    const command = sentCommand();

    expect(command).toBeInstanceOf(DeleteObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'municipality-documents-private',
      Key: 'albazourieh/citizen-1111/reg/abc.jpg',
    });
  });

  /**
   * Swallowing is the contract the port was written to. The row this object
   * belonged to is already gone by the time we get here; a rejection would turn
   * a completed deletion into a user-visible failure and invite a retry of work
   * that has already happened. The log line is the compensating control.
   */
  it('logs and resolves when S3 refuses the delete', async () => {
    mockSend.mockRejectedValue(s3Error('AccessDenied', 'Access Denied', 403));

    await expect(service().remove('albazourieh/citizen-1111/reg/abc.jpg')).resolves.toBeUndefined();
    expect(loggedErrors.join('\n')).toContain('albazourieh/citizen-1111/reg/abc.jpg');
    expect(loggedErrors.join('\n')).toContain('AccessDenied');
  });
});
