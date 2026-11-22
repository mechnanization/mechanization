import {
  type NewsFieldError,
  type NewsLanguage,
  type NewsMediaView,
  type UploadNewsMediaInput,
} from '@mechanization/shared-schemas';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConflictError, ValidationError } from '../../../domain/errors/domain-error';
import { DAY3ATI_NEWS, type Day3atiNews } from '../../../domain/interfaces/day3ati-news.interface';
import { emitNewsChanged, type NewsActor } from './news-changes';
import { sniffNewsMedia } from './news-media-sniff';
import { toMediaView } from './news-views';

const ARTICLES = '/api/v1/news/manage/articles';

/** A photo is re-encoded in the background and a big file crosses a slow link: well past the ten-second default. */
const UPLOAD_TIMEOUT_MS = 90_000;

/**
 * The photos and PDFs of a News article on Day3ati.
 *
 * - **What is sent is checked here first.** The type is read from the bytes
 *   (`sniffNewsMedia`), never the name or the declared type, and the size is
 *   held to what that kind may weigh. A refusal is a form error on the `file`
 *   field with Day3ati's own codes (`news.unsupported_file`,
 *   `news.file_too_large`), so a file we turn away and one Day3ati turns away
 *   read the same on the screen.
 * - **Day3ati receives a name of ours.** The part is called `photo.jpg` or
 *   `file.pdf` by the sniffed kind; the name the editor's device gave is never
 *   passed on, logged or kept (it can carry a person's name or a path).
 * - **A photo is not ready when it is accepted.** Day3ati answers `processing`
 *   and finishes in the background; the screen reads the article again until
 *   it is `ready` or `failed`. An «upload again» sends the replacement with
 *   `replacesMediaId`.
 * - Each accepted change leaves an audit row (`news.changed`): the article, the
 *   kind and the status; never the file, its name or its caption.
 */
@Injectable()
export class NewsMediaService {
  private readonly logger = new Logger(NewsMediaService.name);

  constructor(
    @Inject(DAY3ATI_NEWS) private readonly news: Day3atiNews,
    private readonly events: EventEmitter2,
  ) {}

  async upload(
    articleId: string,
    file: Buffer | undefined,
    fields: UploadNewsMediaInput,
    who: NewsActor,
    language: NewsLanguage,
  ): Promise<NewsMediaView> {
    const sniffed = file ? sniffNewsMedia(file) : null;
    if (!file || !sniffed) throw fileRefusal('news.unsupported_file', 'The file is not a photo or a PDF Day3ati takes');
    if (file.length > sniffed.maxBytes) throw fileRefusal('news.file_too_large', 'The file is larger than its kind may be');

    const form = new FormData();
    // The bytes are copied into a Blob typed by what they are, under a name of ours.
    form.set('File', new Blob([new Uint8Array(file)], { type: sniffed.mimeType }), `${sniffed.kind === 'pdf' ? 'file' : 'photo'}${sniffed.extension}`);
    form.set('IsCover', fields.isCover ? 'true' : 'false');
    if (fields.captionAr) form.set('CaptionAr', fields.captionAr);
    if (fields.captionEn) form.set('CaptionEn', fields.captionEn);
    if (fields.captionFr) form.set('CaptionFr', fields.captionFr);
    if (fields.replacesMediaId) form.set('ReplacesMediaId', fields.replacesMediaId);

    const body = await this.news.request({
      tenantSlug: who.tenantSlug,
      userId: who.id,
      language,
      method: 'POST',
      path: `${ARTICLES}/${encodeURIComponent(articleId)}/media`,
      form,
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const media = this.read(toMediaView(body), 'uploaded file');
    emitNewsChanged(this.events, who, {
      action: 'NEWS_MEDIA_UPLOADED',
      entityType: 'NewsArticle',
      entityId: articleId,
      after: { kind: media.kind, status: media.status, replaced: fields.replacesMediaId !== null, cover: media.isCover },
    });
    return media;
  }

  /** Makes a photo the cover of its article. */
  async setCover(articleId: string, mediaId: string, who: NewsActor, language: NewsLanguage): Promise<NewsMediaView> {
    const body = await this.news.request({
      tenantSlug: who.tenantSlug,
      userId: who.id,
      language,
      method: 'PUT',
      path: `${ARTICLES}/${encodeURIComponent(articleId)}/media/${encodeURIComponent(mediaId)}/cover`,
    });
    const media = this.read(toMediaView(body), 'cover');
    emitNewsChanged(this.events, who, { action: 'NEWS_MEDIA_COVER_CHANGED', entityType: 'NewsArticle', entityId: articleId });
    return media;
  }

  async remove(articleId: string, mediaId: string, who: NewsActor, language: NewsLanguage): Promise<void> {
    await this.news.request({
      tenantSlug: who.tenantSlug,
      userId: who.id,
      language,
      method: 'DELETE',
      path: `${ARTICLES}/${encodeURIComponent(articleId)}/media/${encodeURIComponent(mediaId)}`,
    });
    emitNewsChanged(this.events, who, { action: 'NEWS_MEDIA_DELETED', entityType: 'NewsArticle', entityId: articleId });
  }

  private read<T>(value: T | null, what: string): T {
    if (value !== null) return value;
    this.logger.error(`Day3ati answered a ${what} in a form this build does not read`);
    throw new ConflictError({ code: 'NEWS_UNAVAILABLE', message: `Day3ati answered a ${what} in an unreadable form` });
  }
}

/** A file refused, shown under the file box with the code Day3ati would have used. */
function fileRefusal(code: NewsFieldError['code'] & string, message: string): ValidationError {
  const field: NewsFieldError = { path: 'file', message: code, code };
  return new ValidationError({ code: 'NEWS_INVALID_INPUT', message, details: [field] });
}
