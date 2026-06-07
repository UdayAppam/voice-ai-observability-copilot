<template>
  <RouterLink
    to="/flywheel"
    class="card p-3 block hover:border-accent-primary/40 transition-colors group"
  >
    <div class="flex items-center justify-between mb-2">
      <div>
        <div class="text-[10px] uppercase tracking-wide text-accent-secondary font-semibold">
          ♻️ Validation Flywheel
        </div>
        <div class="chart-title">
          Loop snapshot
        </div>
      </div>
      <span class="text-xs text-accent-primary group-hover:text-accent-secondary font-semibold">
        Open →
      </span>
    </div>

    <div
      v-if="summary"
      class="grid grid-cols-3 gap-2 text-center"
    >
      <Stat
        label="Issues"
        :value="countFor('Issues Detected')"
        tone="primary"
      />
      <Stat
        label="Applied"
        :value="countFor('Recommendations Applied')"
        tone="warn"
      />
      <Stat
        label="Improved"
        :value="countFor('Improved Scores')"
        tone="pass"
      />
    </div>

    <div
      v-if="summary?.narratives?.measure?.why && countFor('Outcomes Measured') > 0"
      class="mt-3 pt-3 border-t border-border-subtle text-[11px] text-text-secondary leading-relaxed line-clamp-2"
    >
      <span class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mr-1">Latest:</span>
      {{ summary.narratives.measure.why }}
    </div>
    <div
      v-else-if="summary?.narratives?.apply?.why"
      class="mt-3 pt-3 border-t border-border-subtle text-[11px] text-text-secondary leading-relaxed line-clamp-2"
    >
      <span class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mr-1">Next:</span>
      {{ summary.narratives.apply.why }}
    </div>

    <div
      v-if="summary?.closureRate !== null && summary?.closureRate !== undefined"
      class="mt-2 text-[10px] text-text-muted font-mono"
    >
      End-to-end closure: <span class="text-pass font-semibold">{{ summary.closureRate }}%</span>
    </div>
  </RouterLink>
</template>

<script setup>
import { h } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  summary: { type: Object, default: null }, // /api/flywheel/summary payload
})

function countFor(stage) {
  if (!props.summary) return 0
  return props.summary.funnel.find((f) => f.stage === stage)?.count || 0
}

const Stat = {
  props: ['label', 'value', 'tone'],
  setup(p) {
    const toneClass = {
      primary: 'text-accent-primary',
      warn:    'text-warn',
      pass:    'text-pass',
    }[p.tone] || 'text-text-primary'
    return () => h('div', { class: 'bg-bg-elevated rounded-card py-2' }, [
      h('div', { class: 'text-[10px] uppercase tracking-wide text-text-muted' }, p.label),
      h('div', { class: `text-xl font-bold ${toneClass}` }, String(p.value)),
    ])
  },
}
</script>
