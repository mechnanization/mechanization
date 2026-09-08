import { AggregateRoot } from './aggregate-root.base';
import { PropertyEntry } from './property-entry.entity';

/**
 * A citizen's property filing: one رقم مرجعي over one or more عقارات.
 *
 * This used to be a *claim* with a lifecycle — PENDING → UNDER_REVIEW →
 * VERIFIED → APPROVED, REJECTED from anywhere, and a citizen's `resubmit` as
 * the one way back. All of it existed because citizens filed their own طلبات
 * and the municipality adjudicated them. Records are now entered by staff from
 * documents handed over a counter, so there is nothing left to adjudicate: the
 * row exists because a clerk entered it, which is what مقبول used to certify.
 *
 * What remains is the aggregate's real job, and the reason it is not just a
 * table: it used to refuse an empty filing, back when every citizen was
 * assumed to hold property. A citizen who owns nothing and only rents has
 * none to file, so an empty `properties` array is now a legitimate
 * registration — personal and household information with no عقار attached.
 */
export class Registration extends AggregateRoot {
  private constructor(
    readonly id: string,
    readonly citizenId: string,
    readonly referenceNumber: string,
    readonly properties: PropertyEntry[],
  ) {
    super();
  }

  static create(props: {
    id: string;
    citizenId: string;
    referenceNumber: string;
    properties: PropertyEntry[];
  }): Registration {
    /*
      Several cards in one filing MAY claim the same رقم العقار.

      This used to be refused, on the reading that a repeated number is a
      clerk's copy-paste slip. It is more often the property itself. One parcel
      routinely carries a building, a standalone house behind it and a shop on
      the street — one deed, one cadastral number, three structures that are
      taxed and inspected as different things. Refusing the second card forced
      the clerk to either invent a number, file the structures under one card
      whose نوع العقار could only describe one of them, or leave them
      unregistered; the register was getting all three.

      Nothing is lost by allowing it. A parcel number was never an identity
      here — `property_entries.propertyNumber` is deliberately non-unique across
      citizens, because an apartment building is one number shared by everyone
      inside it, and a rule that let twelve strangers share a number while
      refusing one owner two of their own structures was not protecting
      anything. What distinguishes the cards is what always did: نوع العقار,
      the units under them, and their own row ids.

      The rule was also only ever half-enforced. `CitizensService.update` never
      called this constructor, so a clerk could file one card and then add the
      duplicate by editing — the invariant held at the front door and nowhere
      else, which is the worst place for an invariant to hold.
    */

    const registration = new Registration(
      props.id,
      props.citizenId,
      props.referenceNumber,
      props.properties,
    );

    registration.record('registration.submitted', {
      registrationId: props.id,
      citizenId: props.citizenId,
      referenceNumber: props.referenceNumber,
      propertyCount: props.properties.length,
    });

    return registration;
  }

  static rehydrate(props: {
    id: string;
    citizenId: string;
    referenceNumber: string;
    properties?: PropertyEntry[];
  }): Registration {
    return new Registration(
      props.id,
      props.citizenId,
      props.referenceNumber,
      props.properties ?? [],
    );
  }
}
