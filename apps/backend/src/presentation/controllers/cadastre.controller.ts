import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { CadastreImportService } from '../../application/features/cadastre/cadastre-import.service';
import { ValidationError } from '../../application/common/exceptions';
import { CADASTRE_STORAGE_SERVICE } from '../../domain/interfaces/base-repository.interface';
import type { CadastreStorage } from '../../domain/interfaces/cadastre-storage.interface';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Roles } from '../decorators/roles.decorator';
import type { SessionClaims } from '../../application/features/identity/identity.service';
import { APP_CONFIG } from '../config/app.config';

@Controller('t/:tenantSlug/cadastre')
export class CadastreController {
  constructor(
    private readonly cadastreImport: CadastreImportService,
    @Inject(CADASTRE_STORAGE_SERVICE) private readonly assets: CadastreStorage,
  ) {}

  /**
   * Proxies a tenant's static GeoJSON map layers from S3.
   *
   * The frontend's own `public/tenants/<slug>/` copy (committed to git) is
   * this asset's fast path for `cadastre.geojson`/`parcels.geojson` — same
   * origin, no round trip through this API. This endpoint is what the map
   * falls back to when that copy is missing, and the only path at all for
   * `parcel-polygons.geojson`/`city-boundary.geojson`, which the frontend
   * never fetches directly. Proxied through this API's own origin rather than
   * redirected to the bucket's own S3 host, which the deployed frontend's CSP
   * `connect-src` does not allow — the bucket being public-read is what makes
   * a redirect conceivable, not permitted.
   */
  @Get('assets/:assetName')
  async getAsset(
    @Param('tenantSlug') tenantSlug: string,
    @Param('assetName') assetName: string,
    @Res() res: Response,
  ) {
    const allowed = [
      'cadastre.geojson',
      'parcels.geojson',
      'parcel-polygons.geojson',
      'city-boundary.geojson',
    ];
    if (!allowed.includes(assetName)) {
      throw new NotFoundException('Asset not found');
    }

    const contents = await this.assets.read(tenantSlug, assetName);
    if (contents === null) {
      throw new NotFoundException('Asset file not found');
    }

    res.setHeader('Content-Type', 'application/geo+json');
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    res.send(contents);
  }

  /**
   * SUPER_ADMIN only: this rebuilds the parcel registry every citizen
   * submission validates against and overwrites the map's cartography layer —
   * a mistaken upload here affects every registration the municipality takes
   * afterward, not just one record.
   */
  @Roles('SUPER_ADMIN')
  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: APP_CONFIG.cadastre.maxFileSizeBytes } }),
  )
  async import(
    @Param('tenantSlug') tenantSlug: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser() user: SessionClaims,
  ) {
    if (!file) {
      throw new ValidationError('لم يتم إرفاق ملف GeoJSON');
    }

    return this.cadastreImport.importGeoJson({
      tenantSlug,
      buffer: file.buffer,
      actor: { id: user.sub, role: user.role ?? '' },
    });
  }
}
