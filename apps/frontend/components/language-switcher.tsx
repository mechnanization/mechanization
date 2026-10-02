'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Globe, Languages } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export interface LanguageSwitcherProps {
  currentLocale?: string;
  variant?: 'dropdown' | 'toggle';
  className?: string;
}

const LANGUAGES = [
  { code: 'ar', label: 'العربية', dir: 'rtl', short: 'عربي' },
  { code: 'en', label: 'English', dir: 'ltr', short: 'EN' },
] as const;

export function LanguageSwitcher({
  currentLocale = 'ar',
  variant = 'dropdown',
  className,
}: LanguageSwitcherProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLocaleChange = (newLocale: string) => {
    if (newLocale === currentLocale) return;

    // Set cookie for persistence across tabs and sessions (1 year)
    document.cookie = `NEXT_LOCALE=${newLocale}; path=/; max-age=31536000; SameSite=Lax`;

    if (!pathname) return;

    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      // Path format: /[tenant]/[locale]/...
      const tenant = segments[0];
      const rest = segments.slice(2).join('/');
      const targetUrl = `/${tenant}/${newLocale}${rest ? `/${rest}` : ''}`;
      router.push(targetUrl);
    } else {
      router.refresh();
    }
  };

  if (variant === 'toggle') {
    const nextLang = currentLocale === 'ar' ? 'en' : 'ar';
    const label = currentLocale === 'ar' ? 'Switch to English' : 'التبديل إلى العربية';

    /*
      A globe and the language it switches to, in two letters. The full word
      «English» was the widest thing in the bar on a phone; a globe alone was
      a guess for staff who do not know the convention. «EN» / «ع» names the
      destination at a glance and still fits. The full sentence is the
      tooltip and the accessible name.
    */
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => handleLocaleChange(nextLang)}
        className={cn('shrink-0 gap-1 px-2', className)}
        title={label}
        aria-label={label}
      >
        <Globe className="size-4" aria-hidden />
        <span aria-hidden className="text-xs font-semibold">
          {nextLang === 'en' ? 'EN' : 'ع'}
        </span>
      </Button>
    );
  }

  const active = LANGUAGES.find((l) => l.code === currentLocale) ?? LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('gap-1.5 px-2.5 font-medium', className)}
          aria-label={currentLocale === 'ar' ? 'اختر اللغة' : 'Select language'}
        >
          <Languages className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-xs">{active.short}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[8rem]">
        <DropdownMenuRadioGroup
          value={currentLocale}
          onValueChange={handleLocaleChange}
        >
          {LANGUAGES.map((lang) => (
            <DropdownMenuRadioItem
              key={lang.code}
              value={lang.code}
              className="cursor-pointer text-xs"
            >
              {lang.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
