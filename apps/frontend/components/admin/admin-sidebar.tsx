'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import {
  activeNavItem,
  localizedGroupLabel,
  localizedLabel,
  visibleGroups,
  type NavItem,
} from '@/components/admin/nav';
import { cn } from '@/lib/utils';

const COLLAPSE_STORAGE_KEY = 'mechanization.sidebar.collapsed';
const GROUPS_STORAGE_KEY = 'mechanization.sidebar.groups';

/**
 * Which nav groups are folded away.
 *
 * A module-level store rather than `useState` inside `SidebarNav`, because that
 * component is mounted twice at once: the rail is `hidden lg:flex`, so it stays
 * in the DOM behind the drawer rather than unmounting. Two independent copies
 * of this state means folding «الأرض» in the drawer on a tablet, then rotating
 * to landscape, reveals a rail that never heard about it.
 *
 * Folded labels are stored rather than open ones so that a group added to
 * `NAV_GROUPS` later starts open — the state is a set of exceptions, and the
 * default is the useful one.
 */
const NO_GROUPS_FOLDED: ReadonlySet<string> = new Set<string>();
let foldedGroups: ReadonlySet<string> = NO_GROUPS_FOLDED;
let readFromStorage = false;
const foldListeners = new Set<() => void>();

function subscribeFolds(listener: () => void): () => void {
  foldListeners.add(listener);
  return () => {
    foldListeners.delete(listener);
  };
}

/**
 * Hydrate once, on the first mount. The stored folds cannot be known while
 * rendering on the server, so every group starts open and corrects itself here
 * — the same trade the rail's own collapsed width makes below.
 */
function hydrateFolds(): void {
  if (readFromStorage) return;
  readFromStorage = true;
  try {
    const raw = localStorage.getItem(GROUPS_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    foldedGroups = new Set(parsed.filter((entry): entry is string => typeof entry === 'string'));
    for (const listener of foldListeners) listener();
  } catch {
    /* default: every group open */
  }
}

function setGroupFolded(label: string, folded: boolean): void {
  // `<details onToggle>` fires on mount as well as on a real click, so without
  // this guard every page load rewrites storage and re-renders both instances
  // for no change.
  if (foldedGroups.has(label) === folded) return;
  const next = new Set(foldedGroups);
  if (folded) next.add(label);
  else next.delete(label);
  foldedGroups = next;
  try {
    localStorage.setItem(GROUPS_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    /* the fold still holds for this page load */
  }
  for (const listener of foldListeners) listener();
}

function useFoldedGroups(): ReadonlySet<string> {
  useEffect(hydrateFolds, []);
  return useSyncExternalStore(
    subscribeFolds,
    () => foldedGroups,
    () => NO_GROUPS_FOLDED,
  );
}

/**
 * The navigation rail.
 *
 * It used to be the whole of the admin chrome — it also carried the theme
 * toggle, the language switch and sign-out in its footer, because there was no
 * header to put them in. There is one now (`AdminHeader`), and those three
 * belong to the person rather than to the section list, so they moved there
 * and this is navigation only.
 *
 * It also used to be a plain flex child that was always on screen at 256px,
 * with no breakpoint anywhere in it. On a 390px phone that left 134px for the
 * page — a table rendered into a gutter. Below `lg` this is no longer mounted
 * as a rail at all: `AdminShell` renders the same `SidebarNav` in a drawer.
 *
 * `lg` rather than the `md` a marketing site would use. The content beside it
 * is a wide RTL data table; at 768px a 256px rail leaves 512px, which is not
 * enough for one and turns every table into a horizontal scroll hunt. A tablet
 * gets the full width and reaches navigation through the drawer.
 */
export function AdminSidebar({
  tenant,
  locale,
  adminPath,
  role,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  role: string | undefined;
}) {
  const base = `/${tenant}/${locale}/${adminPath}`;
  const [collapsed, setCollapsed] = useState(false);

  // Read on mount only. The rail's stored width cannot be known while
  // rendering on the server, so it starts expanded and corrects itself here.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_STORAGE_KEY) === 'true');
    } catch {
      /* default: expanded */
    }
  }, []);

  function toggleCollapsed(): void {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      } catch {
        /* the toggle still works for this page load */
      }
      return next;
    });
  }

  return (
    <aside
      className={cn(
        'hidden h-screen shrink-0 flex-col border-e bg-card transition-[width] duration-200 lg:flex',
        collapsed ? 'w-[72px]' : 'w-64',
      )}
    >
      {/* h-14 matches the header beside it, so the rail's rule and the
          header's are one continuous line across the top of the app. */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5 border-b px-4',
          collapsed && 'justify-center px-2',
        )}
      >
        {!collapsed ? (
          <>
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center">
              <img src="/logo.png" alt="" className="size-9 object-contain" />
            </span>
            <p className="min-w-0 flex-1 truncate text-sm font-semibold">
              {locale === 'en' ? 'Municipality Portal' : 'لوحة البلدية'}
            </p>
          </>
        ) : null}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed
            ? (locale === 'en' ? 'Expand sidebar' : 'إظهار الشريط الجانبي')
            : (locale === 'en' ? 'Collapse sidebar' : 'طي الشريط الجانبي')}
          title={collapsed
            ? (locale === 'en' ? 'Expand sidebar' : 'إظهار الشريط الجانبي')
            : (locale === 'en' ? 'Collapse sidebar' : 'طي الشريط الجانبي')}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {collapsed ? <PanelLeftOpen className="size-5" /> : <PanelLeftClose className="size-5" />}
        </button>
      </div>

      <SidebarNav base={base} role={role} collapsed={collapsed} locale={locale} />
    </aside>
  );
}

/**
 * The grouped link list itself, shared by the desktop rail and the mobile
 * drawer so the two can never drift.
 *
 * `onNavigate` is how the drawer closes on a tap: the rail passes nothing, the
 * drawer passes its close handler. Doing it here rather than with a
 * route-change effect inside the drawer means the panel starts closing on the
 * press instead of after the next page has resolved — on a slow connection,
 * the difference between a responsive tap and one that looks ignored.
 */
export function SidebarNav({
  base,
  role,
  collapsed = false,
  locale = 'ar',
  onNavigate,
}: {
  base: string;
  role: string | undefined;
  collapsed?: boolean;
  locale?: string;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const groups = visibleGroups(role);
  const active = activeNavItem(pathname, base, role);
  const folded = useFoldedGroups();

  /*
   * A folded group never hides where you actually are.
   *
   * Keyed on the group label rather than on the pathname, so this fires on a
   * real section change and not on every navigation within one — which is what
   * lets a clerk fold the group they are standing in and have it stay folded
   * until they leave it.
   */
  const activeGroupLabel = groups.find((group) =>
    group.items.some((item) => item.path === active?.path),
  )?.label;
  useEffect(() => {
    if (activeGroupLabel) setGroupFolded(activeGroupLabel, false);
  }, [activeGroupLabel]);

  const renderItems = useCallback(
    (items: NavItem[]) => (
      <div className="space-y-0.5">
        {items.map((item) => {
          const href = `${base}${item.path}`;
          const isActive = active?.path === item.path;
          const Icon = item.icon;
          const itemLabel = localizedLabel(item, locale);
          return (
            <Link
              key={item.path}
              href={href}
              onClick={onNavigate}
              aria-current={isActive ? 'page' : undefined}
              title={collapsed ? itemLabel : undefined}
              className={cn(
                // 44px tall below `lg` rather than the rail's 36: in the
                // drawer these are thumb targets, not cursor targets.
                'flex items-center gap-2.5 rounded-md px-2.5 py-2.5 text-sm transition-colors lg:py-2',
                collapsed && 'justify-center px-0',
                // A tinted row rather than a solid primary bar: with ten of
                // these stacked, a filled block is the loudest thing on the
                // page and pulls the eye off the content it introduces.
                isActive
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Icon className="size-[18px] shrink-0" />
              {!collapsed ? <span className="truncate">{itemLabel}</span> : null}
            </Link>
          );
        })}
      </div>
    ),
    [active?.path, base, collapsed, locale, onNavigate],
  );

  return (
    <nav className="flex-1 space-y-4 overflow-y-auto p-3">
      {groups.map((group) => {
        /* Folded to the icon rail, a heading is a word floating in 72px — the
           divider carries the grouping instead. There is no heading left to
           fold against, so the group stays open. */
        if (collapsed) {
          return (
            <div key={group.label ?? 'landing'}>
              <div aria-hidden className="mx-auto mb-2 h-px w-6 bg-border first:hidden" />
              {renderItems(group.items)}
            </div>
          );
        }

        /*
          The landing rows carry no heading, so there is nothing to fold them
          against and no <details> around them — just the rows, then a rule
          separating them from the first real section. A group that cannot be
          folded is the point here: these are where the role lands, and a clerk
          who folded them away would have hidden their own front door.
        */
        if (!group.label) {
          return (
            <div key="landing">
              {renderItems(group.items)}
              <div aria-hidden className="mx-2 mt-3 h-px bg-border" />
            </div>
          );
        }

        // Captured: the guard above narrows 'group.label' here, but that
        // narrowing does not survive into the toggle handler's closure.
        const label = group.label;
        const isFolded = folded.has(label);
        const holdsActive = group.items.some((item) => item.path === active?.path);

        return (
          /*
           * `<details>` rather than a `useState` toggle and a hand-paired
           * `aria-expanded` button, matching `CollapsibleSection`: browser
           * find-in-page can open a folded group to reveal a match, the summary
           * is keyboard operable with no `tabIndex` of ours, and — the reason
           * it matters here specifically — the links inside a folded group
           * leave the tab order without us tracking `inert` by hand.
           */
          <details
            key={label}
            open={!isFolded}
            onToggle={(event) => setGroupFolded(label, !event.currentTarget.open)}
            className="group/nav"
          >
            <summary
              className={cn(
                'flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1.5',
                'text-xs font-semibold tracking-wider text-muted-foreground',
                'transition-colors hover:bg-accent/50 hover:text-foreground',
                // Safari still paints its own disclosure triangle without this.
                '[&::-webkit-details-marker]:hidden',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{localizedGroupLabel(group, locale)}</span>
              {/* The one thing a folded group must still say: your current
                  section is in here. Without it, folding «السجل» while on the
                  dashboard leaves nothing on screen saying where you are. */}
              {isFolded && holdsActive ? (
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
              ) : null}
              <ChevronDown
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-open/nav:rotate-180 motion-reduce:transition-none"
              />
            </summary>

            {/* `grid-rows-[0fr]` → `[1fr]` animates a panel whose height nobody
                has measured. The inner `min-h-0 overflow-hidden` is required:
                without it the child refuses to shrink below its content height
                and the animation does nothing at all. */}
            <div
              className={cn(
                'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
                isFolded ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="pt-0.5">{renderItems(group.items)}</div>
              </div>
            </div>
          </details>
        );
      })}
    </nav>
  );
}
