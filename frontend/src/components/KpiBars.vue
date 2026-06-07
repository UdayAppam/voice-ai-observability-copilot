<template>
  <div class="space-y-1.5">
    <div
      v-for="kpi in kpiDefinitions"
      :key="kpi.name"
      class="text-xs"
    >
      <div class="flex items-center justify-between mb-0.5">
        <span class="text-hl-muted truncate">{{ kpi.label }}</span>
        <span
          class="font-mono font-semibold"
          :class="textColor(score(kpi), kpi.threshold)"
        >
          {{ score(kpi) ?? '—' }}
          <span class="text-hl-muted font-normal text-[10px]">/{{ kpi.threshold }}</span>
        </span>
      </div>
      <div class="relative h-1.5 bg-hl-border rounded-full overflow-hidden">
        <!-- Threshold marker -->
        <div
          class="absolute top-0 bottom-0 w-px bg-hl-text/40 z-10"
          :style="{ left: kpi.threshold + '%' }"
          :title="`Threshold: ${kpi.threshold}`"
        />
        <!-- Score bar -->
        <div
          class="h-full rounded-full transition-all"
          :class="barColor(score(kpi), kpi.threshold)"
          :style="{ width: (score(kpi) || 0) + '%' }"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  kpiDefinitions: { type: Array, required: true },
  kpiScores:      { type: Object, required: true },
})

function score(kpi) {
  return props.kpiScores[kpi.name] ?? null
}

function barColor(s, threshold) {
  if (s === null || s === undefined) return 'bg-hl-border'
  if (s >= threshold) return 'bg-hl-pass'
  if (s >= threshold - 15) return 'bg-hl-warn'
  return 'bg-hl-fail'
}

function textColor(s, threshold) {
  if (s === null || s === undefined) return 'text-hl-muted'
  if (s >= threshold) return 'text-hl-pass'
  if (s >= threshold - 15) return 'text-hl-warn'
  return 'text-hl-fail'
}
</script>
