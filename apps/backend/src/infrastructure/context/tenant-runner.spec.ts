import { TenantContextService } from './tenant-context.service';
import { TenantRunner } from './tenant-runner';
import type { TenantPrismaFactory } from '../prisma/tenant-prisma.factory';

/**
 * The scope `runAsTenant` opens must name one municipality throughout: the slug,
 * the schema and the client all from the same registry row. A mismatch there is
 * a cross-tenant read, so the pairing is what this pins.
 */
describe('TenantRunner.runAsTenant', () => {
  const clientFor = (schemaName: string) => ({ schemaName }) as never;
  const clients = { forSchema: jest.fn(clientFor) } as unknown as TenantPrismaFactory;

  it("opens the tenant's scope with its own schema's client, and hands that client to the function", () => {
    const context = new TenantContextService();
    const runner = new TenantRunner(context, clients);

    const seen = runner.runAsTenant({ id: 'id-a', slug: 'a', schemaName: 'tenant_a' }, (prisma) => ({
      prisma,
      scope: context.require(),
    }));

    expect(clients.forSchema).toHaveBeenCalledWith('tenant_a');
    expect(seen.prisma).toEqual({ schemaName: 'tenant_a' });
    expect(seen.scope).toMatchObject({ tenantId: 'id-a', tenantSlug: 'a', schemaName: 'tenant_a' });
    expect(seen.scope.prisma).toBe(seen.prisma);
    expect(seen.scope.transaction).toBeUndefined();
  });

  it('leaves no scope behind, and nests without leaking one tenant into the other', async () => {
    const context = new TenantContextService();
    const runner = new TenantRunner(context, clients);

    const slugs = await runner.runAsTenant({ id: 'id-a', slug: 'a', schemaName: 'tenant_a' }, async () => {
      const inner = await runner.runAsTenant({ id: 'id-b', slug: 'b', schemaName: 'tenant_b' }, async () =>
        context.require().tenantSlug,
      );
      return [context.require().tenantSlug, inner];
    });

    expect(slugs).toEqual(['a', 'b']);
    expect(context.peek()).toBeUndefined();
  });
});
