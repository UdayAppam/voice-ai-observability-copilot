<template>
  <div class="card p-3">
    <div class="flex items-center justify-between mb-2">
      <div>
        <div class="text-[10px] uppercase tracking-wide text-accent-primary font-semibold">
          Validation Flywheel · This Agent
        </div>
        <div class="chart-title">
          5-stage loop for {{ agentName || 'this agent' }}
        </div>
      </div>
      <div class="flex items-center gap-2">
        <select
          v-model.number="days"
          class="bg-bg-elevated border border-border-subtle text-text-secondary text-[11px] rounded-card px-2 py-1"
          @change="reload"
        >
          <option :value="7">
            Last 7 days
          </option>
          <option :value="14">
            Last 14 days
          </option>
          <option :value="30">
            Last 30 days
          </option>
          <option :value="90">
            Last 90 days
          </option>
        </select>
        <RouterLink
          to="/flywheel"
          class="text-[11px] text-accent-primary hover:text-accent-secondary font-semibold"
        >
          Agency view →
        </RouterLink>
      </div>
    </div>

    <LoadingSpinner
      v-if="loading && !narratives"
      size="sm"
      label="Loading flywheel…"
    />
    <div
      v-else-if="error"
      class="text-xs text-fail"
    >
      Couldn't load flywheel narrative: {{ error.message }}
    </div>
    <div v-else-if="narratives">
      <!-- Mass-toggle controls — mirrors the /flywheel page behaviour so the
           per-agent flywheel feels consistent. Only shown when there's
           something to toggle. -->
      <div
        v-if="!allCollapsed || !allExpanded"
        class="flex justify-end mb-1.5"
      >
        <button
          v-if="!allCollapsed"
          class="text-[10px] text-text-muted hover:text-text-primary"
          @click="collapseAll"
        >
          Collapse all
        </button>
        <button
          v-if="!allExpanded"
          class="text-[10px] text-text-muted hover:text-text-primary ml-3"
          @click="expandAll"
        >
          Expand all
        </button>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
        <FlywheelStageCard
          v-for="(stage, key, idx) in narratives"
          :key="key"
          :stage-number="idx + 1"
          :name="stageNames[key]"
          :icon="stageIcons[key]"
          :tone="stageTones[key]"
          :narrative="stage"
          :expanded="isExpanded(key)"
          @expand="expandStage(key)"
          @collapse="collapseStage(key)"
        />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import client from '@/api/client'
import FlywheelStageCard from '@/components/FlywheelStageCard.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'

const props = defineProps({
  agentId:   { type: String, required: true },
  agentName: { type: String, default: '' },
})

const stageNames = { ingest: 'Ingest', score: 'Score', recommend: 'Recommend', apply: 'Apply', measure: 'Measure' }
const stageIcons = { ingest: '📞', score: '🧠', recommend: '💡', apply: '✏️', measure: '✅' }
const stageTones = { ingest: 'primary', score: 'secondary', recommend: 'warn', apply: 'primary', measure: 'pass' }

const days       = ref(30)
const narratives = ref(null)
const loading    = ref(false)
const error      = ref(null)

// All 5 stage cards expanded by default — consistent with /flywheel page.
// Set-based so each card toggles independently; mass-toggle helpers below.
const STAGE_KEYS = ['ingest', 'score', 'recommend', 'apply', 'measure']
const expandedStages = ref(new Set(STAGE_KEYS))

function isExpanded(key) { return expandedStages.value.has(key) }
function expandStage(key) {
  const next = new Set(expandedStages.value); next.add(key)
  expandedStages.value = next
}
function collapseStage(key) {
  const next = new Set(expandedStages.value); next.delete(key)
  expandedStages.value = next
}
function expandAll()   { expandedStages.value = new Set(STAGE_KEYS) }
function collapseAll() { expandedStages.value = new Set() }
const allExpanded  = computed(() => expandedStages.value.size === STAGE_KEYS.length)
const allCollapsed = computed(() => expandedStages.value.size === 0)

async function reload() {
  if (!props.agentId) return
  loading.value = true
  error.value   = null
  try {
    const res = await client.get(`/agents/${props.agentId}/flywheel/narrative`, { params: { days: days.value } })
    narratives.value = res.data.narratives
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

onMounted(reload)
watch(() => props.agentId, reload)
</script>
