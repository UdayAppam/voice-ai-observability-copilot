<template>
  <div class="space-y-4">
    <!-- Success header -->
    <div class="flex items-start gap-2">
      <span class="text-pass text-base leading-none mt-0.5">✓</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm font-semibold text-text-primary">
          Applied to {{ receipt.agentName || 'the agent' }}
          <span
            v-if="receipt.editedFromSuggestion"
            class="text-text-muted font-normal"
          >· you edited the AI suggestion</span>
          <span
            v-else
            class="text-text-muted font-normal"
          >· AI suggestion accepted as-is</span>
        </div>
        <div class="text-[11px] text-text-muted mt-0.5">
          {{ receipt.diffSummary }} · prompt {{ receipt.previousAgentPromptLength }} → {{ receipt.finalTextLength }} chars
        </div>
      </div>
    </div>

    <!-- Edit-summary section (only if user edited) -->
    <div
      v-if="receipt.editedFromSuggestion && receipt.editSummary"
      class="bg-accent-secondary/5 border border-accent-secondary/30 rounded-card p-3"
    >
      <div class="text-[10px] uppercase tracking-wide text-accent-secondary font-semibold mb-1">
        Your edit vs AI suggestion
      </div>
      <div class="text-xs text-text-secondary leading-relaxed">
        {{ receipt.editSummary }}
      </div>
    </div>

    <!-- Timeline -->
    <div>
      <div class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-2">
        Timeline
      </div>
      <div class="space-y-1.5">
        <div
          v-for="(step, i) in receipt.timeline"
          :key="i"
          class="flex items-start gap-2 text-xs"
        >
          <span
            class="text-pass shrink-0 mt-0.5"
            :class="step.completedAt || step.step === 'snapshot' ? 'text-pass' : 'text-text-muted'"
          >{{ step.completedAt || step.step === 'snapshot' ? '✓' : '⏳' }}</span>
          <div class="flex-1 min-w-0">
            <span class="text-text-primary">{{ stepLabel(step) }}</span>
            <span
              v-if="step.hlResponseStatus"
              class="text-text-muted ml-1"
            >· HL {{ step.hlResponseStatus }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- What's next -->
    <div class="bg-bg-elevated rounded-card p-3 text-xs text-text-secondary leading-relaxed">
      <div class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1">
        What you'll see next
      </div>
      Your HighLevel agent is now running the new prompt. The next inbound call will hit it.
      Within a few calls, the Flywheel <strong class="text-text-primary">Measure stage</strong>
      will show the score delta. If it regresses, click <strong class="text-text-primary">Rollback</strong>
      on the recommendation card — the previous prompt is restored in seconds.
    </div>

    <!-- Audit -->
    <div class="text-[10px] text-text-muted font-mono pt-2 border-t border-border-subtle">
      Receipt ID: {{ receipt.attemptId }}
      <span v-if="receipt.idempotent">· (idempotent return — already applied within last 5 min)</span>
    </div>

    <!-- Actions -->
    <div class="flex items-center justify-end gap-2 pt-2">
      <RouterLink
        to="/flywheel"
        class="text-xs px-3 py-1.5 rounded-card border border-border-subtle text-text-secondary hover:text-text-primary"
        @click="$emit('close')"
      >
        Open Flywheel
      </RouterLink>
      <button
        class="text-xs px-3 py-1.5 rounded-card bg-accent-primary text-white border border-accent-primary hover:bg-accent-secondary"
        @click="$emit('close')"
      >
        Done
      </button>
    </div>
  </div>
</template>

<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  receipt: { type: Object, required: true },
})
defineEmits(['close'])

function stepLabel(step) {
  return {
    snapshot:           `Snapshotted previous agentPrompt`,
    patch:              `PATCH /voice-ai/agents (${step.newPromptLength || '?'} chars)`,
    mark_applied:       'Recommendation marked applied',
    edit_summary:       'Edit summary recorded',
    log_audit:          'Audit row written',
    idempotent_return:  step.note || 'Returned existing receipt',
  }[step.step] || step.step
}
</script>
