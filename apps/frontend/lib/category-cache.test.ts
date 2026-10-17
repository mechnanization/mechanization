import { describe, expect, it } from 'vitest';
import { withSavedCategory } from './category-cache';

type Row = { id: string; active: boolean; name: string };

const fund: Row = { id: 'c1', active: true, name: 'الصندوق البلدي المستقل' };
const rent: Row = { id: 'c2', active: true, name: 'إيجارات' };
const stopped: Row = { id: 'c3', active: false, name: 'رسوم قديمة' };

describe('withSavedCategory', () => {
  it('appends a new category to both lists', () => {
    const added: Row = { id: 'c9', active: true, name: 'هبات' };
    expect(withSavedCategory([fund, rent], added, false)).toEqual([fund, rent, added]);
    expect(withSavedCategory([fund, rent, stopped], added, true)).toEqual([fund, rent, stopped, added]);
  });

  it('replaces an edited category where it stands', () => {
    const renamed: Row = { ...fund, name: 'تحويلات الصندوق' };
    expect(withSavedCategory([fund, rent], renamed, false)).toEqual([renamed, rent]);
  });

  it('keeps a stopped category out of the active list, and in the full one', () => {
    const stopping: Row = { ...rent, active: false };
    expect(withSavedCategory([fund, rent], stopping, false)).toEqual([fund]);
    expect(withSavedCategory([fund, rent], stopping, true)).toEqual([fund, stopping]);
    expect(withSavedCategory([fund], stopped, false)).toEqual([fund]);
  });

  it('leaves a list that was never read unread', () => {
    expect(withSavedCategory<Row>(undefined, fund, false)).toBeUndefined();
    expect(withSavedCategory<Row>(undefined, fund, true)).toBeUndefined();
  });

  it('does not change the list it was given', () => {
    const list = [fund, rent];
    withSavedCategory(list, { ...fund, name: 'x' }, false);
    withSavedCategory(list, { id: 'c9', active: true, name: 'y' }, false);
    expect(list).toEqual([fund, rent]);
  });
});
