// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { TimePicker } from '@/components/ui/time-picker';
import { DayTimeFields } from '@/components/admin/news/day-time-fields';
import en from '../messages/en.json';

/*
  U-8 (decided 2026-11-25): the kit's time field, driven as a keyboard drives it. A native time input kept
  its own segments; this one is text, so what matters is what a person typing meets: the colon put in, a half
  time not erased when the owner echoes `''` back, a time tidied when the field is left, an arrow that steps,
  and the digits an Arabic keyboard types. The rules themselves are tabled in `time-input.test.ts`.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

let container: HTMLDivElement;
let root: Root;
/** Everything the owner was told, in order. */
let told: string[];
/** What the owner holds: it echoes what it is told, as a form's state does. */
let held: () => string;

function Owner({ initial = '', ...rest }: { initial?: string } & Partial<Parameters<typeof TimePicker>[0]>): React.JSX.Element {
  const [value, setValue] = useState(initial);
  held = () => value;
  return createElement(TimePicker, {
    id: 'time',
    ...rest,
    value,
    onChange: (next: string) => {
      told.push(next);
      setValue(next);
    },
  });
}

const input = () => container.querySelector<HTMLInputElement>('#time')!;

async function mount(props: Parameters<typeof Owner>[0] = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(Owner, props));
  });
}

/** One keystroke: the field's text with `char` appended, as the browser reports it. */
async function type(chars: string): Promise<void> {
  for (const char of chars) {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input(), input().value + char);
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}
async function press(key: string, shiftKey = false): Promise<void> {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });
}
async function leave(): Promise<void> {
  await act(async () => {
    input().focus();
    input().blur();
    input().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

beforeEach(() => {
  told = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('what the field is', () => {
  it('is a left-to-right numeric text field of five characters, with the placeholder HH:MM', async () => {
    await mount();
    expect(input().type).toBe('text');
    expect(input().getAttribute('dir')).toBe('ltr');
    expect(input().getAttribute('inputmode')).toBe('numeric');
    expect(input().maxLength).toBe(5);
    expect(input().placeholder).toBe('HH:MM');
    expect(input().getAttribute('autocomplete')).toBe('off');
  });

  it('shows the value it is given, and takes a new one from outside', async () => {
    await mount({ initial: '14:30' });
    expect(input().value).toBe('14:30');
    await act(async () => {
      root.render(createElement(TimePicker, { id: 'time', value: '08:15', onChange: vi.fn() }));
    });
    expect(input().value).toBe('08:15');
  });

  it('passes the caller’s verdict, its label and its description through', async () => {
    await mount({ invalid: true, 'aria-label': 'Publish time', 'aria-describedby': 'why' });
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-label')).toBe('Publish time');
    expect(input().getAttribute('aria-describedby')).toBe('why');
  });

  it('can be disabled', async () => {
    await mount({ disabled: true });
    expect(input().disabled).toBe(true);
  });
});

describe('typing', () => {
  it('puts the colon in as the time is typed: 9, 3, 0 is 09:30', async () => {
    await mount();
    await type('9');
    expect(input().value).toBe('9');
    await type('3');
    expect(input().value).toBe('09:3');
    await type('0');
    expect(input().value).toBe('09:30');
    expect(held()).toBe('09:30');
  });

  it('tells its owner only a complete time, and nothing while it is half-typed', async () => {
    await mount();
    await type('0930');
    expect(told).toEqual(['', '', '', '09:30']);
  });

  it('is not erased by its owner echoing the empty half time back, mid-keystroke', async () => {
    await mount();
    await type('19');
    // The owner holds '' (the time is not complete), and the field still shows what was typed.
    expect(held()).toBe('');
    expect(input().value).toBe('19');
    await type('3');
    expect(input().value).toBe('19:3');
    await type('0');
    expect(held()).toBe('19:30');
  });

  it('keeps what is left when a character is deleted from a complete time, though its owner now holds nothing', async () => {
    await mount({ initial: '19:30' });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '19:3');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    // The owner's value went from 19:30 to '' (the time is not complete), and the field did not follow it.
    expect(held()).toBe('');
    expect(input().value).toBe('19:3');
    await type('5');
    expect(input().value).toBe('19:35');
    expect(held()).toBe('19:35');
  });

  it('reads the digits an Arabic keyboard types as Latin ones', async () => {
    await mount();
    await type('٠٩');
    await type(':');
    await type('٣٠');
    expect(input().value).toBe('09:30');
    expect(held()).toBe('09:30');
  });

  it('drops what is not a digit or a colon', async () => {
    await mount();
    await type('a1b4');
    expect(input().value).toBe('14');
  });

  it('can be cleared by deleting, and then tells its owner nothing', async () => {
    await mount({ initial: '09:30' });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input(), '');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input().value).toBe('');
    expect(held()).toBe('');
  });
});

describe('leaving the field', () => {
  it.each([
    ['9', '09:00'],
    ['930', '09:30'],
    ['9:30', '09:30'],
  ])('tidies "%s" into %s and tells its owner', async (typed, tidy) => {
    await mount();
    await type(typed);
    await leave();
    expect(input().value).toBe(tidy);
    expect(held()).toBe(tidy);
  });

  it('leaves something that is not a time as it was pasted, marked invalid, and tells its owner nothing', async () => {
    await mount();
    // Typed key by key, 25 cannot be an hour and reads as 02:5; an out-of-range time arrives by paste.
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), '24:00');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await leave();
    expect(input().value).toBe('24:00');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(held()).toBe('');
    expect(told.every((text) => text === '')).toBe(true);
  });

  it('reads a 25 typed key by key as 02:5, then 02:55, since no hour is 25', async () => {
    await mount();
    await type('2550');
    expect(input().value).toBe('02:55');
    await type('0');
    expect(held()).toBe('02:55');
  });

  it('marks 9:5 invalid rather than guessing 09:05 or 09:50', async () => {
    await mount();
    await type('9:5');
    await leave();
    expect(input().value).toBe('9:5');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(held()).toBe('');
  });

  it('clears the mark as soon as the person types again', async () => {
    await mount();
    await type('9:5');
    await leave();
    await type('0');
    expect(input().value).toBe('9:50');
    expect(input().getAttribute('aria-invalid')).toBeNull();
  });

  it('leaves an empty field empty and unmarked', async () => {
    await mount();
    await leave();
    expect(input().value).toBe('');
    expect(input().getAttribute('aria-invalid')).toBeNull();
    expect(told).toEqual([]);
  });
});

describe('the arrows', () => {
  it('step by five minutes, snapping to the grid, and tell the owner each time', async () => {
    await mount({ initial: '14:32' });
    await press('ArrowUp');
    expect(held()).toBe('14:35');
    await press('ArrowUp');
    expect(held()).toBe('14:40');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(held()).toBe('14:30');
    expect(input().value).toBe('14:30');
  });

  it('step an hour with Shift, and wrap past midnight', async () => {
    await mount({ initial: '23:30' });
    await press('ArrowUp', true);
    expect(held()).toBe('00:00');
    await press('ArrowDown', true);
    expect(held()).toBe('23:00');
  });

  it('open an empty field on 09:00, or on the start the caller names', async () => {
    await mount();
    await press('ArrowUp');
    expect(held()).toBe('09:00');
    act(() => root.unmount());
    root = createRoot(container);
    told = [];
    await mount({ startAt: '12:00' });
    await press('ArrowDown');
    expect(held()).toBe('12:00');
  });

  it('use the step the caller names', async () => {
    await mount({ initial: '10:00', step: 15 });
    await press('ArrowUp');
    expect(held()).toBe('10:15');
  });

  it('are prevented from moving the page or the caret, and other keys are left alone', async () => {
    await mount({ initial: '10:00' });
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true });
    await act(async () => void input().dispatchEvent(arrow));
    expect(arrow.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    await act(async () => void input().dispatchEvent(other));
    expect(other.defaultPrevented).toBe(false);
  });
});

describe('where it stands in the News fields (U-8)', () => {
  it('replaces the native time input in the day-and-time fields, which still tell their owner HH:MM', async () => {
    const onTime = vi.fn();
    await act(async () => {
      root.render(
        createElement(NextIntlClientProvider, {
          locale: 'en',
          messages: en as never,
          children: createElement(DayTimeFields, {
            idPrefix: 'sched',
            locale: 'en',
            day: '2026-12-03',
            time: '',
            dayLabel: 'Day',
            timeLabel: 'Time',
            onDay: vi.fn(),
            onTime,
          }),
        }),
      );
    });
    const field = container.querySelector<HTMLInputElement>('#sched-time')!;
    expect(field.type).toBe('text');
    expect(container.querySelector('input[type="time"]')).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '1430');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onTime).toHaveBeenLastCalledWith('14:30');
  });

  it('is the only way a time is typed in the app: no native time input is left', () => {
    for (const file of ['components/admin/news/day-time-fields.tsx', 'components/admin/settings/backup-section.tsx']) {
      expect(read(file), file).not.toMatch(/type="time"/);
      expect(read(file), file).toMatch(/<TimePicker\b/);
    }
  });
});
