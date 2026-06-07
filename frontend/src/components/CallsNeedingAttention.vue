<template>
  <div class="card p-4">
    <div class="flex items-center justify-between mb-3">
      <div>
        <div class="chart-title">
          Recent Calls Requiring Attention
        </div>
        <div class="chart-subtitle">
          Lowest-scoring calls in window — high-leverage to review
        </div>
      </div>
      <RouterLink
        to="/calls"
        class="btn-ghost text-[10px]"
      >
        View all →
      </RouterLink>
    </div>

    <div
      v-if="!calls.length"
      class="text-xs text-text-muted py-6 text-center"
    >
      No calls flagged. Every call passed.
    </div>

    <div
      v-else
      class="overflow-x-auto"
    >
      <table class="w-full text-xs">
        <thead>
          <tr class="text-[10px] uppercase text-text-muted">
            <th class="text-left font-medium pb-2">
              Call
            </th>
            <th class="text-left font-medium pb-2">
              Agent
            </th>
            <th class="text-left font-medium pb-2">
              Issue
            </th>
            <th class="text-right font-medium pb-2">
              KPI
            </th>
            <th class="text-right font-medium pb-2">
              Time
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="call in calls"
            :key="call.id"
            class="border-t border-border-subtle hover:bg-bg-elevated cursor-pointer transition-colors"
            @click="$router.push(`/calls/${call.id}`)"
          >
            <td class="py-2 pr-2 font-mono text-text-muted">
              #{{ shortId(call.id) }}
            </td>
            <td class="py-2 pr-2 text-text-secondary">
              {{ call.agentName }}
            </td>
            <td class="py-2 pr-2 text-text-primary truncate max-w-[280px]">
              {{ call.issue }}
            </td>
            <td
              class="py-2 pr-2 text-right font-mono font-semibold"
              :class="scoreColor(call.overall_score)"
            >
              {{ call.overall_score }}/100
            </td>
            <td class="py-2 text-right text-text-muted font-mono whitespace-nowrap">
              {{ formatTime(call.call_timestamp) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
defineProps({ calls: { type: Array, default: () => [] } })

function shortId(id) {
  return id ? id.slice(-6).toUpperCase() : ''
}
function scoreColor(s) {
  if (s >= 70) return 'text-pass'
  if (s >= 50) return 'text-warn'
  return 'text-fail'
}
function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
</script>
