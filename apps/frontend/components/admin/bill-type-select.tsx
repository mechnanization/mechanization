'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronsUpDown,
  FileText,
  Plus,
  Receipt,
  Search,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

/** Normalizes Arabic text (removes tashkeel, standardizes hamzas and taa marbouta). */
function normalizeArabic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

/**
  * Autocomplete selector for creating a bill (IssueFeeDialog / ChargeCitizenDialog).
  * Staff can pick from previously created bill types or type any new bill name.
  */
export function BillTypeSelect({
  value,
  onChange,
  locale = 'ar',
  placeholder,
  id,
  required,
  disabled,
  autoFocus,
  existingTitles = [],
}: {
  value: string;
  onChange: (val: string) => void;
  locale?: string;
  placeholder?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  existingTitles?: string[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const generatedId = useId();
  const inputId = id ?? generatedId;

  const isEnglish = locale === 'en';

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearch('');
    }
  }, [isOpen]);

  const normSearch = normalizeArabic(search);

  const filteredTitles = useMemo(() => {
    if (!normSearch) return existingTitles;
    return existingTitles.filter((t) => normalizeArabic(t).includes(normSearch));
  }, [existingTitles, normSearch]);

  const exactMatch = useMemo(() => {
    if (!search.trim()) return false;
    const clean = normalizeArabic(search.trim());
    return existingTitles.some((t) => normalizeArabic(t) === clean);
  }, [search, existingTitles]);

  const handleSelect = (title: string) => {
    onChange(title);
    setIsOpen(false);
  };

  const defaultPlaceholder = isEnglish
    ? 'Select or type a bill title…'
    : 'اختر أو اكتب اسم الرسم / الفاتورة…';

  return (
    <div ref={containerRef} className="relative w-full">
      <button
        type="button"
        id={inputId}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          'flex h-10 w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-2 text-start text-sm shadow-xs transition-colors',
          'hover:bg-accent/40 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          disabled && 'cursor-not-allowed opacity-50',
          isOpen && 'ring-2 ring-ring ring-offset-2 border-primary',
        )}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-required={required}
      >
        <span className="flex items-center gap-2 truncate">
          <Receipt className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {value ? (
            <span className="font-semibold text-foreground truncate">{value}</span>
          ) : (
            <span className="text-muted-foreground truncate">{placeholder || defaultPlaceholder}</span>
          )}
        </span>

        <div className="flex items-center gap-1.5 shrink-0 ms-2">
          {value ? (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onChange('');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onChange('');
                }
              }}
              title={isEnglish ? 'Clear' : 'مسح'}
              className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            >
              <X className="size-3.5" />
            </span>
          ) : null}
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </div>
      </button>

      {isOpen ? (
        <div
          role="listbox"
          className="absolute z-50 mt-1.5 w-full rounded-xl border border-border/80 bg-popover p-2 text-popover-foreground shadow-2xl backdrop-blur-md outline-hidden max-h-[20rem] flex flex-col overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100"
        >
          {/* Search / Type input */}
          <div className="relative mb-2 shrink-0">
            <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && search.trim()) {
                  e.preventDefault();
                  handleSelect(search.trim());
                } else if (e.key === 'Escape') {
                  setIsOpen(false);
                }
              }}
              placeholder={
                isEnglish
                  ? 'Search existing bill or type new name…'
                  : 'ابحث في الرسوم السابقة أو اكتب اسماً جديداً…'
              }
              className="w-full rounded-lg border border-border/70 bg-muted/40 ps-9 pe-8 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary focus:bg-background transition-all"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute end-2 top-1/2 -translate-y-1/2 flex size-4 items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>

          {/* Quick Option to use custom typed name if not exact match */}
          {search.trim() && !exactMatch ? (
            <div className="mb-2 shrink-0 border-b border-border/50 pb-2">
              <button
                type="button"
                onClick={() => handleSelect(search.trim())}
                className="flex w-full items-center gap-2 rounded-lg bg-primary/10 px-2.5 py-2 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors text-start cursor-pointer border border-primary/20"
              >
                <Plus className="size-4 shrink-0" />
                <span className="truncate">
                  {isEnglish ? `Use "${search.trim()}"` : `استخدام «${search.trim()}»`}
                </span>
              </button>
            </div>
          ) : null}

          {/* List of previously created bills in this municipality */}
          <div className="flex-1 overflow-y-auto divide-y divide-border/30 pe-1 space-y-1">
            {filteredTitles.length === 0 ? (
              <div className="py-5 text-center text-xs text-muted-foreground">
                <FileText className="mx-auto size-5 mb-1.5 text-muted-foreground/60" />
                <p>
                  {existingTitles.length === 0
                    ? (isEnglish ? 'No previously created bills. Type any new title above and press Enter.' : 'لا توجد رسوم سابقة. اكتب اسم الرسم أعلاه واضغط Enter.')
                    : (isEnglish ? 'No matching previous bill titles.' : 'لا توجد رسوم سابقة مطابقة.')}
                </p>
                {search.trim() ? (
                  <p className="mt-1 text-xs text-foreground font-semibold">
                    {isEnglish ? 'Press Enter to use your typed title.' : 'اضغط Enter لاعتماد الاسم المكتوب.'}
                  </p>
                ) : null}
              </div>
            ) : (
              filteredTitles.map((title) => {
                const isSelected = value === title;
                return (
                  <button
                    key={title}
                    type="button"
                    onClick={() => handleSelect(title)}
                    className={cn(
                      'group flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-start transition-all cursor-pointer',
                      isSelected
                        ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                        : 'hover:bg-accent hover:text-accent-foreground text-foreground',
                    )}
                  >
                    <span className="text-xs truncate">{title}</span>
                    {isSelected ? (
                      <Check className="size-4 shrink-0 text-primary-foreground" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Filter dropdown with search bar for the Fees & Billing table.
 * Shows ONLY actual bills created in this municipality.
 */
export function BillTypeFilter({
  value,
  onChange,
  locale = 'ar',
  existingTitles = [],
}: {
  value: string;
  onChange: (val: string) => void;
  locale?: string;
  existingTitles?: string[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const isEnglish = locale === 'en';

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 50);
    } else {
      setSearch('');
    }
  }, [isOpen]);

  const normSearch = normalizeArabic(search);

  const filteredTitles = useMemo(() => {
    if (!normSearch) return existingTitles;
    return existingTitles.filter((t) => normalizeArabic(t).includes(normSearch));
  }, [existingTitles, normSearch]);

  const handleSelect = (title: string) => {
    onChange(title);
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative inline-block text-start">
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/80 bg-card px-2.5 text-xs font-semibold shadow-2xs transition-all cursor-pointer',
          value
            ? 'border-primary/50 bg-primary/10 text-primary font-bold'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          isOpen && 'ring-2 ring-primary/40',
        )}
      >
        <Receipt className="size-3.5" />
        <span>
          {value
            ? (isEnglish ? `Type: ${value}` : `نوع الرسم: ${value}`)
            : (isEnglish ? 'All Bill Types' : 'كل أنواع الرسوم')}
        </span>
        {value ? (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            title={isEnglish ? 'Clear filter' : 'إلغاء التصفية'}
            className="flex size-4 items-center justify-center rounded-full hover:bg-primary/20 ms-0.5"
          >
            <X className="size-3" />
          </span>
        ) : (
          <ChevronsUpDown className="size-3 opacity-60" />
        )}
      </button>

      {isOpen ? (
        <div className="absolute end-0 z-50 mt-1.5 w-64 rounded-xl border border-border/80 bg-popover p-2 text-popover-foreground shadow-2xl backdrop-blur-md outline-hidden max-h-80 flex flex-col overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100">
          <div className="relative mb-2 shrink-0">
            <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isEnglish ? 'Search created bills…' : 'ابحث في الرسوم المنشأة…'}
              className="w-full rounded-md border border-border/70 bg-muted/40 ps-8 pe-7 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-1 focus:ring-primary focus:bg-background transition-all"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute end-2 top-1/2 -translate-y-1/2 flex size-3.5 items-center justify-center text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-border/30 pe-0.5 space-y-1">
            {/* All Types option */}
            <button
              type="button"
              onClick={() => handleSelect('')}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs text-start transition-all cursor-pointer',
                !value
                  ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                  : 'hover:bg-accent text-foreground',
              )}
            >
              <span>{isEnglish ? 'All Bill Types' : 'كل أنواع الرسوم'}</span>
              {!value ? <Check className="size-3.5 shrink-0" /> : null}
            </button>

            {/* List of actual bills created */}
            {filteredTitles.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">
                <p>{isEnglish ? 'No matching bills found.' : 'لا توجد رسوم مطابقة.'}</p>
              </div>
            ) : (
              filteredTitles.map((title) => {
                const isSelected = value === title;
                return (
                  <button
                    key={title}
                    type="button"
                    onClick={() => handleSelect(title)}
                    className={cn(
                      'flex w-full items-center justify-between gap-1.5 rounded-md px-2 py-1.5 text-xs text-start transition-all cursor-pointer',
                      isSelected
                        ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                        : 'hover:bg-accent text-foreground',
                    )}
                  >
                    <span className="truncate flex-1">{title}</span>
                    {isSelected ? <Check className="size-3.5 shrink-0" /> : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}