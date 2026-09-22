import { useEffect, useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { getLabels, staffPasswordPairSchema } from '@mechanization/shared-schemas';
import type { StaffSummary } from '@/lib/api-client';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ACCOUNTANT',
  'ADMINISTRATIVE_OFFICER',
] as const;

export interface StaffFormValues {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  confirmPassword: string;
  role: string;
}

const EMPTY: StaffFormValues = {
  firstName: '',
  lastName: '',
  email: '',
  password: '',
  confirmPassword: '',
  role: 'FIELD_INSPECTOR',
};

export function StaffForm({
  open,
  editing,
  submitting,
  error,
  onOpenChange,
  onSubmit,
  locale = 'ar',
}: {
  open: boolean;
  /** null = creating. */
  editing: StaffSummary | null;
  submitting: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: StaffFormValues) => void;
  locale?: string;
}) {
  const labels = getLabels(locale);

  const [values, setValues] = useState<StaffFormValues>(EMPTY);
  const [showPassword, setShowPassword] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTouched(false);
    setShowPassword(false);
    setValues(
      editing
        ? {
            firstName: editing.firstName,
            lastName: editing.lastName,
            email: editing.email,
            password: '',
            confirmPassword: '',
            role: editing.role,
          }
        : EMPTY,
    );
  }, [open, editing]);

  const set = (patch: Partial<StaffFormValues>) =>
    setValues((previous) => ({ ...previous, ...patch }));

  const wantsPassword = values.password.length > 0 || values.confirmPassword.length > 0;
  const passwordCheck =
    !editing || wantsPassword
      ? staffPasswordPairSchema.safeParse({
          password: values.password,
          confirmPassword: values.confirmPassword,
        })
      : null;

  const passwordError =
    touched && passwordCheck && !passwordCheck.success
      ? (passwordCheck.error.issues.find((issue) => issue.path[0] === 'password')?.message ??
        null)
      : null;
  const confirmError =
    touched && passwordCheck && !passwordCheck.success
      ? (passwordCheck.error.issues.find((issue) => issue.path[0] === 'confirmPassword')
          ?.message ?? null)
      : null;

  const complete =
    values.firstName.trim().length >= 2 &&
    values.lastName.trim().length >= 2 &&
    values.email.trim().length > 3 &&
    (passwordCheck ? passwordCheck.success : true);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={locale === 'en' ? 'Close' : 'إغلاق'} className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 space-y-1 border-b p-6 text-start">
          <DialogTitle>
            {editing
              ? (locale === 'en' ? 'Edit Staff Account' : 'تعديل حساب موظف')
              : (locale === 'en' ? 'Add Staff Member' : 'إضافة موظف')}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? (locale === 'en'
                  ? 'Leave password fields empty to keep current password.'
                  : 'اترك حقلي كلمة المرور فارغين للإبقاء على كلمة المرور الحالية.')
              : (locale === 'en'
                  ? 'Staff member will use email and password to log in to the municipality dashboard.'
                  : 'يستخدم الموظف بريده الإلكتروني وكلمة المرور للدخول إلى لوحة البلدية.')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {error ? (
            <Alert tone="error">
              {error}
            </Alert>
          ) : null}

          <div className="grid gap-5">
            <Field label={locale === 'en' ? 'First Name' : 'الاسم الأول'} htmlFor="firstName" required>
              <Input
                id="firstName"
                value={values.firstName}
                onChange={(event) => set({ firstName: event.target.value })}
              />
            </Field>
            <Field label={locale === 'en' ? 'Last Name' : 'الشهرة'} htmlFor="lastName" required>
              <Input
                id="lastName"
                value={values.lastName}
                onChange={(event) => set({ lastName: event.target.value })}
              />
            </Field>
          </div>

          <Field label={locale === 'en' ? 'Email Address' : 'البريد الإلكتروني'} htmlFor="email" required>
            <Input
              id="email"
              type="email"
              dir="ltr"
              autoComplete="off"
              className="text-start"
              value={values.email}
              onChange={(event) => set({ email: event.target.value })}
            />
          </Field>

          <Field
            label={locale === 'en' ? 'Password' : 'كلمة المرور'}
            htmlFor="password"
            required={!editing}
            error={passwordError ?? undefined}
          >
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                className="pe-11"
                invalid={Boolean(passwordError)}
                value={values.password}
                onChange={(event) => {
                  setTouched(true);
                  set({ password: event.target.value });
                }}
              />
              <button
                type="button"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-label={
                  showPassword
                    ? (locale === 'en' ? 'Hide password' : 'إخفاء كلمة المرور')
                    : (locale === 'en' ? 'Show password' : 'إظهار كلمة المرور')
                }
                aria-pressed={showPassword}
                className="absolute inset-y-0 end-0 flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              >
                {showPassword ? (
                  <EyeOff className="size-5" aria-hidden />
                ) : (
                  <Eye className="size-5" aria-hidden />
                )}
              </button>
            </div>
          </Field>

          <Field
            label={locale === 'en' ? 'Confirm Password' : 'تأكيد كلمة المرور'}
            htmlFor="confirmPassword"
            required={!editing}
            error={confirmError ?? undefined}
          >
            <Input
              id="confirmPassword"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              invalid={Boolean(confirmError)}
              value={values.confirmPassword}
              onChange={(event) => {
                setTouched(true);
                set({ confirmPassword: event.target.value });
              }}
            />
          </Field>

          <Field
            label={locale === 'en' ? 'Role & Permissions' : 'الصلاحية'}
            htmlFor="role"
            required
          >
            <Select value={values.role} onValueChange={(next) => set({ role: next })}>
              <SelectTrigger id="role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((role) => (
                  <SelectItem key={role} value={role}>
                    {labels.staffRole?.[role as never] ?? role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t p-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {locale === 'en' ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            disabled={!complete || submitting}
            onClick={() => {
              setTouched(true);
              onSubmit(values);
            }}
          >
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {editing
              ? (locale === 'en' ? 'Save Changes' : 'حفظ التعديلات')
              : (locale === 'en' ? 'Create Account' : 'إنشاء الحساب')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
