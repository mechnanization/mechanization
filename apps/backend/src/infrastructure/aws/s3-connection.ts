import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';

/** An S3 client and the single bucket one adapter is allowed to touch. */
export interface S3Connection {
  client: S3Client;
  bucket: string;
}

/**
 * Resolves the AWS configuration for one adapter.
 *
 * Deliberately **not** called from a constructor. Both storage ports are bound
 * in a `@Global` module, so Nest builds them during bootstrap whether or not
 * anything in this process will ever store a document — and a throw there takes
 * the whole API down with a message from inside the DI container rather than
 * one naming a variable.
 *
 * That matters more here than the usual "fail at boot" preference, because the
 * environment that lacks these variables is a developer's. `apps/backend/.env`
 * is pinned to **staging**, and only production's objects were migrated into
 * S3 — so the way to make `pnpm dev` boot again by filling in the blanks would
 * be to point a developer's machine at the *production* buckets, which is the
 * §8.5 failure mode with citizens' identity documents instead of rows. Booting
 * without AWS configuration and failing the first request that actually needs a
 * document is the safer shape: nobody can reach a production object by
 * accident, and nobody has to hold a credential to run the app.
 *
 * Production is still guarded at boot — `envSchema`'s production `superRefine`
 * demands all three names before a single provider is constructed, and lists
 * every missing one at once.
 */
export function createS3Connection(config: ConfigService, bucketVariable: string): S3Connection {
  const region = requireVariable(config, 'AWS_REGION');
  // No default bucket name, unlike the Supabase adapter's 'documents'. A wrong
  // bucket name there simply did not exist; in S3 a plausible name may well
  // exist and belong to someone else, and writing a citizen's ID scan into it
  // is not an outcome reachable by omission.
  const bucket = requireVariable(config, bucketVariable);

  const accessKeyId = config.get<string>('AWS_ACCESS_KEY_ID');
  const secretAccessKey = config.get<string>('AWS_SECRET_ACCESS_KEY');
  // Only meaningful for temporary credentials (SSO, an assumed role, anything
  // from STS), which always arrive as a triple. Dropping it while keeping the
  // other two produces requests signed without `x-amz-security-token`, which S3
  // rejects as InvalidAccessKeyId — an error that points at the wrong variable.
  const sessionToken = config.get<string>('AWS_SESSION_TOKEN');

  return {
    bucket,
    client: new S3Client({
      region,
      // `credentials` is spread in only when both halves are present, and is
      // otherwise absent from the object rather than set to `undefined`: that
      // is what lets the SDK's default provider chain run. The box this deploys
      // to also carries ~/.aws/credentials from `aws configure`, and an instance
      // role is where this is meant to end up — both are reachable only if the
      // key is missing. Handing the SDK a half-filled credentials object instead
      // would disable the chain and fail at the first request with a signature
      // error that says nothing about the unset variable.
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } }
        : {}),
    }),
  };
}

/**
 * `ConfigService.getOrThrow` would do, except that its message names the
 * container rather than the variable. This one is read by whoever is looking at
 * a failed upload in a log, so it says which name to set and where.
 */
function requireVariable(config: ConfigService, name: string): string {
  const value = config.get<string>(name);

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `${name} is not set — S3 storage cannot be used. Set it in the backend's .env ` +
        `(on the server: /var/www/municipality-app-releases/shared/backend/.env), one variable per line.`,
    );
  }

  return value;
}
