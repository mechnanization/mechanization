import { Injectable } from '@nestjs/common';
import { Document, DocumentType } from '../../domain/entities/document.entity';
import {
  DocumentRepository,
  StoredDocument,
} from '../../domain/interfaces/document-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';
import { runInTenantTransaction } from '../context/tenant-transaction';

@Injectable()
export class PrismaDocumentRepository implements DocumentRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  async saveMany(documents: Document[]): Promise<string[]> {
    if (documents.length === 0) return [];

    // All or none, joining the caller's transaction when there is one.
    return runInTenantTransaction(this.tenantContext, async () => {
      const ids: string[] = [];
      for (const doc of documents) {
        const row = await this.db.document.create({
          data: {
            registrationId: doc.props.registrationId,
            propertyEntryId: doc.props.propertyEntryId ?? null,
            type: doc.props.type as never,
            storagePath: doc.props.storagePath,
            mimeType: doc.props.mimeType,
            sizeBytes: doc.props.sizeBytes,
          },
          select: { id: true },
        });
        ids.push(row.id);
      }
      return ids;
    });
  }

  async listByRegistration(registrationId: string): Promise<StoredDocument[]> {
    const rows = await this.db.document.findMany({
      where: { registrationId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      type: row.type as DocumentType,
      storagePath: row.storagePath,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      propertyEntryId: row.propertyEntryId,
      createdAt: row.createdAt,
    }));
  }

  async findById(id: string): Promise<StoredDocument | null> {
    const row = await this.db.document.findUnique({ where: { id } });
    if (!row) return null;

    return {
      id: row.id,
      type: row.type as DocumentType,
      storagePath: row.storagePath,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      propertyEntryId: row.propertyEntryId,
      createdAt: row.createdAt,
    };
  }
}
