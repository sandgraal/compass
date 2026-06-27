# People

**Route:** `/people` · **Sidebar:** People

A unified directory of everyone who appears across your imported data — derived, not entered. People
collapses the **same person seen in different exports** into a single entry, so "your network" stops being
scattered across a dozen files.

## Where it comes from

People is a pure projection over the [Timeline](Storehouse-and-Timeline) `records` plus your
[Contacts](Storehouse-and-Timeline#storehouse-overview-storehouse) (`electron/lib/people.ts`), with **no
new table**. It reads the high-precision, people-bearing records and matches `contacts` by normalized name:

- **LinkedIn** — connections, invitations, recommendations, endorsements.
- **Facebook** — friends.
- **PayPal** — payees (the transaction counterparty).
- **Messages** — iMessage / Facebook / LinkedIn conversation partners ("N messages with X").

An `isLikelyPerson` classifier drops merchants, newsletters, group threads, and bare phone numbers so the
list stays *people*, not noise. *(Venmo and email senders are deferred — both are ambiguous to attribute.)*

## What you see

Each entry shows the person's name, the **sources** they appear in, their **touchpoint count**, and
**first/last seen** dates. Rows deep-link to `/timeline?q=<name>` — one click pivots to everything that
person appears in across your whole life log. The Timeline seeds its search from `?q=`.

## Related

- [Storehouse & Timeline](Storehouse-and-Timeline) — the records this is derived from.
- [Knowledge Base](Knowledge-Base) — `profile/relationships.md` is regenerated from Contacts.
