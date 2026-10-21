import { describe, expect, it } from 'vitest';
import { municipalityNameFor } from './municipality-name';

describe('municipalityNameFor', () => {
  it('is the English name on /en/ when one has been entered', () => {
    expect(municipalityNameFor('en', { nameAr: 'البازورية', nameEn: 'Al-Bazouriyeh' })).toBe('Al-Bazouriyeh');
  });

  it('falls back to the Arabic name on /en/ until an English one is entered', () => {
    expect(municipalityNameFor('en', { nameAr: 'البازورية', nameEn: null })).toBe('البازورية');
    expect(municipalityNameFor('en', { nameAr: 'البازورية', nameEn: '   ' })).toBe('البازورية');
    expect(municipalityNameFor('en', { nameAr: 'البازورية' })).toBe('البازورية');
  });

  it('is the Arabic name on every other locale, whatever English name exists', () => {
    expect(municipalityNameFor('ar', { nameAr: 'البازورية', nameEn: 'Al-Bazouriyeh' })).toBe('البازورية');
  });

  it('is empty, never a placeholder, when nothing is known yet', () => {
    expect(municipalityNameFor('ar', {})).toBe('');
    expect(municipalityNameFor('en', { nameAr: null, nameEn: null })).toBe('');
  });
});
