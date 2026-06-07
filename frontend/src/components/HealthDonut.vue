<template>
  <div class="relative inline-block">
    <VueApexCharts
      type="radialBar"
      :height="size"
      :width="size"
      :options="chartOptions"
      :series="[score]"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import VueApexCharts from 'vue3-apexcharts'

const props = defineProps({
  score: { type: Number, required: true },
  size:  { type: Number, default: 80 },
  showLabel: { type: Boolean, default: true },
})

const chartOptions = computed(() => ({
  chart: { sparkline: { enabled: true } },
  plotOptions: {
    radialBar: {
      hollow: { size: '60%' },
      track:  { background: '#E5E7EB' },
      dataLabels: {
        name: { show: false },
        value: {
          show: props.showLabel,
          offsetY: 6,
          fontSize: props.size >= 100 ? '20px' : '14px',
          fontWeight: 700,
          fontFamily: 'Inter, sans-serif',
          color: '#111827',
          formatter: (val) => Math.round(val),
        },
      },
    },
  },
  fill: {
    colors: [scoreColor(props.score)],
  },
  stroke: { lineCap: 'round' },
}))

function scoreColor(s) {
  if (s >= 70) return '#10B981'
  if (s >= 50) return '#F59E0B'
  return '#EF4444'
}
</script>
