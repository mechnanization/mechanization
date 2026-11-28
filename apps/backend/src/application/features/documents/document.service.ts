import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Document, DocumentType } from '../../../domain/entities/document.entity';
import {
  DOCUMENT_REPOSITORY,
  IMAGE_STORAGE_SERVICE,
} from '../../../domain/interfaces/base-repository.interface';
import {
  DocumentRepository,
  StoredDocument,
} from '../../../domain/interfaces/document-repository.interface';
import { ImageStorageService } from '../../../domain/interfaces/image-storage-service.interface';
import { ValidationError } from '../../common/exceptions';
import { APP_CONFIG } from '../../common/app.config';

export interface IncomingFile {
  fieldName: string;
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
}

export interface DocumentSlot {
  field: string;
  type: DocumentType;
  propertyIndex?: number;
}

@Injectable()
export class DocumentService {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(IMAGE_STORAGE_SERVICE) private readonly storage: ImageStorageService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Uploads every file from one submission, then records them.
   *
   * Storage first, database second: an object with no row is orphaned bytes a
   * cleanup job can find, while a row pointing at an object that was never
   * written is a document that appears to exist and 404s during review.
   */
  async attachToRegistration(input: {
    tenantSlug: string;
    citizenId: string;
    registrationId: string;
    propertyIds: string[];
    slots: DocumentSlot[];
    files: IncomingFile[];
  }): Promise<{ documentIds: string[] }> {
    if (input.files.length > APP_CONFIG.documents.maxFilesPerSubmission) {
      throw new ValidationError({
        code: 'DOCUMENT_TOO_MANY_FILES',
        message: 'Too many files in one request',
      });
    }

    // Validate everything before writing anything: a rejected 12th file should
    // not leave eleven uploads behind.
    for (const file of input.files) {
      Document.assertUploadable(file.mimeType, file.size);
    }

    const slotByField = new Map(input.slots.map((slot) => [slot.field, slot]));
    const entities: Document[] = [];

    for (const file of input.files) {
      const slot = slotByField.get(file.fieldName);
      if (!slot) {
        throw new ValidationError({
          code: 'DOCUMENT_UNEXPECTED_FILE',
          message: `Unexpected file field ${file.fieldName}`,
          params: { field: file.fieldName },
        });
      }

      const propertyEntryId =
        slot.propertyIndex === undefined ? null : input.propertyIds[slot.propertyIndex];

      if (slot.propertyIndex !== undefined && !propertyEntryId) {
        throw new ValidationError({
          code: 'DOCUMENT_PROPERTY_NOT_IN_REQUEST',
          message: `File ${file.fieldName} names a property not in the request`,
          params: { field: file.fieldName },
        });
      }

      const { storagePath } = await this.storage.upload({
        tenantSlug: input.tenantSlug,
        citizenId: input.citizenId,
        registrationId: input.registrationId,
        propertyEntryId,
        fileName: file.originalName,
        mimeType: file.mimeType,
        content: file.buffer,
      });

      entities.push(
        Document.create({
          id: 'pending',
          registrationId: input.registrationId,
          propertyEntryId,
          type: slot.type,
          storagePath,
          mimeType: file.mimeType,
          sizeBytes: file.size,
        }),
      );
    }

    const documentIds = await this.documents.saveMany(entities);
    return { documentIds };
  }

  async listForRegistration(registrationId: string): Promise<StoredDocument[]> {
    return this.documents.listByRegistration(registrationId);
  }

  /**
   * Opening a citizen's document is itself a staff action worth recording — a
   * dashboard that logs status changes but not who read a scan of someone's ID
   * is only half an audit trail.
   */
  async createViewUrl(input: {
    tenantSlug: string;
    documentId: string;
    actor: { id: string; role: string; email?: string };
  }): Promise<{ url: string; expiresInSeconds: number }> {
    const document = await this.documents.findById(input.documentId);
    if (!document) {
      throw new ValidationError({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'The document was not found',
      });
    }

    const url = await this.storage.createSignedUrl(
      document.storagePath,
      APP_CONFIG.documents.signedUrlTtlSeconds,
    );

    this.events.emit('document.viewed', {
      tenantSlug: input.tenantSlug,
      documentId: document.id,
      documentType: document.type,
      actorId: input.actor.id,
      actorRole: input.actor.role,
      actorEmail: input.actor.email,
    });

    return { url, expiresInSeconds: APP_CONFIG.documents.signedUrlTtlSeconds };
  }
}
