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
      <div
        v-if="delta !== null && delta !== undefined"
        class="mt-1 text-[11px] font-mono"
        :class="deltaClass"
      >
        {{ delta > 0 ? '↑' : delta < 0 ? '↓' : '→' }} {{ Math.abs(delta) }}%
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  label:   { type: String, required: true },
  value:   { type: [Number, String], required: true },
  delta:   { type: Number, default: null },
  icon:    { type: String, default: '📊' },
  format:  { type: String, default: 'number' },  // number | percent | duration | score
  invertDelta: { type: Boolean, default: false }, // true for "actions required" — lower is better
  tone:    { type: String, default: 'primary' },  // primary | secondary | success | warn | fail
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

const deltaClass = computed(() => {
  if (props.delta === null || props.delta === 0) return 'text-text-muted'
  const isGood = props.invertDelta ? props.delta < 0 : props.delta > 0
  return isGood ? 'text-pass' : 'text-fail'
})
</script>
