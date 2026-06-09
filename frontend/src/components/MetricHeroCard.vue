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
  label:      { type: String, required: true },
  value:      { type: [Number, String], required: true },
  delta:      { type: Number, default: null },   // % change (null when prev period too small)
  deltaRaw:   { type: Number, default: null },   // absolute change — used when % is null/absurd
  windowDays: { type: Number, default: null },   // V5.2 — explicit window for "vs prior Nd" label
  icon:       { type: String, default: '📊' },
  format:     { type: String, default: 'number' },  // number | percent | duration | score
  invertDelta: { type: Boolean, default: false }, // true for "actions required" — lower is better
  tone:       { type: String, default: 'primary' },  // primary | secondary | success | warn | fail
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

// V5.2 — consistent label: "↑ N vs prior {days}d"
//   - If delta% is null but deltaRaw non-zero → show raw with explicit window
//   - If % > 500 → show "10×+" multiplier instead (raw still in tooltip)
//   - Otherwise → show % with explicit window
//   - When deltaRaw=0, suppress the line entirely (no signal)
const windowLabel = computed(() => props.windowDays ? `prior ${props.windowDays}d` : 'prior period')
const displayDelta = computed(() => {
  const d = props.delta
  const r = props.deltaRaw
  // Both null/zero → no delta to show
  if ((d === null || d === undefined) && (r === null || r === undefined)) return null
  if (r === 0 && (d === 0 || d === null)) return null
  // % is null OR absurdly large → fall back to raw count
  if (d === null || d === undefined || Math.abs(d) > 500) {
    const abs = Math.abs(r ?? 0)
    return { arrow: (r ?? 0) > 0 ? '↑' : '↓', text: `${abs} vs ${windowLabel.value}` }
  }
  return { arrow: d > 0 ? '↑' : d < 0 ? '↓' : '→', text: `${Math.abs(d)}% vs ${windowLabel.value}` }
})

const deltaTooltip = computed(() => {
  // Compute exact date ranges if we know windowDays.
  if (!props.windowDays) return null
  const now = new Date()
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const days = props.windowDays
  const currentStart = new Date(now.getTime() - days * 86400e3)
  const priorStart   = new Date(now.getTime() - 2 * days * 86400e3)
  return `Comparing last ${days} days (${fmt(currentStart)} – ${fmt(now)}) vs prior ${days} days (${fmt(priorStart)} – ${fmt(currentStart)})` +
         (props.delta === null && props.deltaRaw !== null ? ' · % omitted because prior period was too small' : '')
})

const deltaClass = computed(() => {
  const d = props.delta ?? props.deltaRaw
  if (d === null || d === 0) return 'text-text-muted'
  const isGood = props.invertDelta ? d < 0 : d > 0
  return isGood ? 'text-pass' : 'text-fail-text'
})
</script>
