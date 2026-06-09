<template>
  <div class="card p-4 border-accent-primary/30 bg-gradient-to-br from-bg-surface to-accent-primary/5">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="text-[10px] uppercase tracking-wide text-accent-primary-text font-semibold">
          Core Functionality
        </div>
        <div class="chart-title">
          Monitor → Improve Loop
        </div>
      </div>
      <RouterLink
        to="/flywheel"
        class="text-xs text-accent-primary-text hover:text-accent-secondary-text font-semibold"
      >
        Open Flywheel →
      </RouterLink>
    </div>

    <!-- 5-step strip: Ingest → Analyze → Recommend → Apply → Measure -->
    <!-- Wraps to 2 rows on narrow screens; 5-wide on lg+. -->
    <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
      <HeroStep
        v-for="(s, i) in steps"
        :key="s.label"
        :step-num="i + 1"
        :icon="s.icon"
        :label="s.label"
        :metric="s.metric"
        :sub="s.sub"
        :delta="s.delta"
        :tone="s.tone"
        :window-days="windowDays"
        :is-last="i === steps.length - 1"
      />
    </div>

    <!-- Closure callouts — the proof-of-loop-closure that was missing from the
         original "Why" line at the bottom. These earn the "Improve Loop" claim. -->
    <div
      v-if="hasClosureSignal"
      class="mt-3 pt-3 border-t border-border-subtle space-y-1.5"
    >
      <div
        v-if="closureRate !== null"
        class="flex items-baseline gap-2 text-xs"
      >
        <span class="text-[10px] uppercase tracking-wide text-text-muted font-semibold shrink-0">Closure</span>
        <span class="font-bold font-mono text-text-primary">{{ closureRate }}%</span>
        <span class="text-text-secondary">
          of issues → significant improvement
          <span class="text-text-muted">(Δ ≥ 2 pts, n ≥ 3)</span>
        </span>
      </div>
      <div
        v-if="bestFix"
        class="flex items-baseline gap-2 text-xs"
      >
        <span class="text-[10px] uppercase tracking-wide text-pass font-semibold shrink-0">Best fix</span>
        <span class="text-text-primary truncate">"{{ bestFix.title }}"</span>
        <span class="font-bold font-mono text-pass shrink-0">+{{ bestFix.delta }} pts</span>
        <span class="text-text-muted shrink-0">(n={{ bestFix.sampleSize }})</span>
      </div>
    </div>
    <!-- Pre-closure state: nothing measured yet -->
    <div
      v-else
      class="mt-3 pt-3 border-t border-border-subtle text-xs text-text-muted leading-relaxed"
    >
      <span class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mr-1">Waiting:</span>
      Apply a recommendation + accumulate post-apply calls to see the loop close.
    </div>
  </div>
</template>

<script setup>
import { computed, h } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  summary:    { type: Object, default: null }, // /api/flywheel/summary payload
  windowDays: { type: Number, default: null }, // V5.2 — explicit window for "vs prior Nd" label
})

// 5 steps drawn from `monitorImproveStrip` (V5.1) instead of the older
// funnel-shape extraction. Each step's `delta` is signed (`+12`, `-3`) so the
// HeroStep can render arrows + tone automatically.
const steps = computed(() => {
  const mi = props.summary?.monitorImproveStrip
  if (!mi) {
    return [
      { icon: '📞', label: 'Ingest',    metric: '—', sub: 'calls', delta: null, tone: 'primary' },
      { icon: '🧠', label: 'Analyze',   metric: '—', sub: 'avg KPI', delta: null, tone: 'primary' },
      { icon: '💡', label: 'Recommend', metric: '—', sub: 'recs', delta: null, tone: 'primary' },
      { icon: '✏️', label: 'Apply',     metric: '—', sub: 'applied', delta: null, tone: 'primary' },
      { icon: '✅', label: 'Measure',   metric: '—', sub: 'measured', delta: null, tone: 'pass' },
    ]
  }
  const measureSub = (mi.measure?.significantCount ?? 0) > 0
    ? `${mi.measure.significantCount} significant`
    : `${mi.measure.anyCount || 0} any improvement`
  const scoreDelta = (mi.analyze?.currentAvgScore && mi.analyze?.priorAvgScore)
    ? Math.round((mi.analyze.currentAvgScore - mi.analyze.priorAvgScore) * 10) / 10
    : null
  return [
    {
      icon: '📞', label: 'Ingest',
      metric: mi.ingest?.current ?? 0,
      sub: 'calls captured',
      delta: mi.ingest?.deltaRaw ?? null,
      tone: 'primary',
    },
    {
      icon: '🧠', label: 'Analyze',
      metric: Math.round(mi.analyze?.currentAvgScore || 0) + '/100',
      sub: 'avg KPI score',
      // Score is "higher is better" — delta is signed already
      delta: scoreDelta,
      tone: 'secondary',
    },
    {
      icon: '💡', label: 'Recommend',
      metric: mi.recommend?.current ?? 0,
      sub: 'patterns surfaced',
      delta: mi.recommend?.deltaRaw ?? null,
      tone: 'warn',
    },
    {
      icon: '✏️', label: 'Apply',
      metric: mi.apply?.current ?? 0,
      sub: 'fixes pushed live',
      delta: mi.apply?.deltaRaw ?? null,
      tone: 'primary',
    },
    {
      icon: '✅', label: 'Measure',
      metric: mi.measure?.current ?? 0,
      sub: measureSub,
      delta: mi.measure?.deltaRaw ?? null,
      tone: 'pass',
    },
  ]
})

const closureRate = computed(() => props.summary?.closureRate ?? null)
const bestFix     = computed(() => props.summary?.monitorImproveStrip?.bestFix || null)
const hasClosureSignal = computed(() => (closureRate.value !== null && closureRate.value > 0) || bestFix.value !== null)

// Inline HeroStep — renders the trend delta with explicit "vs prior {N}d" label
const HeroStep = {
  props: ['stepNum', 'icon', 'label', 'metric', 'sub', 'delta', 'tone', 'windowDays', 'isLast'],
  setup(p) {
    const iconBg = {
      primary:   'bg-accent-primary/15 text-accent-primary-text',
      secondary: 'bg-accent-secondary/15 text-accent-secondary-text',
      warn:      'bg-warn/15 text-warn',
      pass:      'bg-pass/15 text-pass',
      fail:      'bg-fail/15 text-fail-text',
    }[p.tone] || 'bg-accent-primary/15 text-accent-primary-text'
    // Same wording as MetricHeroCard so the whole page is consistent.
    const windowLabel = p.windowDays ? `prior ${p.windowDays}d` : 'prior period'
    const tooltip = p.windowDays
      ? `Last ${p.windowDays} days vs prior ${p.windowDays} days`
      : null
    return () => h('div', { class: 'relative flex items-center gap-2 bg-bg-elevated rounded-card p-3' }, [
      h('div', { class: `w-9 h-9 rounded-card flex items-center justify-center text-base shrink-0 ${iconBg}` }, p.icon),
      h('div', { class: 'min-w-0 flex-1' }, [
        h('div', { class: 'text-[10px] text-text-muted uppercase tracking-wide' }, `${p.stepNum}. ${p.label}`),
        h('div', { class: 'text-base font-bold text-text-primary leading-tight' }, String(p.metric)),
        h('div', { class: 'text-[10px] text-text-secondary truncate' }, p.sub),
        // Trend delta — colored by direction; suppressed when delta=0 or null
        (p.delta !== null && p.delta !== undefined && p.delta !== 0) && h('div', {
          class: 'text-[10px] font-mono mt-0.5 ' + (p.delta > 0 ? 'text-pass' : 'text-fail-text'),
          title: tooltip,
        }, `${p.delta > 0 ? '↑' : '↓'} ${Math.abs(p.delta)}${p.label === 'Analyze' ? ' pts' : ''} vs ${windowLabel}`),
      ]),
      !p.isLast && h('div', {
        class: 'hidden lg:block absolute -right-1 top-1/2 -translate-y-1/2 text-accent-primary-text text-base',
      }, '→'),
    ])
  },
}
</script>
