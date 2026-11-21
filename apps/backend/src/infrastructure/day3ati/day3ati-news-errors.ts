import { NEWS_FIELD_ERROR_CODES, type NewsFieldError } from '@mechanization/shared-schemas';
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../domain/errors/domain-error';
import { Day3atiApiError } from '../../domain/interfaces/day3ati-integration.interface';
import { Day3atiAuthError } from '../../domain/interfaces/day3ati-tokens.interface';

/**
 * What Day3ati refuses with, as the refusals a News screen can explain.
 *
 * Day3ati answers with ProblemDetails: a stable `code`, and for a form the
 * `errors` of each field. Both are read here and turned into one of nine
 * `NEWS_*` codes, which the frontend words in both languages. Nothing of the
 * answer's own text is passed on except the per-field messages, which are
 * written for the person filling the form in, in the language they asked for.
 *
 * | Day3ati | Ours |
 * |---|---|
 * | `auth.forbidden`, or any other 403 | `NEWS_FORBIDDEN` (the role may not do this) |
 * | `village.not_member`, `oauth.invalid_grant` | `NEWS_NOT_A_MEMBER` (no account there, or removed) |
 * | `news.already_published` (scheduling a published article) | `NEWS_ARTICLE_ALREADY_PUBLISHED` |
 * | `village.module_disabled` | `NEWS_MODULE_DISABLED` |
 * | `integration.village_not_allowed`, no village for the municipality | `NEWS_VILLAGE_NOT_LINKED` |
 * | 400 and 422, with their per-field `errors` | `NEWS_INVALID_INPUT` |
 * | 404 | `NEWS_NOT_FOUND` |
 * | 5xx, 408, 429, no answer, an unreadable answer, a token we cannot get | `NEWS_UNAVAILABLE` |
 * | any other refusal | `NEWS_REQUEST_REFUSED` |
 */

/** The most field messages passed on, and the longest each may be: a form shows a few, not a page. */
const MAX_FIELD_MESSAGES = 20;
const MAX_FIELD_MESSAGE_LENGTH = 300;

export interface NewsProblem {
  /** The partner's stable code, when it sent a readable one. */
  code?: string;
  /** The partner's one-line title, cut short: the words for a refusal that names no field. */
  title?: string;
  /** One entry per message, the field named as the form names it. */
  fields: Array<{ path: string; message: string }>;
}

/**
 * The code and the per-field errors of a ProblemDetails body.
 *
 * ASP.NET names a field the way the model does (`Title`, `Items[0].Name`); the
 * form's fields are camel case, so the first letter of each part is lowered.
 */
export function readProblem(body: unknown): NewsProblem {
  const problem: NewsProblem = { fields: [] };
  if (typeof body !== 'object' || body === null) return problem;

  const { code, title, errors } = body as { code?: unknown; title?: unknown; errors?: unknown };
  if (typeof code === 'string' && /^[a-z0-9_.]{1,64}$/i.test(code)) problem.code = code;
  if (typeof title === 'string' && title !== '') problem.title = title.slice(0, MAX_FIELD_MESSAGE_LENGTH);

  if (typeof errors === 'object' && errors !== null && !Array.isArray(errors)) {
    for (const [field, messages] of Object.entries(errors)) {
      const list = Array.isArray(messages) ? messages : [messages];
      for (const message of list) {
        if (typeof message !== 'string' || message === '') continue;
        if (problem.fields.length >= MAX_FIELD_MESSAGES) return problem;
        problem.fields.push({
          path: field
            .split('.')
            .map((part) => part.charAt(0).toLowerCase() + part.slice(1))
            .join('.'),
          message: message.slice(0, MAX_FIELD_MESSAGE_LENGTH),
        });
      }
    }
  }
  return problem;
}

export const newsUnavailable = (message: string): DomainError =>
  new ConflictError({ code: 'NEWS_UNAVAILABLE', message });

export const newsVillageNotLinked = (message: string): DomainError =>
  new ConflictError({ code: 'NEWS_VILLAGE_NOT_LINKED', message });

/** The refusal for an answer Day3ati sent to a village call. */
export function newsErrorFromAnswer(status: number, problem: NewsProblem): DomainError {
  // A refusal that belongs to one field of a form (a key already taken) is shown under that field,
  // whatever status it came with; the screen words the code, and the partner's title is the fallback.
  const fieldCode =
    problem.code && problem.code in NEWS_FIELD_ERROR_CODES
      ? (problem.code as keyof typeof NEWS_FIELD_ERROR_CODES)
      : undefined;
  if (fieldCode) {
    const field: NewsFieldError = {
      path: NEWS_FIELD_ERROR_CODES[fieldCode],
      message: problem.title ?? fieldCode,
      code: fieldCode,
    };
    return new ValidationError({
      code: 'NEWS_INVALID_INPUT',
      message: `Day3ati refused a field (${fieldCode})`,
      details: [field],
    });
  }

  switch (problem.code) {
    case 'auth.forbidden':
      return new ForbiddenError({ code: 'NEWS_FORBIDDEN', message: 'Day3ati refused the role (auth.forbidden)' });
    case 'village.not_member':
      return new ForbiddenError({ code: 'NEWS_NOT_A_MEMBER', message: 'The user is not a member of the village' });
    case 'news.already_published':
      return new ConflictError({
        code: 'NEWS_ARTICLE_ALREADY_PUBLISHED',
        message: 'The article is already published, so it cannot be scheduled',
      });
    case 'village.module_disabled':
      return new ConflictError({ code: 'NEWS_MODULE_DISABLED', message: 'The News module is off for the village' });
    case 'integration.village_not_allowed':
      return newsVillageNotLinked('This client may not use the village (integration.village_not_allowed)');
    default:
      break;
  }

  if (status === 403) return new ForbiddenError({ code: 'NEWS_FORBIDDEN', message: 'Day3ati answered 403' });
  if (status === 404) return new NotFoundError({ code: 'NEWS_NOT_FOUND', message: 'Day3ati answered 404' });
  if (status === 400 || status === 422) {
    return new ValidationError({
      code: 'NEWS_INVALID_INPUT',
      message: `Day3ati refused the input (${problem.code ?? status})`,
      details: problem.fields,
    });
  }
  if (status >= 500 || status === 408 || status === 429 || status === 401) {
    // A 401 here is one that survived a fresh token: not the user's to fix.
    return newsUnavailable(`Day3ati answered ${status}${problem.code ? ` (${problem.code})` : ''}`);
  }
  return new ConflictError({
    code: 'NEWS_REQUEST_REFUSED',
    message: `Day3ati refused the request (${problem.code ?? status})`,
    details: { status, ...(problem.code ? { partnerCode: problem.code } : {}) },
  });
}

/** The refusal for a failure that is not an answer: a token we could not get, a call that could not be made. */
export function newsErrorFromFailure(error: unknown): DomainError {
  if (error instanceof DomainError) return error;

  if (error instanceof Day3atiAuthError || error instanceof Day3atiApiError) {
    if (error.code === 'oauth.invalid_grant') {
      return new ForbiddenError({ code: 'NEWS_NOT_A_MEMBER', message: 'The user has no Day3ati account (oauth.invalid_grant)' });
    }
    return newsUnavailable(`Day3ati could not be reached (${error.code})`);
  }
  return newsUnavailable('Day3ati could not be reached');
}
