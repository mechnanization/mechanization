'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { useToast } from '@/components/ui/toast';
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
export const DEFAULT_HORIZONTAL_BLOCKS = 6;

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
  onStructureTypeChange,
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
  /**
   * Raised when painting a second unit turns a «منزل مستقل» into a building.
   *
   * Optional so a read-only or single-purpose host can leave the
   * classification alone; without it the matrix still paints the unit and
   * simply does not reclassify, which is the honest behaviour for a caller
   * that does not own `structureType`.
   */
  onStructureTypeChange?: (next: StructureType) => void;
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
  const toast = useToast();

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

  /**
   * The type a freshly painted block opens with.
   *
   * `defaultUnitTypeFor` answers "what does a unit of this *structure* usually
   * hold", which is the right question for the second block onward and the
   * wrong one for the first. The first block on an empty grid has no building
   * around it yet — it is the whole structure so far — and the type that
   * describes that is «منزل مستقل».
   *
   * Above ground only. A lone block painted on B1 is a basement of something,
   * never a house, and `defaultUnitTypeFor` already returns مستودع for any
   * negative floor.
   */
  const firstUnitTypeFor = (floor: number): UnitType =>
    units.length === 0 && floor >= 0
      ? 'INDEPENDENT_HOUSE'
      : defaultUnitTypeFor(structureType, floor);

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
          unitType: firstUnitTypeFor(current.floor),
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

  /**
   * Keeps `structureType` honest about what is painted on the grid.
   *
   * Both directions, because both are reachable now that a lone block can be
   * typed «منزل مستقل»:
   *
   * - One block, typed as a house → the structure *is* that house. A matrix
   *   holding a single منزل مستقل inside a «مبنى سكني» contradicts itself, and
   *   the fee category and the census figures read the structure type, not the
   *   unit.
   * - A second block appears → whatever it is, a flat upstairs or a كراج
   *   beside it, the thing on the parcel is no longer a house. Leaving it as
   *   INDEPENDENT_HOUSE files a two-unit structure as a single-family home.
   *
   * Converted rather than refused, in both directions. The officer is looking
   * at the building and we are not; a form that blocked the second unit would
   * be telling them they are wrong about what they can see. Announced rather
   * than silent, for the same reason — it changes a classification they chose.
   */
  const reconcileStructureType = (next: GridUnitDraft[]) => {
    const sole = next.length === 1 ? next[0] : null;

    if (sole?.unitType === 'INDEPENDENT_HOUSE' && structureType !== 'INDEPENDENT_HOUSE') {
      onStructureTypeChange?.('INDEPENDENT_HOUSE');
      toast.info(en ? 'Reclassified as a house' : 'أُعيد تصنيف المنشأة إلى منزل مستقل', {
        description: en
          ? 'The matrix holds one unit and it is an independent house, so the structure type was updated to match.'
          : 'المصفوفة تضم وحدة واحدة نوعها منزل مستقل، فحُدِّث نوع المنشأة ليطابقها.',
      });
      return;
    }

    if (next.length > 1 && structureType === 'INDEPENDENT_HOUSE') {
      onStructureTypeChange?.('RESIDENTIAL_BUILDING');
      toast.info(en ? 'Reclassified as a building' : 'أُعيد تصنيف المنشأة إلى مبنى', {
        description: en
          ? 'An independent house holds one unit. A second one makes this a building, so its structure type was updated.'
          : 'المنزل المستقل وحدة واحدة. بإضافة وحدة ثانية أصبحت المنشأة مبنى، وحُدِّث نوعها تلقائياً.',
      });
    }
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
      const next = [...units, draft];
      onUnitsChange(next);
      reconcileStructureType(next);
    } else if (panel.clientId) {
      const next = units.map((unit) =>
        unit.clientId === panel.clientId
          ? { ...unit, unitType: panel.unitType, startCol: panel.startCol, endCol: panel.endCol }
          : unit,
      );
      onUnitsChange(next);
      reconcileStructureType(next);
    }
    setPanel(null);
  };

  /** The lone block a house is drawn as, or nothing once there are two. */
  const soleUnit = units.length === 1 ? units[0] : null;

  /**
   * Whether the unit the panel is on would be the matrix's only one.
   *
   * `create` counts the units already painted; `edit` excludes the unit being
   * edited from that count, since it is the one in question rather than a
   * neighbour of it.
   */
  const panelIsSoleUnit = panel
    ? panel.mode === 'create'
      ? units.length === 0
      : units.filter((unit) => unit.clientId !== panel.clientId).length === 0
    : false;

  /**
   * What the type list offers, which is not the same list everywhere.
   *
   * `BUILDING_UNIT_TYPES` is «what a مبنى can contain», and it subtracts
   * `INDEPENDENT_HOUSE` for a good reason: a block of twelve flats does not
   * contain a منزل مستقل, and offering it there invites a floor plan that
   * contradicts itself.
   *
   * One block on its own is the case that reason does not cover. There is no
   * building around it to be a unit *of* — the block is the whole structure,
   * and «منزل مستقل» is what that structure is. Filing it as a شقة records a
   * flat in a building nobody entered, which is what the structure type, the
   * census figures and the fee category all then read.
   *
   * So the type appears exactly while it is true, and disappears the moment a
   * second unit makes it false — at which point `confirmPanel` has already
   * reclassified the structure to a building.
   */
  const panelUnitTypes: readonly UnitType[] = panelIsSoleUnit
    ? ['INDEPENDENT_HOUSE', ...BUILDING_UNIT_TYPES]
    : BUILDING_UNIT_TYPES;

  /**
   * Widens the grid by one column if it has to, then opens the create panel on
   * the block immediately to the right of the only unit — pre-set to «كراج»,
   * which is what an annexe beside a house nearly always is and is now a unit
   * type of its own rather than a warehouse standing in for one.
   */
  const addAdjacentUnit = () => {
    if (!soleUnit) return;
    const target = soleUnit.endCol + 1;
    if (target > colsCount) {
      if (target > MAX_HORIZONTAL_BLOCKS) return;
      onGridSizeChange(target);
    }
    setPanel({
      mode: 'create',
      floor: soleUnit.floor,
      startCol: target,
      endCol: target,
      unitType: 'GARAGE',
    });
  };

  const deletePanelUnit = () => {
    if (panel?.clientId) {
      const next = units.filter((unit) => unit.clientId !== panel.clientId);
      onUnitsChange(next);
      // Deleting back down to one unit is the same question in reverse — a
      // matrix that is now a single منزل مستقل describes a house again.
      reconcileStructureType(next);
    }
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
      {/* ── Header with Matrix Dimensions ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
        <div className="max-w-sm space-y-1">
          <p className="text-xs text-muted-foreground leading-snug">
            {en
              ? 'Drag across blocks to paint a unit, or tap to place and adjust its size. Click any unit to edit or delete.'
              : 'اسحب عبر الخانات لتحديد وحدة، أو انقر لإضافتها وتعديل حجمها. انقر أي وحدة لتعديلها أو حذفها.'}
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
          Matrix Dimensions Controls.

          A grid with equal columns rather than a wrapping flex row, so the
          three boxes are the same width instead of each shrinking to its own
          label — «تحت الأرض (B):» is shorter than «عمودي (الطوابق):», and
          content-sized boxes made three controls that do the same kind of job
          look like three unrelated ones. Each is `justify-between` inside, so
          the steppers line up in a column too.

          `sm:grid-cols-3` only: below that they stack, and a stacked full-width
          row is already uniform.
        */}
        <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
          {/* Vertical / Floors */}
          <div className="flex items-center justify-between gap-1.5 rounded-lg border bg-background/80 p-1 px-2 shadow-2xs">
            <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">
              {en ? 'Vertical (Floors):' : 'عمودي (الطوابق):'}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => requestVerticalChange(safeFloorsCount - 1)}
                disabled={safeFloorsCount <= MIN_VERTICAL_BLOCKS || safeFloorsCount <= minFloorsAllowed}
                aria-label={en ? 'Fewer floors' : 'إنقاص الطوابق'}
              >
                <Minus className="size-3" />
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
                className="h-6 w-11 text-center font-mono text-xs font-semibold px-1 py-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                dir="ltr"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => requestVerticalChange(safeFloorsCount + 1)}
                disabled={safeFloorsCount >= MAX_VERTICAL_BLOCKS}
                aria-label={en ? 'More floors' : 'زيادة الطوابق'}
              >
                <Plus className="size-3" />
              </Button>
            </div>
          </div>

          {/* Below ground / Basements */}
          <div className="flex items-center justify-between gap-1.5 rounded-lg border bg-background/80 p-1 px-2 shadow-2xs">
            <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">
              {en ? 'Below ground (B):' : 'تحت الأرض (B):'}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => requestBasementChange(safeBasementsCount - 1)}
                disabled={
                  safeBasementsCount <= MIN_BASEMENT_BLOCKS ||
                  safeBasementsCount <= minBasementsAllowed
                }
                aria-label={en ? 'Fewer basements' : 'إنقاص الطوابق تحت الأرض'}
              >
                <Minus className="size-3" />
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
                className="h-6 w-11 text-center font-mono text-xs font-semibold px-1 py-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                dir="ltr"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => requestBasementChange(safeBasementsCount + 1)}
                disabled={safeBasementsCount >= MAX_BASEMENT_BLOCKS}
                aria-label={en ? 'More basements' : 'زيادة الطوابق تحت الأرض'}
              >
                <Plus className="size-3" />
              </Button>
            </div>
          </div>

          {/* Horizontal / Columns */}
          <div className="flex items-center justify-between gap-1.5 rounded-lg border bg-background/80 p-1 px-2 shadow-2xs">
            <span className="text-[11px] font-medium text-muted-foreground whitespace-nowrap">
              {en ? 'Horizontal (Cols):' : 'أفقي (الأعمدة):'}
            </span>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => requestHorizontalChange(colsCount - 1)}
                disabled={colsCount <= MIN_HORIZONTAL_BLOCKS || colsCount <= minColsAllowed}
                aria-label={en ? 'Fewer columns' : 'إنقاص الأعمدة'}
              >
                <Minus className="size-3" />
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
                className="h-6 w-11 text-center font-mono text-xs font-semibold px-1 py-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                dir="ltr"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                onClick={() => requestHorizontalChange(colsCount + 1)}
                disabled={colsCount >= MAX_HORIZONTAL_BLOCKS}
                aria-label={en ? 'More columns' : 'زيادة الأعمدة'}
              >
                <Plus className="size-3" />
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

      {/*
        «إضافة كراج / ملحق» — the one-block case, made reachable.

        A house is drawn as a single block on a one-column grid, and the way to
        put a garage beside it was to work out that the *columns* control had to
        be widened first, then drag on the block that appeared. Nobody works
        that out while standing in front of the house. This does both steps.

        Shown only while the grid holds exactly one unit, which is what makes it
        unambiguous where "beside" is: there is one block, and the new one goes
        to its right. Painting it triggers the reclassification in
        `confirmPanel` like any other second unit.
      */}
      {soleUnit ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 p-2.5 text-xs">
          <span className="text-muted-foreground">
            {en
              ? 'Need a garage or an annexe beside it?'
              : 'هل يوجد كراج أو ملحق بجانبها؟'}
          </span>
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-[11px]" onClick={addAdjacentUnit}>
            <Plus className="size-3" />
            {en ? 'Add adjacent unit' : 'إضافة وحدة ملاصقة'}
          </Button>
        </div>
      ) : null}

      {/* ── Mobile Scroll & Unit Count Hint ── */}
      <div className="sm:hidden flex items-center justify-between text-[11px] text-muted-foreground px-0.5">
        <span>{en ? 'Scroll horizontally for more columns →' : 'مرّر أفقياً لعرض باقي الخانات ←'}</span>
        <span className="font-mono">{units.length} {en ? 'units' : 'وحدة'}</span>
      </div>

      {/* ── Compact Grid Container with Fixed/Max Height ── */}
      <div dir="ltr" className="overflow-x-auto max-h-[360px] sm:max-h-[420px] overflow-y-auto rounded-xl border border-border/80 bg-muted/10 p-2 sm:p-2.5">
        <div className="inline-flex flex-col gap-1 min-w-full">
          {rows.map((floor) => {
            /*
              One grid item per *unit*, not per column.

              A unit painted across three blocks used to be three buttons with
              their inner corners squared off, which is not the same picture: a
              1fr grid puts its `gap` between every item, so the three-block
              warehouse an officer drew came back as three touching-but-separate
              boxes with two hairlines through it — indistinguishable at a
              glance from three one-block units side by side. That is the one
              distinction the matrix exists to show.

              Spanning a single element over the columns instead removes the
              gaps inside the unit (a `gap` applies between items, never within
              one) and gives the label one box to be centred in, rather than
              centring it in the first block of three.

              Empty cells stay one element per column: they are the drag
              target, and `startSelection` needs a `data-col` per block.
            */
            const cells: ReactNode[] = [];
            for (let col = 1; col <= colsCount; ) {
              const unit = unitAt(floor, col);

              if (!unit) {
                const isPendingCell =
                  pending?.floor === floor && col >= pending.startCol && col <= pending.endCol;
                const thisCol = col;
                cells.push(
                  <button
                    key={`empty-${thisCol}`}
                    type="button"
                    data-cell
                    data-floor={floor}
                    data-col={thisCol}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      startSelection(floor, thisCol);
                    }}
                    className={cn(
                      'relative h-9 sm:h-10 touch-none select-none rounded-[4px] border text-[9px] font-semibold leading-none transition-colors',
                      isPendingCell
                        ? 'border-primary bg-primary/15'
                        : 'border-border/70 bg-background hover:bg-muted/60 cursor-pointer',
                    )}
                  />,
                );
                col += 1;
                continue;
              }

              // Clamped, because a unit may have been painted wider than the
              // grid the officer has since narrowed to — it is listed as
              // stranded elsewhere rather than drawn outside the matrix.
              const start = Math.max(unit.startCol, 1);
              const end = Math.min(unit.endCol, colsCount);
              const span = Math.max(1, end - start + 1);
              const palette = PALETTE[unit.colorIndex % PALETTE.length];

              cells.push(
                <button
                  key={`unit-${unit.clientId}`}
                  type="button"
                  data-cell
                  data-floor={floor}
                  data-col={start}
                  style={{ gridColumn: `span ${span} / span ${span}` }}
                  title={[unit.unitCode, labels.unitType[unit.unitType]]
                    .filter(Boolean)
                    .join(' — ')}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    startSelection(floor, start);
                  }}
                  onClick={() => openEdit(unit)}
                  className={cn(
                    'relative h-9 sm:h-10 touch-none select-none cursor-pointer rounded-[4px] border border-transparent ring-1 px-1 transition-colors',
                    palette?.bg,
                    palette?.text,
                    palette?.ring,
                  )}
                >
                  {/* Centred across the whole merged rectangle. The type name
                      is what an officer reads the floor plan by; the code is
                      shown once it exists, since a standing flat is known by
                      it. Both are truncated rather than wrapped — a two-line
                      label would push the row taller than its neighbours. */}
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-px overflow-hidden px-0.5 text-center">
                    <span className="max-w-full truncate text-[9px] font-bold leading-tight">
                      {unit.unitCode ?? labels.unitType[unit.unitType]}
                    </span>
                    {unit.unitCode && span > 1 ? (
                      <span className="max-w-full truncate text-[8px] font-medium leading-tight opacity-80">
                        {labels.unitType[unit.unitType]}
                      </span>
                    ) : null}
                  </span>
                </button>,
              );
              col = end + 1;
            }

            return (
              <div
                key={floor}
                className={cn(
                  'flex items-center gap-1.5',
                  // The pavement, and it is red on purpose.
                  //
                  // It is the one line on the matrix that changes what a row
                  // *means* — everything below it is B1, B2, and a unit painted
                  // one row too low is a flat recorded in a basement. A dashed
                  // grey rule read as another gridline; this does not.
                  floor === 0 &&
                    safeBasementsCount > 0 &&
                    'border-b-2 border-destructive pb-1.5',
                )}
              >
                <span
                  className={cn(
                    'sticky left-0 z-10 w-16 sm:w-20 shrink-0 text-end text-[10px] sm:text-[11px] font-medium tabular-nums px-1.5 py-0.5 rounded shadow-2xs select-none bg-card/95 dark:bg-muted/95 backdrop-blur-xs',
                    floor < 0 ? 'font-mono text-destructive/80' : 'text-muted-foreground',
                  )}
                >
                  {floorLabel(floor, en)}
                </span>
                <div
                  className="grid flex-1 gap-1"
                  style={{ gridTemplateColumns: `repeat(${colsCount}, minmax(1.5rem, 1fr))` }}
                >
                  {cells}
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
          {/* Derived from what is actually painted rather than from
              `BUILDING_UNIT_TYPES`. That list excludes «منزل مستقل» — correctly,
              as a list of what a building contains — so counting against it
              silently omitted the one-block house from its own tally. */}
          {[...new Set(units.map((unit) => unit.unitType))].map((type) => {
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
                  {panelUnitTypes.map((type) => (
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
