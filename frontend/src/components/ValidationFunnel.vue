<template>
  <div class="card p-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="chart-title">
          Recommendation Lifecycle
        </div>
        <div class="chart-subtitle">
          From detected issues to measurable improvement
        </div>
      </div>
      <div
        v-if="closureRate !== null"
        class="text-right"
      >
        <div class="text-[10px] text-text-muted uppercase tracking-wide">
          Issue → significant improvement
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
        :class="rowHighlight(stage)"
      >
        <div class="col-span-4 truncate">
          <span class="text-text-secondary">{{ stage.stage }}</span>
          <span
            v-if="isLeakRow(stage)"
            class="ml-1.5 text-[9px] text-fail-text font-semibold uppercase tracking-wide"
            title="Low conversion + prior step is old enough that data should exist. Fix this to unlock downstream value."
          >
            biggest leak
          </span>
          <span
            v-else-if="stage.status === 'waiting'"
            class="ml-1.5 text-[9px] text-warn font-semibold uppercase tracking-wide"
            title="0% here is normal — system is still waiting for downstream data to land."
          >
            waiting on data
          </span>
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
        <!-- Sub-line: context note OR sub-count (e.g. "0 incl. any improvement") -->
        <div
          v-if="stage.contextNote || stage.subCount"
          class="col-span-12 text-[10px] text-text-muted pl-0.5"
        >
          <span v-if="stage.contextNote">{{ stage.contextNote }}</span>
          <span v-if="stage.subCount" :class="stage.contextNote ? 'ml-2' : ''">
            <span class="text-text-secondary font-mono">{{ stage.subCount.value }}</span>
            {{ stage.subCount.label }}
          </span>
        </div>
      </div>
    </div>

    <div
      v-if="firstCount > 0"
      class="mt-3 pt-3 border-t border-border-subtle text-[11px] text-text-muted flex items-center justify-between gap-3 flex-wrap"
    >
      <span>
        <span class="text-text-secondary font-semibold">{{ firstCount }}</span> issues detected
        →
        <span class="text-pass font-semibold">{{ lastCount }}</span> significantly improved
      </span>
      <span
        v-if="rootCausesIdentified !== null"
        class="text-text-muted"
        title="Number of distinct root-cause strings across all failed analyses in this window."
      >
        <span class="text-text-secondary font-mono">{{ rootCausesIdentified }}</span> distinct root cause{{ rootCausesIdentified === 1 ? '' : 's' }} identified
      </span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  funnel:               { type: Array, required: true },
  closureRate:          { type: Number, default: null },
  biggestLeakStage:     { type: String, default: null },   // name of the leak stage (from backend)
  rootCausesIdentified: { type: Number, default: null },   // side stat now, not a funnel row
})

// Bars scale to the max count across stages (typically stage 0).
// Avoids the visual lie of normalising every stage to 100%.
const maxCount = computed(() => Math.max(1, ...props.funnel.map((s) => s.count)))
const firstCount = computed(() => props.funnel[0]?.count || 0)
const lastCount  = computed(() => props.funnel[props.funnel.length - 1]?.count || 0)

function barWidth(count) {
  return Math.max(2, (count / maxCount.value) * 100)
}

// Gradient: blue (Issues) → green (Improved). Drops a row vs the old 6-stage
// rainbow since we no longer surface Root Causes as a separate row.
const colors = [
  'bg-accent-primary',     // Issues Detected
  'bg-warn',               // Recommendations Generated
  'bg-warn/70',            // Applied
  'bg-pass/70',            // Measured
  'bg-pass',               // Improved (significantly)
]
function barColor(i) { return colors[i] || 'bg-accent-primary' }

function conversionTone(pct) {
  if (pct >= 80) return 'text-pass'
  if (pct >= 40) return 'text-warn'
  return 'text-fail-text'
}

function isLeakRow(stage) {
  return props.biggestLeakStage && stage.stage === props.biggestLeakStage
}

function rowHighlight(stage) {
  if (isLeakRow(stage)) return 'bg-fail/5 -mx-2 px-2 py-1 rounded-sm border-l-2 border-fail-text'
  if (stage.status === 'waiting') return 'bg-warn/5 -mx-2 px-2 py-1 rounded-sm border-l-2 border-warn'
  return ''
}
</script>
