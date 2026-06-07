<template>
  <VueApexCharts
    type="radar"
    height="260"
    :options="chartOptions"
    :series="series"
  />
</template>

<script setup>
import { computed } from 'vue'
import VueApexCharts from 'vue3-apexcharts'

const props = defineProps({
  kpiDefinitions: { type: Array, required: true },
  kpiScores:      { type: Object, required: true },
})

const series = computed(() => {
  return [
    {
      name: 'Score',
      data: props.kpiDefinitions.map((k) => props.kpiScores[k.name] ?? 0),
    },
    {
      name: 'Threshold',
      data: props.kpiDefinitions.map((k) => k.threshold),
    },
  ]
})

const chartOptions = computed(() => ({
  chart: { toolbar: { show: false } },
  xaxis: {
    categories: props.kpiDefinitions.map((k) => shortLabel(k.label)),
    labels: { style: { fontSize: '10px', colors: '#6B7280' } },
  },
  yaxis: { show: false, min: 0, max: 100 },
  colors: ['#0066FF', '#EF4444'],
  stroke: { width: 2, dashArray: [0, 4] },
  fill: { opacity: [0.4, 0.05] },
  markers: { size: [4, 0] },
  legend: { position: 'bottom', fontSize: '11px', labels: { colors: '#6B7280' } },
  tooltip: { y: { formatter: (val) => `${val}/100` } },
}))

function shortLabel(label) {
  return label
    .replace('Call Completion', 'Completion')
    .replace('Script Adherence', 'Adherence')
    .replace('Objection Handling', 'Objection')
    .replace('Caller Sentiment', 'Sentiment')
    .replace('Response Quality', 'Quality')
    .replace('Escalation Rate', 'No Escal.')
}
</script>
