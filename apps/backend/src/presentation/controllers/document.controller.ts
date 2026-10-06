import { Controller, Get, Param } from '@nestjs/common';
import {
  WORKING_STAFF_ROLES,
} from '@mechanization/shared-schemas';
import { DocumentService } from '../../application/features/documents/document.service';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';

@Controller('t/:tenantSlug/documents')
export class DocumentController {
  constructor(private readonly documents: DocumentService) {}

  @Roles(...WORKING_STAFF_ROLES)
  @Get('registration/:registrationId')
  async listForRegistration(@Param('registrationId') registrationId: string) {
    const documents = await this.documents.listForRegistration(registrationId);

    // Storage paths are internal. Staff get ids and open each document through
    // the audited signed-URL route below.
    return {
      items: documents.map((document) => ({
        id: document.id,
        type: document.type,
        mimeType: document.mimeType,
        sizeBytes: document.sizeBytes,
        propertyEntryId: document.propertyEntryId,
        createdAt: document.createdAt,
      })),
    };
  }

  /**
   * Issues a short-lived signed URL and records who opened what. Reading a scan
   * of someone's national ID is exactly the staff action an audit trail exists
   * to capture.
   */
  @Roles(...WORKING_STAFF_ROLES)
  @Get(':id/url')
  async getViewUrl(
    @Param('tenantSlug') tenantSlug: string,
    @Param('id') id: string,
    @CurrentUser() user: SessionClaims,
  ) {
    return this.documents.createViewUrl({
      tenantSlug,
      documentId: id,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }
}
