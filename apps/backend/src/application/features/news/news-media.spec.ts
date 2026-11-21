import type { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NEWS_MEDIA_ACCEPT,
  NEWS_PDF_MAX_BYTES,
  NEWS_PHOTO_MAX_BYTES,
  newsFileProblem,
  uploadNewsMediaSchema,
} from '@mechanization/shared-schemas';
import type { Day3atiNews } from '../../../domain/interfaces/day3ati-news.interface';
import type { NewsActor } from './news-changes';
import { sniffNewsMedia } from './news-media-sniff';
import { NewsMediaService } from './news-media.service';
import { toMediaView } from './news-views';

/** The first bytes of each kind a News file may be. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const PDF = Buffer.from('%PDF-1.7\n');
const heic = (brand: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.from([0, 0, 0, 0])]);

describe('sniffNewsMedia', () => {
  it('knows the four photos and the PDF by their bytes', () => {
    expect(sniffNewsMedia(JPEG)).toMatchObject({ kind: 'photo', mimeType: 'image/jpeg', extension: '.jpg' });
    expect(sniffNewsMedia(PNG)).toMatchObject({ kind: 'photo', mimeType: 'image/png', extension: '.png' });
    expect(sniffNewsMedia(WEBP)).toMatchObject({ kind: 'photo', mimeType: 'image/webp', extension: '.webp' });
    expect(sniffNewsMedia(heic('heic'))).toMatchObject({ kind: 'photo', mimeType: 'image/heic', extension: '.heic' });
    expect(sniffNewsMedia(PDF)).toMatchObject({ kind: 'pdf', mimeType: 'application/pdf', extension: '.pdf' });
  });

  it.each(['heic', 'heix', 'mif1'])('takes the HEIC brand %s', (brand) => {
    expect(sniffNewsMedia(heic(brand))?.mimeType).toBe('image/heic');
  });

  it('holds a photo to 10 MB and a PDF to 15', () => {
    expect(sniffNewsMedia(JPEG)?.maxBytes).toBe(NEWS_PHOTO_MAX_BYTES);
    expect(sniffNewsMedia(PDF)?.maxBytes).toBe(NEWS_PDF_MAX_BYTES);
  });

  it.each([
    ['an empty file', Buffer.alloc(0)],
    ['text', Buffer.from('hello world, this is not a photo')],
    ['an executable', Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0])],
    ['an MP4 video, which is the same container as HEIC but another brand', heic('isom')],
    ['a GIF', Buffer.from('GIF89a......')],
    ['a box too short to carry a brand', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70])],
  ])('refuses %s', (_name, bytes) => {
    expect(sniffNewsMedia(bytes)).toBeNull();
  });

  it('is decided by the bytes, never by a name: a JPEG is a JPEG whatever it was called', () => {
    // The sniffer takes bytes only; there is no name to be fooled by.
    expect(sniffNewsMedia(JPEG)?.extension).toBe('.jpg');
  });
});

describe('NewsMediaService', () => {
  const who: NewsActor = { tenantSlug: 'albazourieh', id: 'staff-1', role: 'ADMINISTRATIVE_OFFICER' };
  const ARTICLE = '3f2a9c1e-0b7d-4e55-9a31-5d6f7a8b9c0d';
  const MEDIA = '55555555-5555-4555-8555-555555555555';
  const answer = (over: Record<string, unknown> = {}) => ({
    id: MEDIA,
    kind: 'image',
    status: 'processing',
    url: null,
    thumbnailUrl: null,
    width: null,
    height: null,
    blurhash: null,
    caption: null,
    isCover: true,
    sortOrder: 0,
    sizeBytes: '8',
    failureCode: null,
    ...over,
  });
  const fields = { isCover: true, captionAr: null, captionEn: null, captionFr: null, replacesMediaId: null };

  const setup = (reply: unknown = answer()) => {
    const news = { isConfigured: true, request: jest.fn().mockResolvedValue(reply), allPages: jest.fn() };
    const events = { emit: jest.fn() };
    return { news, events, service: new NewsMediaService(news as unknown as Day3atiNews, events as unknown as EventEmitter2) };
  };

  const sentForm = (news: { request: jest.Mock }): FormData => news.request.mock.calls[0][0].form as FormData;

  it('sends a photo as a multipart form, under a name of ours and the type of its bytes', async () => {
    const { service, news } = setup();

    await service.upload(ARTICLE, JPEG, fields, who, 'ar');

    const call = news.request.mock.calls[0][0];
    expect(call).toMatchObject({
      method: 'POST',
      path: `/api/v1/news/manage/articles/${ARTICLE}/media`,
      userId: 'staff-1',
    });
    expect(call.timeoutMs).toBeGreaterThan(10_000);
    const file = sentForm(news).get('File') as File;
    expect(file.name).toBe('photo.jpg');
    expect(file.type).toBe('image/jpeg');
    expect(sentForm(news).get('IsCover')).toBe('true');
  });

  it('names a PDF file.pdf, and sends the captions and the id it replaces when there are some', async () => {
    const { service, news } = setup(answer({ kind: 'pdf', status: 'ready', isCover: false }));
    const replaced = '66666666-6666-4666-8666-666666666666';

    await service.upload(ARTICLE, PDF, { ...fields, isCover: false, captionAr: 'محضر', captionEn: 'Minutes', replacesMediaId: replaced }, who, 'ar');

    const form = sentForm(news);
    expect((form.get('File') as File).name).toBe('file.pdf');
    expect(form.get('IsCover')).toBe('false');
    expect(form.get('CaptionAr')).toBe('محضر');
    expect(form.get('CaptionEn')).toBe('Minutes');
    expect(form.has('CaptionFr')).toBe(false);
    expect(form.get('ReplacesMediaId')).toBe(replaced);
  });

  it('turns away a file that is not a photo or a PDF before anything is sent, under the file box', async () => {
    const { service, news, events } = setup();
    const error = await service.upload(ARTICLE, Buffer.from('MZ not a photo'), fields, who, 'ar').catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: 'NEWS_INVALID_INPUT',
      kind: 'VALIDATION_FAILED',
      details: [{ path: 'file', code: 'news.unsupported_file' }],
    });
    expect(news.request).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('turns away no file at all the same way', async () => {
    const { service } = setup();
    await expect(service.upload(ARTICLE, undefined, fields, who, 'ar')).rejects.toMatchObject({
      details: [{ path: 'file', code: 'news.unsupported_file' }],
    });
  });

  it('turns away a photo over 10 MB, but takes a PDF of the same size', async () => {
    const size = NEWS_PHOTO_MAX_BYTES + 1;
    const bigPhoto = Buffer.concat([JPEG, Buffer.alloc(size - JPEG.length)]);
    const bigPdf = Buffer.concat([PDF, Buffer.alloc(size - PDF.length)]);

    const photo = setup();
    await expect(photo.service.upload(ARTICLE, bigPhoto, fields, who, 'ar')).rejects.toMatchObject({
      details: [{ path: 'file', code: 'news.file_too_large' }],
    });
    expect(photo.news.request).not.toHaveBeenCalled();

    const pdf = setup(answer({ kind: 'pdf', status: 'ready' }));
    await expect(pdf.service.upload(ARTICLE, bigPdf, fields, who, 'ar')).resolves.toMatchObject({ kind: 'pdf' });
  });

  it('records the upload by kind and status, never the file, its name or its caption', async () => {
    const { service, events } = setup();
    await service.upload(ARTICLE, JPEG, { ...fields, captionAr: 'سري' }, who, 'ar');

    expect(events.emit).toHaveBeenCalledWith(
      'news.changed',
      expect.objectContaining({
        action: 'NEWS_MEDIA_UPLOADED',
        entityType: 'NewsArticle',
        entityId: ARTICLE,
        after: { kind: 'image', status: 'processing', replaced: false, cover: true },
      }),
    );
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain('سري');
  });

  it('makes a photo the cover and records it', async () => {
    const { service, news, events } = setup(answer({ status: 'ready', isCover: true }));
    await service.setCover(ARTICLE, MEDIA, who, 'ar');
    expect(news.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'PUT', path: `/api/v1/news/manage/articles/${ARTICLE}/media/${MEDIA}/cover` }),
    );
    expect(events.emit.mock.calls[0][1]).toMatchObject({ action: 'NEWS_MEDIA_COVER_CHANGED', entityId: ARTICLE });
  });

  it('deletes a file and records it', async () => {
    const { service, news, events } = setup(undefined);
    await expect(service.remove(ARTICLE, MEDIA, who, 'ar')).resolves.toBeUndefined();
    expect(news.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'DELETE', path: `/api/v1/news/manage/articles/${ARTICLE}/media/${MEDIA}` }),
    );
    expect(events.emit.mock.calls[0][1]).toMatchObject({ action: 'NEWS_MEDIA_DELETED' });
  });

  it('does not report what Day3ati refused', async () => {
    const { service, news, events } = setup();
    news.request.mockRejectedValue(new Error('refused'));
    await expect(service.upload(ARTICLE, JPEG, fields, who, 'ar')).rejects.toThrow('refused');
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('is News being unavailable when the answer is not a file it can read', async () => {
    const { service, events } = setup({ unexpected: true });
    await expect(service.upload(ARTICLE, JPEG, fields, who, 'ar')).rejects.toMatchObject({ code: 'NEWS_UNAVAILABLE' });
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('toMediaView', () => {
  const raw = {
    id: '55555555-5555-4555-8555-555555555555',
    kind: 'image',
    status: 'ready',
    url: 'https://cdn.example.test/a.jpg',
    thumbnailUrl: 'https://cdn.example.test/a-t.jpg',
    width: 1200,
    height: '800',
    blurhash: 'LEHV6nWB2yk8pyo0adR*.7kCMdnj',
    caption: { ar: 'الساحة', en: null, fr: null },
    isCover: true,
    sortOrder: '0',
    sizeBytes: 523_000,
    failureCode: null,
  };

  it('reads a file, takes numbers sent as strings, and leaves the blurhash out', () => {
    const view = toMediaView(raw);
    expect(view).toMatchObject({ width: 1200, height: 800, sortOrder: 0, sizeBytes: 523_000, isCover: true });
    expect(view).not.toHaveProperty('blurhash');
  });

  it('reads a photo still processing, which has no address, size or shape yet', () => {
    expect(
      toMediaView({ ...raw, status: 'processing', url: null, thumbnailUrl: null, width: null, height: null, caption: null }),
    ).toMatchObject({ status: 'processing', url: null, thumbnailUrl: null, width: null, height: null, caption: null });
  });

  it('keeps why a photo failed', () => {
    expect(toMediaView({ ...raw, status: 'failed', failureCode: 'media.decode_failed' })?.failureCode).toBe('media.decode_failed');
  });

  it.each([
    ['an unknown status', { status: 'lost' }],
    ['an unknown kind', { kind: 'video' }],
    ['a switch that is not a boolean', { isCover: 'yes' }],
    ['a size that is not a number', { sizeBytes: 'big' }],
  ])('refuses %s', (_name, over) => {
    expect(toMediaView({ ...raw, ...over })).toBeNull();
  });
});

describe('what the browser can tell before it sends', () => {
  const file = (name: string, type: string, size = 1000) => ({ name, type, size });

  it('takes the photos and the PDF, by type or by extension', () => {
    expect(newsFileProblem(file('a.jpg', 'image/jpeg'))).toBeNull();
    expect(newsFileProblem(file('a.png', 'image/png'))).toBeNull();
    expect(newsFileProblem(file('a.webp', 'image/webp'))).toBeNull();
    expect(newsFileProblem(file('IMG_0001.HEIC', ''))).toBeNull();
    expect(newsFileProblem(file('minutes.pdf', 'application/pdf'))).toBeNull();
  });

  it('refuses what is neither, and an empty file', () => {
    expect(newsFileProblem(file('a.gif', 'image/gif'))).toBe('unsupported');
    expect(newsFileProblem(file('a.exe', 'application/octet-stream'))).toBe('unsupported');
    expect(newsFileProblem(file('a.jpg', 'image/jpeg', 0))).toBe('unsupported');
  });

  it('holds a photo to 10 MB and a PDF to 15 MB', () => {
    expect(newsFileProblem(file('a.jpg', 'image/jpeg', NEWS_PHOTO_MAX_BYTES))).toBeNull();
    expect(newsFileProblem(file('a.jpg', 'image/jpeg', NEWS_PHOTO_MAX_BYTES + 1))).toBe('tooLarge');
    expect(newsFileProblem(file('a.pdf', 'application/pdf', NEWS_PDF_MAX_BYTES))).toBeNull();
    expect(newsFileProblem(file('a.pdf', 'application/pdf', NEWS_PDF_MAX_BYTES + 1))).toBe('tooLarge');
  });

  it('offers HEIC in the file dialog, which some browsers leave out of image/*', () => {
    expect(NEWS_MEDIA_ACCEPT).toContain('.heic');
    expect(NEWS_MEDIA_ACCEPT).toContain('application/pdf');
  });
});

describe('uploadNewsMediaSchema', () => {
  it('reads the strings a multipart form carries', () => {
    expect(uploadNewsMediaSchema.parse({})).toEqual({
      isCover: false,
      captionAr: null,
      captionEn: null,
      captionFr: null,
      replacesMediaId: null,
    });
    expect(
      uploadNewsMediaSchema.parse({
        isCover: 'true',
        captionAr: '  محضر  ',
        replacesMediaId: '66666666-6666-4666-8666-666666666666',
      }),
    ).toMatchObject({ isCover: true, captionAr: 'محضر', replacesMediaId: '66666666-6666-4666-8666-666666666666' });
  });

  it('takes an empty id as none, and refuses a wrong one, a wrong switch and a long caption', () => {
    expect(uploadNewsMediaSchema.parse({ replacesMediaId: '' }).replacesMediaId).toBeNull();
    expect(uploadNewsMediaSchema.safeParse({ replacesMediaId: 'x' }).success).toBe(false);
    expect(uploadNewsMediaSchema.safeParse({ isCover: 'maybe' }).success).toBe(false);
    expect(uploadNewsMediaSchema.safeParse({ captionAr: 'س'.repeat(201) }).success).toBe(false);
  });
});
