<template>
  <div
    v-if="worstKpi"
    class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded badge-fail text-[10px] font-mono"
    :title="`${worstKpi.label}: ${worstKpi.score}/${worstKpi.threshold}`"
  >
    <span class="font-semibold">{{ shortLabel(worstKpi.label) }}</span>
    <span>{{ worstKpi.score }}</span>
  </div>
</template>

<script setup>
defineProps({
  worstKpi: { type: Object, default: null },
})

function shortLabel(label) {
  if (!label) return '—'
  return label
    .replace('Call Completion',   'Completion')
    .replace('Script Adherence',  'Adherence')
    .replace('Objection Handling','Objections')
    .replace('Caller Sentiment',  'Sentiment')
    .replace('Response Quality',  'Quality')
    .replace('Escalation Rate',   'Escalation')
}
</script>
