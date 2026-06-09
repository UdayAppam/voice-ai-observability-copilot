<template>
  <div class="card p-4 flex items-start gap-3">
    <div
      class="w-10 h-10 rounded-card flex items-center justify-center text-base shrink-0"
      :class="iconBgClass"
    >
      {{ icon }}
    </div>
    <div class="min-w-0 flex-1">
      <div class="text-[11px] text-text-muted uppercase tracking-wide truncate">
        {{ label }}
      </div>
      <div class="text-2xl font-bold text-text-primary mt-0.5 leading-none">
        {{ display }}
      </div>
      <!-- Delta display: prefer raw count when prior period was tiny
           (% would be visually absurd, e.g. 1→67 = 6600%) -->
      <div
        v-if="displayDelta !== null"
        class="mt-1 text-[11px] font-mono"
        :class="deltaClass"
        :title="deltaTooltip"
      >
        {{ displayDelta.arrow }} {{ displayDelta.text }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  label:    { type: String, required: true },
  value:    { type: [Number, String], required: true },
  delta:    { type: Number, default: null },   // % change (null when prev period too small)
  deltaRaw: { type: Number, default: null },   // absolute change — used when % is null/absurd
  icon:     { type: String, default: '📊' },
  format:   { type: String, default: 'number' },  // number | percent | duration | score
  invertDelta: { type: Boolean, default: false }, // true for "actions required" — lower is better
  tone:     { type: String, default: 'primary' },  // primary | secondary | success | warn | fail
})

const display = computed(() => {
  if (props.format === 'percent') return `${props.value}%`
  if (props.format === 'duration') {
    const m = Math.floor(props.value / 60)
    const s = props.value % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }
  if (props.format === 'score') return `${props.value}/100`
  return new Intl.NumberFormat().format(props.value)
})

const iconBgClass = computed(() => ({
  primary:   'bg-accent-primary/15 text-accent-primary',
  secondary: 'bg-accent-secondary/15 text-accent-secondary',
  success:   'bg-pass/15 text-pass',
  warn:      'bg-warn/15 text-warn',
  fail:      'bg-fail/15 text-fail',
}[props.tone] || 'bg-accent-primary/15 text-accent-primary'))

// Pick whichever delta is more informative + cap absurd %:
//   - If backend returned null delta but a non-zero deltaRaw → show raw
//     (prior period was too small for meaningful %)
//   - If % > 500 → show "+/-N×" instead of the absurd %
//   - Otherwise → show %
const displayDelta = computed(() => {
  const d = props.delta
  const r = props.deltaRaw
  if (d === null || d === undefined) {
    if (r === null || r === undefined || r === 0) return null
    return { arrow: r > 0 ? '↑' : '↓', text: `${Math.abs(r)} (vs ${r > 0 ? 'previous' : 'previous'} period)` }
  }
  if (Math.abs(d) > 500) {
    // % too large to read meaningfully — show multiplier instead
    const mult = Math.round(Math.abs(d) / 100 + 1)
    return { arrow: d > 0 ? '↑' : '↓', text: `${mult}× (was tiny)` }
  }
  return { arrow: d > 0 ? '↑' : d < 0 ? '↓' : '→', text: `${Math.abs(d)}%` }
})

const deltaTooltip = computed(() => {
  if (props.delta === null && props.deltaRaw !== null) {
    return 'Period-over-period absolute change (% omitted because prior period was too small to be meaningful)'
  }
  return null
})

const deltaClass = computed(() => {
  const d = props.delta ?? props.deltaRaw
  if (d === null || d === 0) return 'text-text-muted'
  const isGood = props.invertDelta ? d < 0 : d > 0
  return isGood ? 'text-pass' : 'text-fail-text'
})
</script>
