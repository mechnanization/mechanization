/**
 * Row actions: borderless, each on a soft wash of its own colour.
 *
 * Outlined, five icon buttons read as five identical boxes and the eye had to
 * find the icon inside each one to tell «تعديل» from «حذف». A hue per job does
 * that before the icon is read — the file in the primary colour, WhatsApp in
 * its green, editing in blue, disabling in amber, deleting in red — and without
 * the outline the row stops looking like a toolbar.
 *
 * Shared by the citizens register and the unit's occupant table, so «عرض
 * التفاصيل» and «العقارات والوحدات» look the same wherever a person is listed
 * (UX-1, PRIM-22).
 */
export const ACTION_TINT = {
  view: 'bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary',
  // Navigation, like `view`: primary is the colour of going somewhere (COL-2), not a palette violet.
  properties: 'bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary',
  whatsapp:
    'bg-success/10 text-success hover:bg-success/20 hover:text-success',
  edit: 'bg-info/10 text-info hover:bg-info/20 hover:text-info',
  disable:
    'bg-warning/10 text-warning hover:bg-warning/20 hover:text-warning',
  enable:
    'bg-success/10 text-success hover:bg-success/20 hover:text-success',
  remove: 'bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive',
} as const;
