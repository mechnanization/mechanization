# Design Language: The Modern Civic Ledger (السجل البلدي الحديث)

> **Out of date. Do not build from this file.** The palette, fonts and table
> style below are not what the app uses. The source of truth is
> `apps/frontend/app/globals.css` (measured tokens: warm cream and near-black
> neutrals, IBM Plex Sans Arabic and Noto Kufi Arabic), then
> `apps/frontend/components/ui`, then
> [docs/ui-ux-standards.md](docs/ui-ux-standards.md), which is binding.

An institutional, high-craft design system tailored for municipal governance, fiscal ledgers, property registers, and spatial cadastral exploration.

---

## 🎨 Visual Identity & Palette

### Core Civic Palette
- **Institutional Navy & Midnight Slate (الأزرق المؤسسي والكحلي العميق)**:
  - Base Dark Ground: `#090e17` / `hsl(222 47% 6%)`
  - Sidebar & Command Surfaces: `#0f172a` / `hsl(222 47% 11%)`
  - Primary Civic Blue: `#1d4ed8` / `hsl(224 76% 48%)`
- **Parchment, Chalk & Ivory Surfaces (العاج الأبيض والورق البلدي الأنيق)**:
  - Base Light Background: `#f8fafc` / `hsl(210 40% 98%)`
  - Elevated Cards: `#ffffff` / `hsl(0 0% 100%)`
  - Muted Subtle Panels: `#f1f5f9` / `hsl(210 40% 96%)`
- **Heritage Cedar Green & Amber Accents (الأرز اللبناني والذهب التراثي)**:
  - Cedar Green Accent (Paid / Success / Verified): `#047857` / `hsl(160 84% 39%)`
  - Amber Gold (Arrears / Pending / Warnings): `#d97706` / `hsl(38 92% 50%)`
  - Crimson Red (Overdue / Critical / Deletions): `#dc2626` / `hsl(0 84% 60%)`

---

## ✍️ Typography Architecture
- **Display Headings**: `Alexandria` & `Noto Kufi Arabic` (weight 600–800) with generous optical sizing for Arabic editorial prestige.
- **Body & Controls**: `Readex Pro` & `IBM Plex Sans Arabic` (weight 400–600) with optimized RTL line-height (`leading-relaxed`).
- **Data & Fiscal Numerals**: `JetBrains Mono` / `Inter` tabular numerals (`tabular-nums`) with clear LBP thousand separators.

---

## 📐 Layout & Spatial Hierarchy
- **Header & Navigation**: Fixed full-bleed header with municipal coat of arms / tenant emblem, breadcrumbs, search shortcut (`Cmd/Ctrl+K`), and staff role indicators.
- **Collapsible Civic Sidebar**: Crisp grouped navigation with real-time badge counts, active state pill highlights, and footer user control.
- **Metric Cards (KPIs)**: High-contrast elevation cards with contextual sparkline indicators, currency formatters with hover details, and semantic accent icons.
- **Data Grid & Ledger**: High-density tables with zebra striping, sticky headers, subtle border dividers, instant search, and bulk operations.
