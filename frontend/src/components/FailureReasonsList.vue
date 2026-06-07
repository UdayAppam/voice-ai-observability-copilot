<template>
  <div class="card p-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="chart-title">
          Top Failure Reasons
        </div>
        <div class="chart-subtitle">
          Across all analysed calls in window
        </div>
      </div>
      <span class="text-[10px] text-text-muted">{{ items.length }} patterns</span>
    </div>

    <div
      v-if="!items.length"
      class="text-xs text-text-muted py-6 text-center"
    >
      No failure patterns yet. Good shape.
    </div>

    <div
      v-else
      class="space-y-3"
    >
      <div
        v-for="item in items"
        :key="item.label"
      >
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-text-primary truncate flex-1 mr-2">{{ item.label }}</span>
          <span
            class="text-xs font-mono font-semibold"
            :class="severityColor(item.severity)"
          >
            {{ item.pct }}%
          </span>
        </div>
        <div class="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
          <div
            class="h-full rounded-full transition-all"
            :class="severityBg(item.severity)"
            :style="{ width: item.pct + '%' }"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({ items: { type: Array, default: () => [] } })

function severityColor(sev) {
  return sev === 'critical' ? 'text-fail' : sev === 'warning' ? 'text-warn' : 'text-info'
}
function severityBg(sev) {
  return sev === 'critical' ? 'bg-fail' : sev === 'warning' ? 'bg-warn' : 'bg-info'
}
</script>
