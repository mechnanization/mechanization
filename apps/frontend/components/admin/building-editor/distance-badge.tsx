import { Badge } from '@/components/ui/badge';
import { NEAR_DUPLICATE_METRES } from './constants';

/**
 * «على بُعد ٤ م» beside a structure already on the parcel.
 *
 * Three honest states: measured and close, measured and not, and not
 * measurable — which says what would make it measurable, because the one fix
 * available to the officer is dropping their own pin.
 */
export function DistanceBadge({
  metres,
  hasPin,
  en,
}: {
  metres: number | null;
  hasPin: boolean;
  en: boolean;
}) {
  if (metres == null) {
    return (
      <Badge variant="soft-muted" className="text-xs">
        {hasPin
          ? en
            ? 'distance unknown — it has no pin'
            : 'المسافة غير معروفة — لا مدخل مثبت لها'
          : en
            ? 'drop the entrance pin to see the distance'
            : 'ثبِّت دبوس المدخل لمعرفة المسافة'}
      </Badge>
    );
  }
  const near = metres < NEAR_DUPLICATE_METRES;
  const formatted = metres.toLocaleString(en ? 'en' : 'ar');
  return (
    <Badge variant={near ? 'soft-destructive' : 'soft-warning'} className="text-xs font-semibold">
      {en
        ? `${formatted} m away${near ? ' — very close' : ''}`
        : `على بُعد ${formatted} م${near ? ' — قريبة جداً' : ''}`}
    </Badge>
  );
}
