'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Minus, Plus, Trash2 } from 'lucide-react';
import {
  getLabels,
  defaultUnitTypeFor,
  type StructureType,
  type UnitType,
} from '@mechanization/shared-schemas';
import { BUILDING_UNIT_TYPES } from '@/components/citizen/unit-fields';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { floorLabel } from './parcel-pin-picker';

export interface GridUnitDraft {
  /** Minted on confirm; carried as the created unit's id, same as the
   *  registration form's inline units — an offline save can name the row
   *  before it exists. */
  clientId: string;
  /** 0-indexed real floor — row 1 (bottom) is floor 0. */
  floor: number;
  /** 1-based column, inclusive. */
  startCol: number;
  endCol: number;
  unitType: UnitType;
  colorIndex: number;
  /**
   * The id of the `Unit` this cell already is, when the grid is editing a
   * building rather than painting a new one. Absent means "created on save".
   */
  existingId?: string;
  /** Its server-derived code, so an existing cell names itself on the grid. */
  unitCode?: string;
  /**
   * Why the census will not let this unit be removed — an occupancy, a visit,
   * a damage assessment or a citizen's card naming it. Set only for units the
   * grid already holds, and the reason is shown rather than the delete button.
   */
  undeletableReason?: string;
}

export const MIN_HORIZONTAL_BLOCKS = 1;
/** The column ceiling `upsertUnitSchema` stores — a painted span above it
 *  would be refused server-side, so the grid never offers one. */
export const MAX_HORIZONTAL_BLOCKS = 20;
/**
 * The matrix opens 3×3, and the two halves of that are set here and in
 * `DEFAULT_VERTICAL_BLOCKS` below.
 *
 * Six columns was a guess at a wide block, and it made the common case worse:
 * a three-flat floor opened with three empty cells trailing it, which reads as
 * three flats somebody forgot to paint rather than as spare grid. A square
 * default reads as a blank canvas, which is what it is — and both dimensions
 * are one tap from anything else.
 */
export const DEFAULT_HORIZONTAL_BLOCKS = 3;

export const MIN_VERTICAL_BLOCKS = 1;
export const MAX_VERTICAL_BLOCKS = 100;
export const DEFAULT_VERTICAL_BLOCKS = 3;

export const MIN_BASEMENT_BLOCKS = 0;
/** `floorField`'s own lower bound — a deeper basement could hold no unit. */
export const MAX_BASEMENT_BLOCKS = 10;

// Backward-compatible aliases
export const MIN_GRID_SIZE = MIN_HORIZONTAL_BLOCKS;
export const MAX_GRID_SIZE = MAX_HORIZONTAL_BLOCKS;
export const DEFAULT_GRID_SIZE = DEFAULT_HORIZONTAL_BLOCKS;

/**
 * One colour per confirmed unit, not per type — two adjacent apartments need
 * to read as different units at a glance. Same 10%-wash-background +
 * weighted-text idiom as `badge.tsx`'s `soft-*` variants, for a family
 * resemblance with the rest of the app's status colouring rather than a
 * clashing new palette.
 */
const PALETTE = [
  { bg: 'bg-sky-500/15', text: 'text-sky-700 dark:text-sky-400', ring: 'ring-sky-500/50' },
  { bg: 'bg-violet-500/15', text: 'text-violet-700 dark:text-violet-400', ring: 'ring-violet-500/50' },
  { bg: 'bg-amber-500/15', text: 'text-amber-700 dark:text-amber-400', ring: 'ring-amber-500/50' },
  { bg: 'bg-emerald-500/15', text: 'text-emerald-700 dark:text-emerald-400', ring: 'ring-emerald-500/50' },
  { bg: 'bg-rose-500/15', text: 'text-rose-700 dark:text-rose-400', ring: 'ring-rose-500/50' },
  { bg: 'bg-cyan-500/15', text: 'text-cyan-700 dark:text-cyan-400', ring: 'ring-cyan-500/50' },
  { bg: 'bg-fuchsia-500/15', text: 'text-fuchsia-700 dark:text-fuchsia-400', ring: 'ring-fuchsia-500/50' },
  { bg: 'bg-orange-500/15', text: 'text-orange-700 dark:text-orange-400', ring: 'ring-orange-500/50' },
  { bg: 'bg-teal-500/15', text: 'text-teal-700 dark:text-teal-400', ring: 'ring-teal-500/50' },
  { bg: 'bg-indigo-500/15', text: 'text-indigo-700 dark:text-indigo-400', ring: 'ring-indigo-500/50' },
] as const;

/**
 * `units[].floor/unitType/startCol/endCol`, omitting `sequence` on purpose —
 * `create()` already derives it per floor from array order
 * (`buildings.service.ts`'s `usedByFloor` map), so sorting each floor's
 * confirmed units left-to-right before flattening is what makes `sequence`
 * come out as "1-based position within the floor," exactly like every other
 * unit in this codebase. `startCol`/`endCol` travel through unchanged so the
 * painted layout can be reconstructed later — see `Unit.startCol`.
 */
export function flattenGridUnits(
  units: GridUnitDraft[],
): Array<{ id: string; floor: number; unitType: UnitType; startCol: number; endCol: number }> {
  const byFloor = new Map<number, GridUnitDraft[]>();
  for (const unit of units) {
    const list = byFloor.get(unit.floor);
    if (list) list.push(unit);
    else byFloor.set(unit.floor, [unit]);
  }

  const out: Array<{
    id: string;
    floor: number;
    unitType: UnitType;
    startCol: number;
    endCol: number;
  }> = [];
  for (const [floor, floorUnits] of byFloor) {
    for (const unit of [...floorUnits].sort((a, b) => a.startCol - b.startCol)) {
      out.push({
        id: unit.clientId,
        floor,
        unitType: unit.unitType,
        startCol: unit.startCol,
        endCol: unit.endCol,
      });
    }
  }
  return out;
}

/** The furthest extent any confirmed unit currently occupies — shrinking the
 *  grid inside this would orphan painted work. `depth` is a magnitude: 2 means
 *  something is painted on B2. */
function highestOccupied(units: GridUnitDraft[]): { row: number; col: number; depth: number } {
  let row = 0;
  let col = 0;
  let depth = 0;
  for (const unit of units) {
    row = Math.max(row, unit.floor + 1);
    col = Math.max(col, unit.endCol);
    if (unit.floor < 0) depth = Math.max(depth, -unit.floor);
  }
  return { row, col, depth };
}

function cellsOverlap(a: { startCol: number; endCol: number }, col: number): boolean {
  return col >= a.startCol && col <= a.endCol;
}

interface PendingSelection {
  floor: number;
  /** Where the drag started — extension always measures from here. */
  anchorCol: number;
  startCol: number;
  endCol: number;
}

interface Panel {
  mode: 'create' | 'edit';
  floor: number;
  startCol: number;
  endCol: number;
  unitType: UnitType;
  /** Only set in edit mode. */
  clientId?: string;
}

export function UnitGridPicker({
  locale,
  structureType,
  floorsCount,
  onFloorsCountChange,
  basementsCount = 0,
  onBasementsCountChange,
  gridSize,
  onGridSizeChange,
  units,
  onUnitsChange,
}: {
  locale: string;
  structureType: StructureType;
  /** Number of floors above ground (vertical height of the matrix). */
  floorsCount: number;
  /** Callback when vertical blocks (floors) is changed in the matrix. */
  onFloorsCountChange?: (floors: number) => void;
  /**
   * How far the grid extends below ground, as a depth: 2 draws B1 and B2.
   *
   * Separate from `floorsCount` rather than folded into one signed span,
   * because that is how the building records it — see `Building.basementsCount`
   * — and because the two are two different questions an officer answers from
   * two different places: the height from the pavement, the depth from the
   * stairwell.
   */
  basementsCount?: number;
  onBasementsCountChange?: (basements: number) => void;
  /** Number of horizontal blocks (columns). */
  gridSize: number;
  onGridSizeChange: (size: number) => void;
  units: GridUnitDraft[];
  onUnitsChange: (units: GridUnitDraft[]) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);

  /**
   * The unit types this structure's blocks may be.
   *
   * `BUILDING_UNIT_TYPES` excludes «منزل مستقل» on purpose — it is what a whole
   * منزل card *is*, not a flat on the third floor of something else — and that
   * is right for every structure but one. A منزل is drawn here as a single
   * block whose type is exactly that, and with the list unwidened its own type
   * was absent from its own select: the officer opened the block and saw an
   * empty dropdown on a value nothing was wrong with, and the tally below
   * counted it as nothing at all.
   *
   * It costs nothing elsewhere. The extra entry appears only while the
   * structure is a house, and a house that gains a second block stops being one
   * — the editor asks, re-types the blocks, and this list narrows again on the
   * same commit.
   */
  const unitTypeOptions =
    structureType === 'INDEPENDENT_HOUSE'
      ? ([...BUILDING_UNIT_TYPES, 'INDEPENDENT_HOUSE'] as readonly UnitType[])
      : BUILDING_UNIT_TYPES;

  const colsCount = Math.max(MIN_HORIZONTAL_BLOCKS, gridSize || DEFAULT_HORIZONTAL_BLOCKS);
  const safeFloorsCount = Math.max(MIN_VERTICAL_BLOCKS, floorsCount || DEFAULT_VERTICAL_BLOCKS);
  const safeBasementsCount = Math.min(
    MAX_BASEMENT_BLOCKS,
    Math.max(MIN_BASEMENT_BLOCKS, basementsCount || 0),
  );

  const [verticalInput, setVerticalInput] = useState(String(safeFloorsCount));
  const [horizontalInput, setHorizontalInput] = useState(String(colsCount));
  const [basementInput, setBasementInput] = useState(String(safeBasementsCount));

  useEffect(() => {
    setVerticalInput(String(safeFloorsCount));
  }, [safeFloorsCount]);

  useEffect(() => {
    setHorizontalInput(String(colsCount));
  }, [colsCount]);

  useEffect(() => {
    setBasementInput(String(safeBasementsCount));
  }, [safeBasementsCount]);

  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const nextColor = useRef(0);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const occupied = highestOccupied(units);
  const minFloorsAllowed = Math.max(MIN_VERTICAL_BLOCKS, occupied.row);
  const minColsAllowed = Math.max(MIN_HORIZONTAL_BLOCKS, occupied.col);
  const minBasementsAllowed = Math.max(MIN_BASEMENT_BLOCKS, occupied.depth);
  /** How much of the grid is a building that already stands. */
  const existingCount = units.filter((unit) => unit.existingId).length;

  const unitAt = useCallback(
    (floor: number, col: number): GridUnitDraft | undefined =>
      units.find((unit) => unit.floor === floor && cellsOverlap(unit, col)),
    [units],
  );

  // ── Drag-to-select, via Pointer Events so mouse/touch/pen share one path ──
  useEffect(() => {
    if (!pending) return;

    const onPointerMove = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const cell = target?.closest<HTMLElement>('[data-cell]');
      if (!cell) return;
      const floor = Number(cell.dataset.floor);
      const col = Number(cell.dataset.col);
      if (floor !== pending.floor) return;

      // Extend toward the pointer, clipped at the nearest already-confirmed
      // cell so a drag can never swallow another unit.
      setPending((current) => {
        if (!current) return current;
        const anchor = current.anchorCol;
        let start = Math.min(anchor, col);
        let end = Math.max(anchor, col);

        for (let c = anchor; c <= end; c += 1) {
          if (unitAt(floor, c)) {
            end = c - 1;
            break;
          }
        }
        for (let c = anchor; c >= start; c -= 1) {
          if (unitAt(floor, c)) {
            start = c + 1;
            break;
          }
        }
        return { floor, anchorCol: anchor, startCol: start, endCol: Math.max(start, end) };
      });
    };

    const onPointerUp = () => {
      const current = pendingRef.current;
      setPending(null);
      if (current) {
        setPanel({
          mode: 'create',
          floor: current.floor,
          startCol: current.startCol,
          endCol: current.endCol,
          unitType: defaultUnitTypeFor(structureType, current.floor),
        });
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(pending), structureType, unitAt]);

  const startSelection = (floor: number, col: number) => {
    if (unitAt(floor, col)) return; // handled by onClick → edit, not a new selection
    setPending({ floor, anchorCol: col, startCol: col, endCol: col });
  };

  const openEdit = (unit: GridUnitDraft) => {
    setPanel({
      mode: 'edit',
      floor: unit.floor,
      startCol: unit.startCol,
      endCol: unit.endCol,
      unitType: unit.unitType,
      clientId: unit.clientId,
    });
  };

  const confirmPanel = () => {
    if (!panel) return;
    if (panel.mode === 'create') {
      const draft: GridUnitDraft = {
        clientId: crypto.randomUUID(),
        floor: panel.floor,
        startCol: panel.startCol,
        endCol: panel.endCol,
        unitType: panel.unitType,
        colorIndex: nextColor.current++ % PALETTE.length,
      };
      onUnitsChange([...units, draft]);
    } else if (panel.clientId) {
      onUnitsChange(
        units.map((unit) =>
          unit.clientId === panel.clientId
            ? { ...unit, unitType: panel.unitType, startCol: panel.startCol, endCol: panel.endCol }
            : unit,
        ),
      );
    }
    setPanel(null);
  };

  const deletePanelUnit = () => {
    if (panel?.clientId) onUnitsChange(units.filter((unit) => unit.clientId !== panel.clientId));
    setPanel(null);
  };

  /** Grows/shrinks the panel's own width to the right, clamped by the grid
   *  edge and the next confirmed unit on that floor. */
  const adjustPanelWidth = (delta: 1 | -1) => {
    setPanel((current) => {
      if (!current) return current;
      if (delta === -1) {
        if (current.endCol <= current.startCol) return current;
        return { ...current, endCol: current.endCol - 1 };
      }
      const nextCol = current.endCol + 1;
      if (nextCol > colsCount) return current;
      const blocked = units.some(
        (unit) =>
          unit.clientId !== current.clientId &&
          unit.floor === current.floor &&
          cellsOverlap(unit, nextCol),
      );
      if (blocked) return current;
      return { ...current, endCol: nextCol };
    });
  };

  const requestVerticalChange = (next: number) => {
    if (next < minFloorsAllowed) {
      setSizeError(
        en
          ? `Can't decrease floors below ${minFloorsAllowed} — units are already placed on floor ${minFloorsAllowed - 1}.`
          : `لا يمكن تقليل الطوابق لأقل من ${minFloorsAllowed} — توجد وحدات موضوعة على الطابق ${minFloorsAllowed - 1}.`,
      );
      return;
    }
    if (next > MAX_VERTICAL_BLOCKS || next < MIN_VERTICAL_BLOCKS) return;
    setSizeError(null);
    setVerticalInput(String(next));
    if (onFloorsCountChange) {
      onFloorsCountChange(next);
    }
  };

  const handleVerticalInputChange = (raw: string) => {
    setVerticalInput(raw);
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    if (val < minFloorsAllowed) {
      setSizeError(
        en
          ? `Can't decrease floors below ${minFloorsAllowed} — units are already placed on floor ${minFloorsAllowed - 1}.`
          : `لا يمكن تقليل الطوابق لأقل من ${minFloorsAllowed} — توجد وحدات موضوعة على الطابق ${minFloorsAllowed - 1}.`,
      );
      return;
    }
    if (val > MAX_VERTICAL_BLOCKS) {
      setSizeError(
        en
          ? `Maximum allowed floors is ${MAX_VERTICAL_BLOCKS}.`
          : `الحد الأقصى لعدد الطوابق هو ${MAX_VERTICAL_BLOCKS}.`,
      );
      return;
    }
    setSizeError(null);
    if (onFloorsCountChange) {
      onFloorsCountChange(val);
    }
  };

  const handleVerticalInputBlur = () => {
    const val = parseInt(verticalInput, 10);
    if (isNaN(val) || val < minFloorsAllowed) {
      const fallback = Math.max(minFloorsAllowed, safeFloorsCount);
      setVerticalInput(String(fallback));
      if (onFloorsCountChange) {
        onFloorsCountChange(fallback);
      }
    } else if (val > MAX_VERTICAL_BLOCKS) {
      setVerticalInput(String(MAX_VERTICAL_BLOCKS));
      if (onFloorsCountChange) {
        onFloorsCountChange(MAX_VERTICAL_BLOCKS);
      }
    } else {
      setVerticalInput(String(val));
      if (onFloorsCountChange) {
        onFloorsCountChange(val);
      }
    }
  };

  const requestBasementChange = (next: number) => {
    if (next < minBasementsAllowed) {
      setSizeError(
        en
          ? `Can't remove basement B${minBasementsAllowed} — units are already placed on it.`
          : `لا يمكن حذف القبو B${minBasementsAllowed} — توجد وحدات موضوعة عليه.`,
      );
      return;
    }
    if (next > MAX_BASEMENT_BLOCKS || next < MIN_BASEMENT_BLOCKS) return;
    setSizeError(null);
    setBasementInput(String(next));
    onBasementsCountChange?.(next);
  };

  const handleBasementInputChange = (raw: string) => {
    setBasementInput(raw);
    const value = parseInt(raw, 10);
    if (isNaN(value)) return;
    if (value < minBasementsAllowed) {
      setSizeError(
        en
          ? `Can't remove basement B${minBasementsAllowed} — units are already placed on it.`
          : `لا يمكن حذف القبو B${minBasementsAllowed} — توجد وحدات موضوعة عليه.`,
      );
      return;
    }
    if (value > MAX_BASEMENT_BLOCKS) {
      setSizeError(
        en
          ? `Maximum allowed basements is ${MAX_BASEMENT_BLOCKS}.`
          : `الحد الأقصى لعدد الطوابق تحت الأرض هو ${MAX_BASEMENT_BLOCKS}.`,
      );
      return;
    }
    setSizeError(null);
    onBasementsCountChange?.(value);
  };

  const handleBasementInputBlur = () => {
    const value = parseInt(basementInput, 10);
    const settled =
      isNaN(value) || value < minBasementsAllowed
        ? Math.max(minBasementsAllowed, safeBasementsCount)
        : Math.min(value, MAX_BASEMENT_BLOCKS);
    setBasementInput(String(settled));
    onBasementsCountChange?.(settled);
  };

  const requestHorizontalChange = (next: number) => {
    if (next < minColsAllowed) {
      setSizeError(
        en
          ? `Can't decrease columns below ${minColsAllowed} — units are already painted in column ${minColsAllowed}.`
          : `لا يمكن تقليل الأعمدة لأقل من ${minColsAllowed} — توجد وحدات موضوعة في العمود ${minColsAllowed}.`,
      );
      return;
    }
    if (next > MAX_HORIZONTAL_BLOCKS || next < MIN_HORIZONTAL_BLOCKS) return;
    setSizeError(null);
    setHorizontalInput(String(next));
    onGridSizeChange(next);
  };

  const handleHorizontalInputChange = (raw: string) => {
    setHorizontalInput(raw);
    const val = parseInt(raw, 10);
    if (isNaN(val)) return;
    if (val < minColsAllowed) {
      setSizeError(
        en
          ? `Can't decrease columns below ${minColsAllowed} — units are already painted in column ${minColsAllowed}.`
          : `لا يمكن تقليل الأعمدة لأقل من ${minColsAllowed} — توجد وحدات موضوعة في العمود ${minColsAllowed}.`,
      );
      return;
    }
    if (val > MAX_HORIZONTAL_BLOCKS) {
      setSizeError(
        en
          ? `Maximum allowed columns is ${MAX_HORIZONTAL_BLOCKS}.`
          : `الحد الأقصى لعدد الأعمدة هو ${MAX_HORIZONTAL_BLOCKS}.`,
      );
      return;
    }
    setSizeError(null);
    onGridSizeChange(val);
  };

  const handleHorizontalInputBlur = () => {
    const val = parseInt(horizontalInput, 10);
    if (isNaN(val) || val < minColsAllowed) {
      const fallback = Math.max(minColsAllowed, colsCount);
      setHorizontalInput(String(fallback));
      onGridSizeChange(fallback);
    } else if (val > MAX_HORIZONTAL_BLOCKS) {
      setHorizontalInput(String(MAX_HORIZONTAL_BLOCKS));
      onGridSizeChange(MAX_HORIZONTAL_BLOCKS);
    } else {
      setHorizontalInput(String(val));
      onGridSizeChange(val);
    }
  };

  /** Top-down, the way the building stands: the top storey first, ground in
   *  the middle, and the basements below it in increasing depth. */
  const rows = Array.from(
    { length: safeFloorsCount + safeBasementsCount },
    (_, i) => safeFloorsCount - 1 - i,
  );
  const cols = Array.from({ length: colsCount }, (_, i) => i + 1);
  /** The confirmed unit the open panel is editing, for the facts the panel
   *  itself does not carry — its code and whether it may be removed. */
  const panelUnit = panel?.clientId
    ? units.find((unit) => unit.clientId === panel.clientId)
    : undefined;
  const panelTitle = panel
    ? en
      ? `${floorLabel(panel.floor, true)} floor — ${
          panel.mode === 'edit'
            ? `${panel.endCol - panel.startCol + 1} column(s)`
            : `column ${panel.startCol}${panel.endCol > panel.startCol ? `–${panel.endCol}` : ''}`
        }`
      : `طابق ${floorLabel(panel.floor, false)} — ${
          panel.mode === 'edit'
            ? `${panel.endCol - panel.startCol + 1} خانة`
            : `الخانة ${panel.startCol}${panel.endCol > panel.startCol ? `–${panel.endCol}` : ''}`
        }`
    : '';

  return (
    <div className="space-y-3">
      {/*
        ── Header with Matrix Dimensions ──────────────────────────────────

        Stacked until `lg` rather than until `sm`.

        A tablet is the width where the old breakpoint did the most damage: the
        row went horizontal at 640px, which left the three stepper groups
        competing with a paragraph of instructions for about 300px and wrapping
        into each other. The controls now get the full width of the panel until
        there is genuinely room beside the text, which is around 1024px.
      */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
        <div className="max-w-sm space-y-1">
          <p className="text-xs text-muted-foreground leading-snug">
            {en
              ? 'Drag across blocks to paint a unit, or tap to place and adjust its size. Click any unit to edit or delete.'
              : 'اسحب عبر الخانات لتحديد وحدة، أو انقر لإضافتها وتعديل حجمها. انقر أي وحدة لتعديلها أو حذفها.'}
          </p>
          {/*
            The height and the depth are asked *here* and nowhere else.

            They used to be two number inputs on the previous step as well, and
            the duplication was the problem rather than the wording: an officer
            typed «٦» into a box on one screen and then painted five floors on
            another, and the two disagreed with nothing on either screen to say
            so. The count is a fact about the matrix, so it is asked where the
            matrix is — the steppers beside this text move the grid itself, and
            what the grid shows is what gets saved.
          */}
          <p className="text-[11px] leading-snug text-muted-foreground">
            {en
              ? 'The floor and basement counts are set here — the grid is what gets saved.'
              : 'عدد الطوابق وعدد الطوابق تحت الأرض يُحدَّدان من هنا — والمصفوفة هي ما يُحفظ.'}
          </p>
          {existingCount > 0 ? (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {en
                ? 'Cells showing a unit code are already in the census. Paint on the empty blocks to add floors or units to it.'
                : 'الخانات التي تحمل رمز وحدة مسجَّلة في سجل المباني. ارسم على الخانات الفارغة لإضافة طوابق أو وحدات جديدة.'}
            </p>
          ) : null}
        </div>

        {/*
          ── Matrix Dimensions Controls ──────────────────────────────────

          A responsive grid rather than a wrapping flex row, and the difference
          is the whole of this fix.

          Three groups of «[−] number [+]» used to wrap at whatever width ran
          out. On a tablet that produced two groups on one line and the third
          orphaned below, with the 24px steppers of one group sitting a few
          pixels from the numeric input of the next — near enough that a thumb
          aimed at «زيادة الطوابق» hit «تحت الأرض» instead, and the two adjacent
          rounded corners read as one control that had gone wrong.

          Now: one group per row, at every width. Each owns a full-width box, so
          its parts can never sit beside another group's, and the gap between
          boxes is never smaller than the gap inside one.

          Stacked rather than three-across even where there is room, because the
          three are read as a list — height, depth, width — and a row of three
          identical «[−] n [+]» clusters gives the eye nothing to tell them apart
          but a label it has to read twice. One per line, each label at the start
          of its own row, is scannable at a glance.

          The targets themselves go from `size-6` (24px) to 40px on touch
          widths, dropping back to 32px only from `lg` where a pointer is doing
          the aiming. 24px is below every touch-target guideline there is, and
          these are the controls an officer uses while standing up.
        */}
        <div className="grid w-full grid-cols-1 gap-2 lg:w-80 lg:shrink-0">
          {/* Vertical / Floors */}
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-background/80 px-2.5 py-1.5 shadow-2xs">
            <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
              {en ? 'Vertical (Floors)' : 'عمودي (الطوابق)'}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 lg:size-8"
                onClick={() => requestVerticalChange(safeFloorsCount - 1)}
                disabled={safeFloorsCount <= MIN_VERTICAL_BLOCKS || safeFloorsCount <= minFloorsAllowed}
                aria-label={en ? 'Fewer floors' : 'إنقاص الطوابق'}
              >
                <Minus className="size-4" />
              </Button>
              <Input
                type="number"
                min={MIN_VERTICAL_BLOCKS}
                max={MAX_VERTICAL_BLOCKS}
                step={1}
                inputMode="numeric"
                pattern="[0-9]*"
                value={verticalInput}
                onChange={(e) => handleVerticalInputChange(e.target.value)}
                onBlur={handleVerticalInputBlur}
                aria-label={en ? 'Number of floors' : 'عدد الطوابق'}
                className="h-10 w-12 shrink-0 px-1 py-0 text-center font-mono text-sm font-semibold [appearance:textfield] lg:h-8 lg:text-xs [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                dir="ltr"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 lg:size-8"
                onClick={() => requestVerticalChange(safeFloorsCount + 1)}
                disabled={safeFloorsCount >= MAX_VERTICAL_BLOCKS}
                aria-label={en ? 'More floors' : 'زيادة الطوابق'}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          {/* Below ground / Basements */}
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-background/80 px-2.5 py-1.5 shadow-2xs">
            <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
              {en ? 'Below ground (B)' : 'تحت الأرض (B)'}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 lg:size-8"
                onClick={() => requestBasementChange(safeBasementsCount - 1)}
                disabled={
                  safeBasementsCount <= MIN_BASEMENT_BLOCKS ||
                  safeBasementsCount <= minBasementsAllowed
                }
                aria-label={en ? 'Fewer basements' : 'إنقاص الطوابق تحت الأرض'}
              >
                <Minus className="size-4" />
              </Button>
              <Input
                type="number"
                min={MIN_BASEMENT_BLOCKS}
                max={MAX_BASEMENT_BLOCKS}
                step={1}
                inputMode="numeric"
                pattern="[0-9]*"
                value={basementInput}
                onChange={(e) => handleBasementInputChange(e.target.value)}
                onBlur={handleBasementInputBlur}
                aria-label={en ? 'Levels below ground' : 'عدد الطوابق تحت الأرض'}
                className="h-10 w-12 shrink-0 px-1 py-0 text-center font-mono text-sm font-semibold [appearance:textfield] lg:h-8 lg:text-xs [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                dir="ltr"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 lg:size-8"
                onClick={() => requestBasementChange(safeBasementsCount + 1)}
                disabled={safeBasementsCount >= MAX_BASEMENT_BLOCKS}
                aria-label={en ? 'More basements' : 'زيادة الطوابق تحت الأرض'}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          {/* Horizontal / Columns */}
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border bg-background/80 px-2.5 py-1.5 shadow-2xs">
            <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
              {en ? 'Horizontal (Cols)' : 'أفقي (الأعمدة)'}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 lg:size-8"
                onClick={() => requestHorizontalChange(colsCount - 1)}
                disabled={colsCount <= MIN_HORIZONTAL_BLOCKS || colsCount <= minColsAllowed}
                aria-label={en ? 'Fewer columns' : 'إنقاص الأعمدة'}
              >
                <Minus className="size-4" />
              </Button>
              <Input
                type="number"
                min={MIN_HORIZONTAL_BLOCKS}
                max={MAX_HORIZONTAL_BLOCKS}
                step={1}
                inputMode="numeric"
                pattern="[0-9]*"
                value={horizontalInput}
                onChange={(e) => handleHorizontalInputChange(e.target.value)}
                onBlur={handleHorizontalInputBlur}
                aria-label={en ? 'Number of columns' : 'عدد الأعمدة'}
                className="h-10 w-12 shrink-0 px-1 py-0 text-center font-mono text-sm font-semibold [appearance:textfield] lg:h-8 lg:text-xs [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                dir="ltr"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-10 shrink-0 lg:size-8"
                onClick={() => requestHorizontalChange(colsCount + 1)}
                disabled={colsCount >= MAX_HORIZONTAL_BLOCKS}
                aria-label={en ? 'More columns' : 'زيادة الأعمدة'}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {sizeError ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          {sizeError}
        </p>
      ) : null}

      {/* ── Mobile Scroll & Unit Count Hint ── */}
      <div className="sm:hidden flex items-center justify-between text-[11px] text-muted-foreground px-0.5">
        <span>{en ? 'Scroll horizontally for more columns →' : 'مرّر أفقياً لعرض باقي الخانات ←'}</span>
        <span className="font-mono">{units.length} {en ? 'units' : 'وحدة'}</span>
      </div>

      {/*
        ── Compact Grid Container with Fixed/Max Height ──────────────────

        `overscroll-x-contain` so a horizontal swipe that runs out of grid does
        not turn into a back-navigation gesture on the tablet browsers that map
        one to the other. Painting a unit is a drag, and a drag that overshoots
        the last column used to leave the page.
      */}
      <div dir="ltr" className="overflow-x-auto overscroll-x-contain max-h-[360px] sm:max-h-[420px] overflow-y-auto rounded-xl border border-border/80 bg-muted/10 p-2 sm:p-2.5">
        {/*
          `inline-flex` with `min-w-full`, and both halves are load-bearing.

          `min-w-full` is what makes the matrix fill the panel when it is
          narrower than the box — so this is already the "fill the width" half,
          without stretching any cell beyond its share.

          `inline-flex` is what lets it grow *past* the box when twenty columns
          do not fit, so the rows span the whole scrollable width rather than
          being clipped at the viewport edge. A plain `flex` would cap every row
          at 100% of the scroll port, and the ground floor's pavement rule —
          the dashed border that separates the basements from everything above
          them — would stop dead in the middle of the grid on any building wide
          enough to scroll.
        */}
        <div className="inline-flex min-w-full flex-col gap-1.5">
          {rows.map((floor) => {
            return (
              <div
                key={floor}
                className={cn(
                  'flex items-center gap-2',
                  // The pavement. Drawn under the ground-floor row so the
                  // basements below it read as below it, rather than as three
                  // more storeys whose labels happen to start with a B.
                  floor === 0 &&
                    safeBasementsCount > 0 &&
                    'border-b-2 border-dashed border-border pb-1.5',
                )}
              >
                {/*
                  The frozen floor gutter — and `pointer-events-none` on it.

                  It is `sticky`, so on a grid wider than the viewport it slides
                  over the leftmost cells as the officer scrolls. That is the
                  standard frozen-column behaviour and it is wanted: a matrix
                  whose floor labels scroll away is a matrix you cannot read.
                  What was not wanted is that a `<span>` sitting on top of a
                  column of buttons *swallowed their taps* — an officer trying to
                  paint the first column of a scrolled grid tapped the label,
                  nothing happened, and nothing on screen explained why.

                  A label has no behaviour of its own, so it has no business
                  intercepting a pointer. With this, the only thing it does is
                  be legible.

                  Opaque rather than `/95` + blur for the same reason: a cell
                  half-visible through a translucent label reads as two controls
                  overlapping, which is exactly what it must not look like now
                  that one of them is unreachable there.
                */}
                <span
                  className={cn(
                    'pointer-events-none sticky left-0 z-10 w-14 sm:w-20 shrink-0 text-end text-[10px] sm:text-[11px] font-medium tabular-nums px-1.5 py-1 rounded shadow-2xs select-none bg-card dark:bg-muted',
                    floor < 0 ? 'font-mono text-foreground/70' : 'text-muted-foreground',
                  )}
                >
                  {floorLabel(floor, en)}
                </span>
                {/*
                  `minmax(2.25rem, 1fr)` rather than `1.5rem`.

                  24px was below every touch-target guideline there is, and these
                  cells are dragged across by somebody standing in a stairwell
                  with a tablet. 36px is the smallest that can be hit reliably;
                  twenty of them still fit inside 800px, so the widest grid the
                  picker can produce is no more scroll-bound on a tablet than it
                  was before. `gap-1.5` separates them by 6px so two adjacent
                  cells cannot be caught by one thumb.
                */}
                <div
                  className="grid flex-1 gap-1.5"
                  style={{ gridTemplateColumns: `repeat(${colsCount}, minmax(2.25rem, 1fr))` }}
                >
                  {cols.map((col) => {
                    const unit = unitAt(floor, col);
                    const isPendingCell =
                      pending?.floor === floor && col >= pending.startCol && col <= pending.endCol;
                    const isStart = unit?.startCol === col;
                    const isEnd = unit?.endCol === col;
                    const palette = unit ? PALETTE[unit.colorIndex % PALETTE.length] : null;

                    return (
                      <button
                        key={col}
                        type="button"
                        data-cell
                        data-floor={floor}
                        data-col={col}
                        title={
                          unit
                            ? [unit.unitCode, labels.unitType[unit.unitType]]
                                .filter(Boolean)
                                .join(' — ')
                            : undefined
                        }
                        onPointerDown={(event) => {
                          event.preventDefault();
                          startSelection(floor, col);
                        }}
                        onClick={() => {
                          if (unit) openEdit(unit);
                        }}
                        className={cn(
                          /*
                            A fixed height, and deliberately not `aspect-square`.

                            Square cells sound right for a grid and behave badly
                            in one: the columns are `1fr`, so on a wide screen a
                            three-column matrix gave each cell a third of the
                            panel — some four hundred pixels — and
                            `aspect-square` made it four hundred tall to match.
                            Three floors then needed twelve hundred pixels in a
                            box capped at four hundred, so the officer was handed
                            a viewport onto one and a half cells and had to
                            scroll a 3×3 grid. The fewer the columns, the worse
                            it got, which is exactly backwards.

                            Height is now the thing that is fixed and width is
                            the thing that flexes, so the matrix fills its box
                            across and fits down it: nine floors sit inside the
                            same cap that used to hold one and a half.

                            44px at the small end is the touch-target floor the
                            tablet pass set, and it is the same shape the
                            read-only matrix on the ledger page already draws
                            (`MATRIX_ROW_HEIGHT`) — a floor is a horizontal strip
                            divided into units, which is what a building
                            elevation actually looks like.
                          */
                          'relative h-11 touch-none select-none rounded-[4px] border text-[10px] font-semibold leading-none transition-colors sm:h-12',
                          !unit && !isPendingCell &&
                            'border-border/70 bg-background hover:bg-muted/60 cursor-pointer',
                          isPendingCell && !unit && 'border-primary bg-primary/15',
                          unit &&
                            cn(
                              'cursor-pointer border-transparent ring-1',
                              palette?.bg,
                              palette?.text,
                              palette?.ring,
                            ),
                          unit && isStart && 'rounded-s-[4px]',
                          unit && !isStart && 'rounded-s-none border-s-0',
                          unit && isEnd && 'rounded-e-[4px]',
                          unit && !isEnd && 'rounded-e-none',
                        )}
                      >
                        {unit && isStart ? (
                          <span className="absolute inset-0 flex items-center justify-center truncate px-0.5 text-[9px] font-bold">
                            {unit.unitCode ?? labels.unitType[unit.unitType].slice(0, 2)}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Compact Surveyed Units Tally ── */}
      {units.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-border/40 text-xs">
          <span className="text-muted-foreground font-medium text-[11px]">
            {en ? 'Units Summary:' : 'ملخص الوحدات:'}
          </span>
          <Badge variant="secondary" className="font-mono text-[10px] h-5 px-2">
            {units.length} {en ? 'Total' : 'إجمالي'}
          </Badge>
          {/* Only where the two kinds coexist — on a new building every cell is
              new, and saying so on all of them says nothing. */}
          {existingCount > 0 && units.length > existingCount ? (
            <Badge variant="soft-success" className="text-[10px] h-5 px-2 gap-1 font-normal">
              <span>{en ? 'New on save:' : 'تُضاف عند الحفظ:'}</span>
              <span className="font-semibold font-mono">{units.length - existingCount}</span>
            </Badge>
          ) : null}
          {unitTypeOptions.map((type) => {
            const count = units.filter((u) => u.unitType === type).length;
            if (count === 0) return null;
            return (
              <Badge key={type} variant="outline" className="text-[10px] h-5 px-2 gap-1 font-normal">
                <span>{labels.unitType[type]}:</span>
                <span className="font-semibold font-mono">{count}</span>
              </Badge>
            );
          })}
        </div>
      ) : null}

      {/* ── Sheet for unit creation & editing ── */}
      <Sheet
        open={Boolean(panel)}
        onClose={() => setPanel(null)}
        title={panelTitle}
      >
        {panel ? (
          <div className="space-y-4">
            {panelUnit?.existingId ? (
              <p className="rounded-md border bg-muted/30 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                {en
                  ? `Unit ${panelUnit.unitCode ?? ''} is already in the census. Changes here are saved against it rather than creating a second unit.`
                  : `الوحدة ${panelUnit.unitCode ?? ''} مسجَّلة في سجل المباني. يُحفظ التعديل عليها ولا تُنشأ وحدة ثانية.`}
              </p>
            ) : null}

            <Field label={en ? 'Unit Type' : 'نوع الوحدة'} htmlFor="grid-unit-type" required>
              <Select
                value={panel.unitType}
                onValueChange={(value) =>
                  setPanel((current) => (current ? { ...current, unitType: value as UnitType } : current))
                }
              >
                <SelectTrigger id="grid-unit-type" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {unitTypeOptions.map((type) => (
                    <SelectItem key={type} value={type}>
                      {labels.unitType[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label={en ? 'Width (columns)' : 'العرض (خانات)'} htmlFor="grid-unit-width">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => adjustPanelWidth(-1)}
                  disabled={panel.endCol <= panel.startCol}
                  aria-label={en ? 'Narrower' : 'أضيق'}
                >
                  <Minus className="size-3.5" />
                </Button>
                <span className="w-10 text-center font-mono text-sm font-semibold" dir="ltr">
                  {panel.endCol - panel.startCol + 1}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-8"
                  onClick={() => adjustPanelWidth(1)}
                  disabled={
                    panel.endCol >= colsCount ||
                    units.some(
                      (u) =>
                        u.clientId !== panel.clientId &&
                        u.floor === panel.floor &&
                        cellsOverlap(u, panel.endCol + 1),
                    )
                  }
                  aria-label={en ? 'Wider' : 'أوسع'}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </Field>

            <div className="flex items-center gap-2 pt-2">
              <Button type="button" onClick={confirmPanel} className="flex-1 h-9">
                {panel.mode === 'edit' ? (en ? 'Save changes' : 'حفظ التعديل') : en ? 'Add unit' : 'إضافة الوحدة'}
              </Button>
              {panel.mode === 'edit' ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={deletePanelUnit}
                  disabled={Boolean(panelUnit?.undeletableReason)}
                  title={panelUnit?.undeletableReason}
                  className="h-9 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={en ? 'Delete unit' : 'حذف الوحدة'}
                >
                  <Trash2 className="size-4" />
                </Button>
              ) : (
                <Button type="button" variant="outline" className="h-9" onClick={() => setPanel(null)}>
                  {en ? 'Cancel' : 'إلغاء'}
                </Button>
              )}
            </div>

            {panelUnit?.undeletableReason ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {panelUnit.undeletableReason}
              </p>
            ) : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
