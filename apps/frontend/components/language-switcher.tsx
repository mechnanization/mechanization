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
      A globe and nothing else. The bar it sits in also carries the menu, the
      breadcrumb, the bell and the account, and on a phone the word «English»
      was the widest thing in it. What the button does is in its tooltip and
      its accessible name.
    */
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => handleLocaleChange(nextLang)}
        className={cn('shrink-0', className)}
        title={label}
        aria-label={label}
      >
        <Globe className="size-5" aria-hidden />
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
