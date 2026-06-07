<template>
  <div class="card p-4 border-accent-primary/30 bg-gradient-to-br from-bg-surface to-accent-primary/5">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="text-[10px] uppercase tracking-wide text-accent-primary font-semibold">
          Core Functionality
        </div>
        <div class="chart-title">
          Monitor → Analyze Loop
        </div>
      </div>
      <RouterLink
        to="/flywheel"
        class="text-xs text-accent-primary hover:text-accent-secondary font-semibold"
      >
        Open Flywheel →
      </RouterLink>
    </div>

    <!-- 4-step strip -->
    <div class="grid grid-cols-1 sm:grid-cols-4 gap-2">
      <HeroStep
        v-for="(s, i) in steps"
        :key="s.label"
        :step-num="i + 1"
        :icon="s.icon"
        :label="s.label"
        :metric="s.metric"
        :sub="s.sub"
        :is-last="i === steps.length - 1"
      />
    </div>

    <!-- Why line -->
    <div
      v-if="whyLine"
      class="mt-3 pt-3 border-t border-border-subtle text-xs text-text-secondary leading-relaxed"
    >
      <span class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mr-1">Why:</span>
      {{ whyLine }}
    </div>
  </div>
</template>

<script setup>
import { computed, h } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  summary: { type: Object, default: null }, // /api/flywheel/summary payload
})

const funnel = computed(() => {
  const f = props.summary?.funnel || []
  return Object.fromEntries(f.map((s) => [s.stage, s.count]))
})

const steps = computed(() => {
  const f = funnel.value
  const n = props.summary?.narratives || {}
  return [
    {
      icon: '📞',
      label: 'Ingest',
      metric: n.ingest?.what?.split(' ')[0] || '—',
      sub: 'calls captured',
    },
    {
      icon: '🧠',
      label: 'Analyze',
      metric: n.score?.what?.match(/Avg KPI (\d+)/)?.[1]
        ? `${n.score.what.match(/Avg KPI (\d+)/)[1]}/100`
        : '—',
      sub: 'avg KPI score',
    },
    {
      icon: '📊',
      label: 'Surface',
      metric: f['Issues Detected'] || 0,
      sub: 'issues surfaced',
    },
    {
      icon: '⚠',
      label: 'Act',
      metric: f['Recommendations Generated'] || 0,
      sub: 'recommendations',
    },
  ]
})

// Pick the most actionable narrative line as the WHY: priority Score > Recommend > Ingest
const whyLine = computed(() => {
  const n = props.summary?.narratives
  if (!n) return ''
  return n.score?.why || n.recommend?.why || n.ingest?.why || ''
})

// Inline component to keep markup tight
const HeroStep = {
  props: ['stepNum', 'icon', 'label', 'metric', 'sub', 'isLast'],
  setup(p) {
    return () => h('div', { class: 'relative flex items-center gap-2 bg-bg-elevated rounded-card p-3' }, [
      h('div', { class: 'w-9 h-9 rounded-card bg-accent-primary/15 flex items-center justify-center text-base shrink-0' }, p.icon),
      h('div', { class: 'min-w-0 flex-1' }, [
        h('div', { class: 'text-[10px] text-text-muted uppercase tracking-wide' }, `${p.stepNum}. ${p.label}`),
        h('div', { class: 'text-base font-bold text-text-primary leading-tight' }, String(p.metric)),
        h('div', { class: 'text-[10px] text-text-secondary truncate' }, p.sub),
      ]),
      !p.isLast && h('div', {
        class: 'hidden sm:block absolute -right-1 top-1/2 -translate-y-1/2 text-accent-primary text-base',
      }, '→'),
    ])
  },
}
</script>
