import { describe, expect, it } from 'vitest';
import { STAFF_ROLE } from '@mechanization/shared-schemas';
import { ROLE_BACKEND_VALUE, ROLE_KEYS, roleKeyFor, settingsCopy } from './settings-i18n';

/*
  «إعدادات البلدية» → المستخدمون is the second place an account is created, and
  the catalogue that explains each role. «مشاهد فقط» reached the staff form and
  missed this one: an existing VIEWER showed as the raw enum, and none could be
  created here. Every role the register stores must have a catalogue entry.
*/
describe('the settings role catalogue', () => {
  it('names every staff role the register can store', () => {
    for (const role of STAFF_ROLE) {
      expect(roleKeyFor(role), role).toBeDefined();
    }
  });

  it('maps every catalogue key to a real role, and has words for it in both languages', () => {
    for (const key of ROLE_KEYS) {
      expect(STAFF_ROLE as readonly string[]).toContain(ROLE_BACKEND_VALUE[key]);
      expect(settingsCopy('ar').users.roleNames[key]).toBeTruthy();
      expect(settingsCopy('en').users.roleNames[key]).toBeTruthy();
      expect(settingsCopy('ar').users.roleDuties[key]).toBeTruthy();
      expect(settingsCopy('en').users.roleDuties[key]).toBeTruthy();
    }
  });
});
