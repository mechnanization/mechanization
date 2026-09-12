-- 0038_unit_block_span
--
-- «موقعها في المصفوفة» — where a unit sat on the grid it was painted on.
--
-- == What was being computed and thrown away ===============================
--
-- The building-creation wizard lets an officer paint units onto an N×N grid:
-- drag across four adjacent blocks for a warehouse, two for an apartment
-- beside it. `unit-grid-picker.tsx` tracks exactly that — a 1-based, inclusive
-- column range per unit — right up until the moment it builds the request
-- this create sends, where it sorts by that range to work out `sequence` and
-- then discards it. The floor plan the officer just drew existed for the
-- length of one function call and nowhere after.
--
-- That is fine as long as nothing downstream needs to look like the floor
-- again. It stops being fine the moment a matrix is reopened for review: a
-- ground floor of four shops and a floor above it of two-block flats has to
-- be recognisable as that shape again, not four-of-something and
-- two-of-something-else laid out with no memory of which blocks were which.
--
-- == Why both columns, and why nullable ====================================
--
-- `startCol`/`endCol` rather than a single "width," because a unit's position
-- matters as much as its size — two 2-wide units on one floor are not
-- interchangeable, and a gap between them (nothing painted there) is not the
-- same as them being adjacent.
--
-- Nullable with no default and no backfill: every unit created before this
-- column existed, and every one the blueprint generator or the single-add
-- form creates afterward, genuinely has no grid it was painted on. Null says
-- exactly that, and the matrix view renders such a unit as one default-width
-- block rather than guessing a span that was never drawn.
--
-- Written unqualified: the migrator sets `search_path` to the target tenant
-- schema before running this.

ALTER TABLE "units"
  ADD COLUMN IF NOT EXISTS "startCol" INTEGER,
  ADD COLUMN IF NOT EXISTS "endCol" INTEGER;
