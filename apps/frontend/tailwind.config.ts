import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';
import plugin from 'tailwindcss/plugin';

/**
 * Mirrors the Albazourieh platform's Tailwind theme so components copied
 * between the two render identically. Everything resolves through the CSS
 * variables in app/globals.css, which is also what lets a municipality override
 * its own primary colour at runtime from TenantConfig without a rebuild.
 */
const config: Config = {
  darkMode: ['class'],
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '1rem',
      screens: { '2xl': '1280px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Overlay surfaces: tooltip, dropdown, command palette. Absent here
        // while `bg-popover` was already used in charts.tsx, which is why
        // those tooltips were transparent.
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        warning: 'hsl(var(--warning))',
        success: 'hsl(var(--success))',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      fontFamily: {
        // Arabic-first: the webfonts are the sans stack rather than a separate
        // family, so every `font-sans` component inherits them.
        sans: ['var(--font-body)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
      },
      // 48px: the minimum comfortable target for the audience this serves.
      spacing: { touch: '3rem' },
      minHeight: { touch: '3rem' },
      minWidth: { touch: '3rem' },
    },
  },
  // The reference platform's animation plugin. The Radix components carry
  // `data-[state=open]:animate-in` / `fade-in-0` / `zoom-in-95` classes that are
  // inert without it — the dialog and select would pop rather than transition.
  plugins: [
    animate,
    /**
     * `coarse:` — styles that apply only when the primary pointer is a finger.
     *
     * Staff use this in the field on phones and tablets, so controls need a
     * comfortable tap target there; on a desk with a mouse the same controls
     * should stay dense. A width breakpoint is the wrong instrument for that
     * distinction — an iPad Pro is 1366px wide and still a finger, while a
     * 1280px laptop is a cursor. `pointer: coarse` asks the question that
     * actually matters, and it answers correctly for both.
     *
     * Tailwind v4 ships this as `pointer-coarse:`; this project is on 3.4, so
     * it is declared here. Keep the name if upgrading — v4's built-in variant
     * is spelled differently, and a silent rename would drop every tap target
     * back to its desktop size.
     */
    plugin(({ addVariant }) => {
      addVariant('coarse', '@media (pointer: coarse)');
    }),
  ],
};

export default config;
