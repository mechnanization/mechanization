/** A heading over a group of the transfer form's fields (BAN-4, TYP-5). */
export function FormSection({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="border-b pb-1.5 text-xs font-semibold text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}
