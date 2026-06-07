<template>
  <div class="card p-4">
    <div class="flex items-center justify-between mb-1">
      <div>
        <div class="chart-title">
          Sentiment Trend
        </div>
        <div class="chart-subtitle">
          % of calls per sentiment bucket per day
        </div>
      </div>
      <div class="flex items-center gap-3 text-[10px]">
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-pass" /> Positive</span>
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-warn" /> Neutral</span>
        <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-fail" /> Negative</span>
      </div>
    </div>
    <VueApexCharts
      type="line"
      height="200"
      :options="options"
      :series="series"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import VueApexCharts from 'vue3-apexcharts'

const props = defineProps({ trend: { type: Array, default: () => [] } })

const series = computed(() => [
  { name: 'Positive', data: props.trend.map((d) => d.positive) },
  { name: 'Neutral',  data: props.trend.map((d) => d.neutral) },
  { name: 'Negative', data: props.trend.map((d) => d.negative) },
])

const options = computed(() => ({
  chart: { toolbar: { show: false }, background: 'transparent' },
  theme: { mode: 'dark' },
  colors: ['#22C55E', '#F59E0B', '#EF4444'],
  stroke: { curve: 'smooth', width: 2 },
  markers: { size: 3, strokeWidth: 0 },
  legend: { show: false },
  grid: { borderColor: '#222B49', strokeDashArray: 4 },
  xaxis: {
    categories: props.trend.map((d) => d.day.slice(5)),  // MM-DD
    labels: { style: { colors: '#6B7493', fontSize: '10px' } },
    axisBorder: { show: false }, axisTicks: { show: false },
  },
  yaxis: {
    min: 0, max: 100,
    labels: { style: { colors: '#6B7493', fontSize: '10px' }, formatter: (v) => `${v}%` },
  },
  tooltip: { theme: 'dark', y: { formatter: (v) => `${v}%` } },
}))
</script>
