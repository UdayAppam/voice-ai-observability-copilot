<template>
  <div class="card p-4">
    <div class="flex items-start justify-between mb-1 gap-3 flex-wrap">
      <div class="min-w-0">
        <div class="chart-title">
          Caller Mood Trend
        </div>
        <div class="chart-subtitle">
          Daily sentiment distribution — <span class="text-pass">green = happy</span>,
          <span class="text-warn">yellow = mixed</span>,
          <span class="text-fail-text">red = upset</span>
          <span class="text-text-muted ml-1">(threshold: ≥{{ thresholds.positive }} positive, &lt;{{ thresholds.negative }} negative)</span>
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <!-- Per-agent filter — answers "WHICH agent is dragging mood down" -->
        <select
          v-if="agents.length > 0"
          v-model="agentFilter"
          class="bg-bg-elevated border border-border-subtle text-text-secondary text-[11px] rounded-card px-2 py-1"
          @change="$emit('filter-change', agentFilter)"
        >
          <option :value="null">
            All agents
          </option>
          <option
            v-for="a in agents"
            :key="a.id"
            :value="a.id"
          >
            {{ a.name }}
          </option>
        </select>
        <div class="flex items-center gap-2 text-[10px]">
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-pass" /> Happy</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-warn" /> Mixed</span>
          <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-fail-text" /> Upset</span>
        </div>
      </div>
    </div>

    <VueApexCharts
      type="line"
      height="200"
      :options="options"
      :series="series"
    />

    <!-- Actionable footer — turns the chart into a next-step prompt -->
    <div
      v-if="spike || daysWithoutData > 0"
      class="mt-3 pt-3 border-t border-border-subtle text-xs space-y-1.5"
    >
      <div
        v-if="spike"
        class="flex items-start gap-2 leading-relaxed"
      >
        <span class="text-fail-text font-bold shrink-0">🚨</span>
        <div class="flex-1 min-w-0">
          <span class="text-text-primary font-semibold">Worst day:</span>
          <span class="text-text-secondary ml-1">
            {{ formatDate(spike.day, 'long') }} — {{ spike.negative }}% upset
            <span class="text-text-muted">({{ spike.negativeCount }} of {{ spike.total }} calls)</span>
            <span
              v-if="spike.jump !== null"
              class="text-fail-text"
            > · jumped +{{ spike.jump }} pts vs prior day</span>
          </span>
          <div
            v-if="spike.topRec"
            class="text-text-secondary mt-0.5"
          >
            <span class="text-text-muted">Top contributing pattern on {{ spike.topRec.agentName }}:</span>
            <RouterLink
              to="/patterns"
              class="text-accent-primary-text hover:underline ml-1"
            >
              "{{ spike.topRec.title }}" →
            </RouterLink>
          </div>
          <div
            v-else
            class="text-text-muted mt-0.5"
          >
            No specific pattern surfaced for this day —
            <RouterLink
              to="/patterns"
              class="text-accent-primary-text hover:underline"
            >
              review Patterns
            </RouterLink>
            to investigate.
          </div>
        </div>
      </div>
      <div
        v-if="daysWithoutData > 0"
        class="text-[11px] text-text-muted"
      >
        ⓘ {{ daysWithoutData }} day{{ daysWithoutData === 1 ? '' : 's' }} in this window had no calls (shown as gaps in the chart).
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import VueApexCharts from 'vue3-apexcharts'

const props = defineProps({
  trend:      { type: Array,  default: () => [] },
  spike:      { type: Object, default: null },          // backend's sentimentSpike payload
  thresholds: { type: Object, default: () => ({ positive: 70, negative: 50 }) },
  agents:     { type: Array,  default: () => [] },      // [{id, name}] for filter dropdown
  currentAgentId: { type: String, default: null },
})
defineEmits(['filter-change'])

const agentFilter = ref(props.currentAgentId || null)

// V5.3 — null instead of 0 hides the marker on no-data days (vs the prior
// behaviour of plotting 0% which read as "agent collapsed that day").
const series = computed(() => [
  { name: 'Happy', data: props.trend.map((d) => d.hasData ? d.positive : null) },
  { name: 'Mixed', data: props.trend.map((d) => d.hasData ? d.neutral  : null) },
  { name: 'Upset', data: props.trend.map((d) => d.hasData ? d.negative : null) },
])

// Human-readable day labels — picks a format that fits the window length.
//   ≤ 14 days → "Mon", "Tue" (with month when ambiguous)
//   ≤ 30 days → "Jun 4"
//   > 30 days → "Jun" (then sparse labels — handled by apex via labels.rotate)
function formatDate(iso, kind) {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00')
  if (kind === 'long') {
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  }
  // 'short' for axis labels
  if (props.trend.length <= 14) {
    return d.toLocaleDateString(undefined, { weekday: 'short' })
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const daysWithoutData = computed(() => props.trend.filter((d) => !d.hasData).length)

const options = computed(() => ({
  chart: {
    toolbar: { show: false },
    background: 'transparent',
    animations: { enabled: true, easing: 'easeinout', speed: 300 },
  },
  theme: { mode: 'dark' },
  colors: ['#22C55E', '#F59E0B', '#F87171'],   // happy / mixed / upset
  stroke: { curve: 'smooth', width: 2 },
  markers: {
    size: 4,
    strokeWidth: 0,
    hover: { size: 6 },
  },
  legend: { show: false },
  grid: { borderColor: '#2A335A', strokeDashArray: 4 },
  xaxis: {
    categories: props.trend.map((d) => formatDate(d.day, 'short')),
    labels: {
      style: { colors: '#8B95B8', fontSize: '10px' },
      rotate: props.trend.length > 14 ? -45 : 0,
      rotateAlways: false,
    },
    axisBorder: { show: false }, axisTicks: { show: false },
  },
  yaxis: {
    min: 0, max: 100,
    labels: { style: { colors: '#8B95B8', fontSize: '10px' }, formatter: (v) => `${v}%` },
  },
  // Custom tooltip with sample size — answers "X% of HOW MANY calls?"
  tooltip: {
    theme: 'dark',
    custom: ({ dataPointIndex, w }) => {
      const day = props.trend[dataPointIndex]
      if (!day) return ''
      if (!day.hasData) {
        return `<div class="p-2 text-xs"><div class="font-semibold">${formatDate(day.day, 'long')}</div><div class="text-text-muted">No calls this day</div></div>`
      }
      const happy   = `<span style="color:#22C55E">●</span> Happy: ${day.positive}% (${day.positiveCount} of ${day.total})`
      const mixed   = `<span style="color:#F59E0B">●</span> Mixed: ${day.neutral}% (${day.neutralCount} of ${day.total})`
      const upset   = `<span style="color:#F87171">●</span> Upset: ${day.negative}% (${day.negativeCount} of ${day.total})`
      return `<div class="p-2 text-xs space-y-1">
        <div class="font-semibold mb-1">${formatDate(day.day, 'long')}</div>
        <div>${happy}</div><div>${mixed}</div><div>${upset}</div>
      </div>`
    },
  },
  // V5.3 — annotate the spike day automatically so the eye lands on it
  annotations: props.spike ? {
    xaxis: [{
      x: formatDate(props.spike.day, 'short'),
      borderColor: '#F87171',
      strokeDashArray: 0,
      label: {
        text: 'Spike',
        style: { color: '#fff', background: '#F87171', fontSize: '10px' },
      },
    }],
  } : {},
}))
</script>
