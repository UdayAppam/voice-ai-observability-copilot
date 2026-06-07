<template>
  <span>
    <button
      class="text-[11px] px-2 py-1 rounded-sm border font-semibold transition-colors"
      :class="buttonClass"
      :disabled="disabled || applied"
      :title="disabled ? disabledReason : ''"
      @click.stop="open"
    >
      <span v-if="applied">✓ Applied</span>
      <span v-else>▶ Apply to {{ agentName }}</span>
    </button>
    <ApplyDiffModal
      v-if="modalOpen"
      :recommendation="recommendation"
      @close="onClose"
    />
  </span>
</template>

<script setup>
import { ref, computed } from 'vue'
import ApplyDiffModal from '@/components/ApplyDiffModal.vue'

const props = defineProps({
  recommendation: { type: Object, required: true }, // { id, agentId, title, severity }
  agentName:      { type: String, required: true },
  applied:        { type: Boolean, default: false },
  disabled:       { type: Boolean, default: false },
  disabledReason: { type: String, default: '' },
})
const emit = defineEmits(['applied'])

const modalOpen = ref(false)
const buttonClass = computed(() => {
  if (props.applied) return 'bg-pass/15 text-pass border-pass/40 cursor-default'
  if (props.disabled) return 'bg-bg-elevated text-text-muted border-border-subtle cursor-not-allowed'
  return 'bg-accent-primary text-white border-accent-primary hover:bg-accent-secondary'
})

function open() { if (!props.disabled && !props.applied) modalOpen.value = true }
function onClose({ applied, receipt } = {}) {
  modalOpen.value = false
  if (applied) emit('applied', receipt)
}
</script>
