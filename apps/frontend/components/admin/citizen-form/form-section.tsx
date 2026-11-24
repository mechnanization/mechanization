import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * One titled section of the form.
 */
export function FormSection({
  id,
  step,
  icon: Icon,
  title,
  description,
  invalid,
  children,
}: {
  id: string;
  step: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  invalid: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card
      id={id}
      data-section-invalid={invalid || undefined}
      className={cn(
        'review-group scroll-mt-24 rounded-xl border border-border/80 bg-card shadow-2xs overflow-hidden',
        invalid && 'border-destructive/50 ring-1 ring-destructive/20',
      )}
    >
      <CardHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/60 bg-muted/10 px-4 py-3 sm:px-5">
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20"
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-foreground">
            <span
              aria-hidden
              className="rounded bg-muted px-1.5 py-0.5 text-xs font-semibold text-muted-foreground font-mono"
            >
              {step}
            </span>
            {title}
          </h2>
          {description ? <p className="text-xs text-muted-foreground mt-0.5">{description}</p> : null}
        </div>
      </CardHeader>
      <CardContent className="review-body p-4 sm:p-5">{children}</CardContent>
    </Card>
  );
}
