import { PropertyEntry } from './property-entry.entity';
import { Registration } from './registration.entity';

const property = (propertyNumber: string): PropertyEntry =>
  PropertyEntry.create({
    occupancyType: 'OWNER',
    propertyType: 'LAND',
    neighborhood: 'الزهراء',
    propertyNumber,
    landType: 'AGRICULTURAL',
    unitArea: 500,
    shares: 400,
  });

describe('Registration — creation', () => {
  it('accepts a submission with no properties — a citizen who owns nothing and only rents', () => {
    const registration = Registration.create({
      id: 'r1',
      citizenId: 'c1',
      referenceNumber: 'BZR-2607-4K9QX2',
      properties: [],
    });

    expect(registration.properties).toHaveLength(0);
  });

  it('accepts several structures standing on the same رقم العقار', () => {
    /*
      This used to throw, on the reading that a repeated number is a clerk's
      copy-paste slip. It is more often the property itself: one deed carrying
      a building, the house behind it and a shop on the street — three things
      that are typed, inspected and taxed differently, and one piece of land.

      Refusing it forced the clerk to invent a number, file the structures
      under one card whose نوع العقار could only describe one of them, or leave
      them unregistered. The register was getting all three.
    */
    const registration = Registration.create({
      id: 'r1',
      citizenId: 'c1',
      referenceNumber: 'BZR-2607-4K9QX2',
      properties: [property('L-1'), property('L-1')],
    });

    expect(registration.properties).toHaveLength(2);
  });

  it('records a submitted event so the audit trail has something to subscribe to', () => {
    const created = Registration.create({
      id: 'r1',
      citizenId: 'c1',
      referenceNumber: 'BZR-2607-4K9QX2',
      properties: [property('L-1')],
    });

    const events = created.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0].name).toBe('registration.submitted');

    // Draining twice must not republish — an audit trail with duplicates is
    // worse than one with gaps, because it looks complete.
    expect(created.pullEvents()).toHaveLength(0);
  });
});
