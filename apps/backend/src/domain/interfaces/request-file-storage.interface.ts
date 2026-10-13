/**
 * Where the papers on a municipal request are kept (migration 0092): the
 * private documents bucket, under a key of their own. A port of its own rather
 * than a method on `ImageStorageService`, whose key shape is a frozen contract
 * with the objects migrated from Supabase and which needs a registration.
 */
export const REQUEST_FILE_STORAGE = Symbol('REQUEST_FILE_STORAGE');

export interface RequestFilePut {
  /** First in the key, so one municipality's objects never meet another's. */
  tenantSlug: string;
  requestId: string;
  /** Chosen from the sniffed bytes (`sniffAttachment`), never from a name the citizen typed. */
  extension: string;
  mimeType: string;
  content: Buffer;
}

export interface RequestFileStorage {
  /** Writes once: a key that already exists is refused, never overwritten. */
  put(file: RequestFilePut): Promise<{ storagePath: string }>;

  /** A URL that expires in minutes. The papers are never public. */
  createSignedUrl(storagePath: string, expiresInSeconds: number): Promise<string>;

  /** Best effort: undoes a write whose row could not be recorded. */
  remove(storagePath: string): Promise<void>;
}
