import type { MatchLight } from '@/lib/landlord-status';
import { cn } from '@/lib/utils';

/**
 * One match light — a dot in the light's colour and its word beside it, never
 * the colour alone (COL-3). Said the same way on the «روابط المالكين» table and
 * on «فحص الرابط», for the name and for the phone (`nameLight`, `phoneLight`).
 */
export function MatchLightLabel({ light, className }: { light: MatchLight; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)}>
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          light.tone === 'success' && 'bg-success',
          light.tone === 'warning' && 'bg-warning',
          light.tone === 'destructive' && 'bg-destructive',
          light.tone === 'muted' && 'bg-muted-foreground/50',
        )}
      />
      <span
        className={cn(
          'font-medium',
          light.tone === 'success' && 'text-success',
          light.tone === 'warning' && 'text-warning',
          light.tone === 'destructive' && 'text-destructive',
          light.tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {light.label}
      </span>
    </span>
  );
}
