<template>
  <div>
    <!-- Edit-mode form -->
    <div
      v-if="editing"
      class="space-y-2"
    >
      <div class="text-[10px] text-text-muted mb-1">
        Adjust each KPI's weight and pass threshold. <strong>Weights must sum to 1.0.</strong>
      </div>

      <div
        v-for="(row, i) in draft"
        :key="row.id"
        class="grid grid-cols-12 items-center gap-2 text-xs py-1 border-b border-border-subtle last:border-0"
      >
        <div class="col-span-5 text-text-secondary truncate">
          {{ row.label }}
        </div>
        <label class="col-span-3 flex items-center gap-1">
          <span class="text-[10px] text-text-muted">w</span>
          <input
            v-model.number="draft[i].weight"
            type="number"
            min="0"
            max="1"
            step="0.05"
            class="w-full bg-bg-elevated border border-border-subtle rounded-sm px-1.5 py-0.5 font-mono text-xs"
          >
        </label>
        <label class="col-span-3 flex items-center gap-1">
          <span class="text-[10px] text-text-muted">≥</span>
          <input
            v-model.number="draft[i].threshold"
            type="number"
            min="0"
            max="100"
            step="5"
            class="w-full bg-bg-elevated border border-border-subtle rounded-sm px-1.5 py-0.5 font-mono text-xs"
          >
        </label>
        <div class="col-span-1 text-[10px] text-text-muted text-right">
          /100
        </div>
      </div>

      <div class="flex items-center justify-between pt-2">
        <div
          class="text-[11px] font-mono"
          :class="weightOk ? 'text-pass' : 'text-fail'"
        >
          Σ weight = {{ weightSum.toFixed(2) }}{{ weightOk ? '' : ' (must = 1.00)' }}
        </div>
        <div
          v-if="saveError"
          class="text-[11px] text-fail flex-1 px-3 truncate"
        >
          {{ saveError }}
        </div>
        <div class="flex gap-1">
          <button
            class="text-[11px] px-2 py-1 rounded-sm border border-border-subtle text-text-muted hover:text-text-primary"
            :disabled="saving"
            @click="cancel"
          >
            Cancel
          </button>
          <button
            class="text-[11px] px-2 py-1 rounded-sm bg-accent-primary text-white border border-accent-primary hover:bg-accent-secondary disabled:opacity-50"
            :disabled="!weightOk || saving"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Read-mode summary line + edit toggle -->
    <div
      v-else
      class="flex items-center justify-end"
    >
      <button
        class="text-[11px] text-accent-primary hover:text-accent-secondary font-semibold"
        @click="startEdit"
      >
        ✎ Edit weights & thresholds
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import client from '@/api/client'

const props = defineProps({
  agentId:        { type: String, required: true },
  kpiDefinitions: { type: Array, required: true },
})
const emit = defineEmits(['updated'])

const editing   = ref(false)
const saving    = ref(false)
const saveError = ref(null)
const draft     = ref([])

const weightSum = computed(() => draft.value.reduce((s, k) => s + (Number(k.weight) || 0), 0))
const weightOk  = computed(() => Math.abs(weightSum.value - 1) <= 0.01)

function startEdit() {
  // Clone so cancel can revert
  draft.value = props.kpiDefinitions.map((k) => ({
    id: k.id, label: k.label, weight: k.weight, threshold: k.threshold,
  }))
  saveError.value = null
  editing.value   = true
}

function cancel() {
  editing.value = false
  draft.value = []
  saveError.value = null
}

async function save() {
  saving.value = true
  saveError.value = null
  try {
    const res = await client.put(`/agents/${props.agentId}/kpis`, {
      kpis: draft.value.map((k) => ({ id: k.id, weight: Number(k.weight), threshold: Number(k.threshold) })),
    })
    emit('updated', res.data.kpiDefinitions)
    editing.value = false
  } catch (err) {
    saveError.value = err.message || 'Save failed'
  } finally {
    saving.value = false
  }
}
</script>
