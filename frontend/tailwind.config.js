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
        'border-subtle': '#222B49',
        'border-strong': '#2D3858',

        'text-primary':   '#E8EBF7',
        'text-secondary': '#A1AAC9',
        'text-muted':     '#6B7493',

        'accent-primary':   '#3B82F6',  // CTA, primary lines
        'accent-secondary': '#8B5CF6',  // gradients, recommendations
        'accent-tertiary':  '#EC4899',  // call-out highlights

        'pass':  '#22C55E',
        'warn':  '#F59E0B',
        'fail':  '#EF4444',
        'info':  '#06B6D4',

        // Kept for backward-compat with old narrow-iframe components (will be migrated)
        'hl-primary':   '#3B82F6',
        'hl-dark':      '#0B1020',
        'hl-bg':        '#141A2E',
        'hl-card':      '#1B2240',
        'hl-border':    '#222B49',
        'hl-text':      '#E8EBF7',
        'hl-muted':     '#A1AAC9',
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
