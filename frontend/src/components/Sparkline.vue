<template>
  <VueApexCharts
    type="line"
    height="36"
    width="80"
    :options="chartOptions"
    :series="[{ data }]"
  />
</template>

<script setup>
import { computed } from 'vue'
import VueApexCharts from 'vue3-apexcharts'

const props = defineProps({
  data:  { type: Array, required: true },
  color: { type: String, default: '#0066FF' },
})

const chartOptions = computed(() => ({
  chart: {
    sparkline: { enabled: true },
    animations: { enabled: false },
  },
  stroke: { curve: 'smooth', width: 2 },
  colors: [props.color],
  tooltip: { enabled: false },
  yaxis: { min: 0, max: 100 },
}))
</script>
