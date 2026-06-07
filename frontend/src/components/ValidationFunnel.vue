<template>
  <div class="card p-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="chart-title">
          Validation Funnel
        </div>
        <div class="chart-subtitle">
          From issues detected to scores improved
        </div>
      </div>
      <div
        v-if="closureRate !== null"
        class="text-right"
      >
        <div class="text-[10px] text-text-muted uppercase tracking-wide">
          End-to-end closure
        </div>
        <div
          class="text-base font-bold font-mono"
          :class="closureRate > 0 ? 'text-pass' : 'text-warn'"
        >
          {{ closureRate }}%
        </div>
      </div>
    </div>

    <div class="space-y-2">
      <div
        v-for="(stage, i) in funnel"
        :key="stage.stage"
        class="grid grid-cols-12 items-center gap-2 text-xs"
      >
        <div class="col-span-4 text-text-secondary truncate">
          {{ stage.stage }}
        </div>
        <div class="col-span-6 relative h-5 bg-bg-elevated rounded-sm overflow-hidden">
          <div
            class="absolute inset-y-0 left-0 transition-all duration-300"
            :class="barColor(i)"
            :style="{ width: barWidth(stage.count) + '%' }"
          />
        </div>
        <div class="col-span-2 text-right font-mono text-text-primary tabular-nums">
          {{ stage.count }}
          <span
            v-if="stage.conversionFromPrev !== null"
            class="text-[10px] ml-1"
            :class="conversionTone(stage.conversionFromPrev)"
          >
            {{ stage.conversionFromPrev }}%
          </span>
        </div>
      </div>
    </div>

    <div
      v-if="firstCount > 0"
      class="mt-3 pt-3 border-t border-border-subtle text-[11px] text-text-muted"
    >
      <span class="text-text-secondary font-semibold">{{ firstCount }}</span> issues funneled to
      <span class="text-pass font-semibold">{{ lastCount }}</span> measurable improvements
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  funnel:        { type: Array, required: true },
  closureRate:   { type: Number, default: null },
})

// Bars scale to the max count across stages (typically stage 0).
// Avoids the visual lie of normalising every stage to 100%.
const maxCount = computed(() => Math.max(1, ...props.funnel.map((s) => s.count)))
const firstCount = computed(() => props.funnel[0]?.count || 0)
const lastCount  = computed(() => props.funnel[props.funnel.length - 1]?.count || 0)

function barWidth(count) {
  return Math.max(2, (count / maxCount.value) * 100)
}

// Gradient: blue at top (raw issues) → green at bottom (improvements)
const colors = [
  'bg-accent-primary',     // Issues Detected
  'bg-accent-secondary',   // Root Causes
  'bg-warn',               // Recommendations Generated
  'bg-warn/70',            // Applied
  'bg-pass/70',            // Measured
  'bg-pass',               // Improved
]
function barColor(i) { return colors[i] || 'bg-accent-primary' }

function conversionTone(pct) {
  if (pct >= 80) return 'text-pass'
  if (pct >= 40) return 'text-warn'
  return 'text-fail'
}
</script>
