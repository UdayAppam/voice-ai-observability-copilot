/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        // Dark observability theme (default)
        'bg-base':       '#0B1020',
        'bg-surface':    '#141A2E',
        'bg-elevated':   '#1B2240',
        'bg-hover':      '#222B49',
        'border-subtle': '#2A335A',     // was #222B49 — was invisible against cards
        'border-strong': '#3A4670',     // was #2D3858 — gives stronger card edges

        'text-primary':   '#E8EBF7',
        'text-secondary': '#A1AAC9',
        'text-muted':     '#8B95B8',    // was #6B7493 — failed WCAG AA (3.0–4.1:1). Now ~5.5:1 ✓

        'accent-primary':   '#3B82F6',  // solid buttons — white text on top has high contrast
        'accent-secondary': '#8B5CF6',  // gradients/borders only
        'accent-tertiary':  '#EC4899',

        // Lighter accent variants for use as TEXT on dark surfaces (links, call-outs).
        // The solid `accent-*` shades above are too dim against bg-elevated for body text.
        'accent-primary-text':   '#60A5FA',  // 7.0:1 on bg-base ✓
        'accent-secondary-text': '#A78BFA',  // 6.5:1 on bg-base ✓
        'fail-text':             '#F87171',  // 6.4:1 on bg-elevated ✓ — use for red text inside cards

        'pass':  '#22C55E',
        'warn':  '#F59E0B',
        'fail':  '#EF4444',             // solid badges/icons — use `fail-text` for text-on-card
        'info':  '#06B6D4',

        // Kept for backward-compat with old narrow-iframe components (will be migrated)
        'hl-primary':   '#3B82F6',
        'hl-dark':      '#0B1020',
        'hl-bg':        '#141A2E',
        'hl-card':      '#1B2240',
        'hl-border':    '#2A335A',      // lifted alongside border-subtle
        'hl-text':      '#E8EBF7',
        'hl-muted':     '#A1AAC9',      // already passes AA — kept
        'hl-pass':      '#22C55E',
        'hl-warn':      '#F59E0B',
        'hl-fail':      '#EF4444',
        'hl-deviation': '#F97316',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        card:  '10px',
        badge: '4px',
      },
      boxShadow: {
        'card':   '0 1px 2px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.03) inset',
        'glow':   '0 0 32px rgba(59,130,246,0.15)',
      },
    },
  },
  plugins: [],
}
