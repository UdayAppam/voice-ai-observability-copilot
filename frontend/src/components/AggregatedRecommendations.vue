<template>
  <div class="card p-4 relative overflow-hidden">
    <div
      class="absolute top-0 right-0 w-32 h-32 -mr-8 -mt-8 rounded-full bg-accent-secondary/10 blur-2xl pointer-events-none"
    />

    <div class="relative">
      <div class="flex items-center justify-between mb-3">
        <div>
          <div class="chart-title flex items-center gap-2">
            <span class="text-accent-secondary">✨</span> AI Recommendations
          </div>
          <div class="chart-subtitle">
            Highest-impact fixes across all agents
          </div>
        </div>
      </div>

      <div
        v-if="!items.length"
        class="text-xs text-text-muted py-6 text-center"
      >
        No cross-call patterns yet — keep ingesting calls.
      </div>

      <div
        v-else
        class="space-y-3"
      >
        <div
          v-for="item in items"
          :key="item.title"
          class="flex items-start gap-3"
        >
          <span class="text-base shrink-0">{{ severityIcon(item.severity) }}</span>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="text-xs font-semibold text-text-primary truncate">{{ item.title }}</span>
              <span :class="`badge-${item.impact}`">{{ item.impact }} impact</span>
              <span class="text-[10px] text-text-muted">{{ item.pctOfCalls }}% of calls affected</span>
            </div>
            <p class="text-[11px] text-text-secondary leading-relaxed">
              {{ item.detail }}
            </p>
            <p
              v-if="item.suggestedChange"
              class="mt-1 text-[10px] font-mono bg-bg-base p-2 rounded text-text-primary border border-border-subtle"
            >
              {{ item.suggestedChange }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({ items: { type: Array, default: () => [] } })

function severityIcon(sev) {
  if (sev === 'critical') return '🔴'
  if (sev === 'warning') return '🟡'
  return '🔵'
}
</script>
