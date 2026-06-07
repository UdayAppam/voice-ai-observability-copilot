<template>
  <div class="inline-flex items-center gap-1.5 flex-wrap">
    <span
      v-if="pillContent"
      class="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-sm font-mono"
      :class="pillContent.classes"
      :title="pillContent.tooltip"
    >
      <span>{{ pillContent.icon }}</span>
      <span>{{ pillContent.text }}</span>
    </span>
    <span
      v-if="editedFromSuggestion && status === 'applied'"
      class="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-sm font-mono
             bg-accent-secondary/15 text-accent-secondary border border-accent-secondary/30
             cursor-help"
      :title="editTooltip"
    >
      ✎ edited
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  status:                { type: String, default: 'active' },  // 'active'|'applied'|'measured'|'rolled_back'|'failed'
  measuredDelta:         { type: Number, default: null },      // pts delta after measurement (signed)
  measuredSampleSize:    { type: Number, default: null },
  editedFromSuggestion:  { type: Boolean, default: false },
  editCharsDiff:         { type: Number, default: 0 },
  appliedAt:             { type: String, default: '' },
  postApplyCallCount:    { type: Number, default: 0 },         // calls under new prompt
})

const editTooltip = computed(() =>
  `You edited ${props.editCharsDiff} chars from the AI suggestion — click for receipt`
)

const pillContent = computed(() => {
  if (props.status === 'rolled_back') {
    return {
      icon: '↺',
      text: 'Rolled back',
      classes: 'bg-text-muted/15 text-text-muted border border-border-subtle',
      tooltip: 'Previous prompt restored',
    }
  }
  if (props.status === 'failed') {
    return {
      icon: '✗',
      text: 'Apply failed',
      classes: 'bg-fail/15 text-fail border border-fail/30',
      tooltip: 'See recommendation card for details',
    }
  }
  if (props.status === 'applied' && props.measuredDelta !== null) {
    const sign = props.measuredDelta > 0 ? '+' : ''
    const isPositive = props.measuredDelta > 0
    return {
      icon: isPositive ? '✓' : '⚠',
      text: `Measured: ${sign}${props.measuredDelta} pts${props.measuredSampleSize ? ` (n=${props.measuredSampleSize})` : ''}`,
      classes: isPositive
        ? 'bg-pass/15 text-pass border border-pass/30'
        : 'bg-fail/15 text-fail border border-fail/30',
      tooltip: 'Causal before/after KPI delta',
    }
  }
  if (props.status === 'applied') {
    const note = props.postApplyCallCount > 0
      ? `awaiting measurement (${props.postApplyCallCount} call${props.postApplyCallCount === 1 ? '' : 's'} so far)`
      : 'awaiting first call'
    return {
      icon: '✓',
      text: `Applied · ${note}`,
      classes: 'bg-pass/15 text-pass border border-pass/30',
      tooltip: props.appliedAt ? `Applied at ${new Date(props.appliedAt).toLocaleString()}` : 'Applied',
    }
  }
  return null
})
</script>
