import { CitizenRequestsController } from './citizen-requests.controller';

/**
 * The portal's request routes (`requests/mine/…`) carry no `@Roles`: a staff
 * token is refused (`CITIZENS_ONLY`) before anything is read, and a citizen's
 * every call is scoped by the token's subject alone — never by an id from the
 * path or the body. The service keeps the scope (`citizen-requests.integration.spec.ts`
 * shows another citizen's request answering as not found); this pins that the
 * controller hands it the token's subject and nothing else.
 */
describe('CitizenRequestsController — the citizen\'s own routes', () => {
  const ME = '11111111-1111-4111-8111-111111111111';
  const SOMEONE_ELSE = '22222222-2222-4222-8222-222222222222';
  const REQUEST_ID = '33333333-3333-4333-8333-333333333333';
  const citizen = { sub: ME, kind: 'CITIZEN', tenantSlug: 'zahle' } as never;
  const staffToken = { sub: SOMEONE_ELSE, kind: 'STAFF', role: 'SUPER_ADMIN', tenantSlug: 'zahle' } as never;
  const file = { buffer: Buffer.from('%PDF-1.7'), size: 8 } as never;

  const build = () => {
    const service = {
      mine: jest.fn().mockResolvedValue([]),
      submit: jest.fn().mockResolvedValue({}),
      mineOne: jest.fn().mockResolvedValue({}),
      addAttachment: jest.fn().mockResolvedValue({}),
      raiseBill: jest.fn().mockResolvedValue({}),
      cancel: jest.fn().mockResolvedValue(undefined),
    };
    const forms = { offeredForms: jest.fn().mockResolvedValue([]) };
    return { service, forms, controller: new CitizenRequestsController(service as never, forms as never) };
  };

  it('refuses a staff token on every one of them, before the service is asked anything', async () => {
    const { service, forms, controller } = build();
    const calls: Array<() => unknown> = [
      () => controller.mine(staffToken),
      () => controller.mineForms(staffToken),
      () => controller.submitMine({} as never, staffToken),
      () => controller.mineOne(REQUEST_ID, staffToken),
      () => controller.uploadMine(REQUEST_ID, file, { type: 'IDENTITY' } as never, staffToken),
      () => controller.billMine(REQUEST_ID, staffToken),
      () => controller.cancelMine(REQUEST_ID, staffToken),
    ];
    for (const call of calls) {
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({ code: 'CITIZENS_ONLY' });
    }
    for (const method of [...Object.values(service), ...Object.values(forms)]) expect(method).not.toHaveBeenCalled();
  });

  it('scopes every call by the token\'s subject, whatever the body names', async () => {
    const { service, forms, controller } = build();
    await controller.mine(citizen);
    expect(service.mine).toHaveBeenCalledWith(ME);

    // The forms come with this citizen's own file values, never another's.
    await controller.mineForms(citizen);
    expect(forms.offeredForms).toHaveBeenCalledWith(ME);

    // A body that names another citizen is overridden by the token.
    await controller.submitMine({ citizenId: SOMEONE_ELSE, formId: 'a-form' } as never, citizen);
    expect(service.submit).toHaveBeenCalledWith(expect.objectContaining({ citizenId: ME }), { kind: 'CITIZEN', id: ME });

    await controller.mineOne(REQUEST_ID, citizen);
    expect(service.mineOne).toHaveBeenCalledWith(ME, REQUEST_ID);

    await controller.uploadMine(REQUEST_ID, file, { type: 'IDENTITY' } as never, citizen);
    expect(service.addAttachment).toHaveBeenCalledWith(REQUEST_ID, expect.anything(), 'IDENTITY', { kind: 'CITIZEN', id: ME }, { citizenId: ME }, undefined);

    // A paper for a question of a form carries its key.
    await controller.uploadMine(REQUEST_ID, file, { fieldKey: 'id_copy' } as never, citizen);
    expect(service.addAttachment).toHaveBeenLastCalledWith(REQUEST_ID, expect.anything(), undefined, { kind: 'CITIZEN', id: ME }, { citizenId: ME }, 'id_copy');

    await controller.billMine(REQUEST_ID, citizen);
    expect(service.raiseBill).toHaveBeenCalledWith(REQUEST_ID, { kind: 'CITIZEN', id: ME }, { citizenId: ME });

    await controller.cancelMine(REQUEST_ID, citizen);
    expect(service.cancel).toHaveBeenCalledWith(REQUEST_ID, { kind: 'CITIZEN', id: ME }, { citizenId: ME });
  });
});
