<template>
  <AppShell>
    <template #filters>
      <select
        v-model.number="rangeDays"
        class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5"
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
    </template>

    <div class="p-6 space-y-4">
      <!-- Page header — page title + tagline -->
      <div>
        <h1 class="text-xl font-bold text-text-primary">
          Validation Flywheel
        </h1>
        <p class="text-xs text-text-secondary mt-0.5">
          How AI recommendations turn into measurable improvements for your agents
        </p>
      </div>

      <LoadingSpinner
        v-if="loading && !data"
        label="Loading flywheel state…"
      />
      <ErrorState
        v-else-if="error && !data"
        title="Failed to load flywheel"
        :message="error.message"
        :on-retry="reload"
      />

      <template v-else-if="data">
        <!-- FUNNEL -->
        <ValidationFunnel
          :funnel="data.funnel"
          :closure-rate="data.closureRate"
        />

        <!-- STAGE CARDS -->
        <div>
          <div class="flex items-baseline justify-between mb-2">
            <div class="text-xs uppercase tracking-wide text-text-muted">
              Stages — click to expand
            </div>
            <button
              v-if="expandedStage"
              class="text-[11px] text-text-muted hover:text-text-primary"
              @click="expandedStage = null"
            >
              Collapse all
            </button>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-2">
            <FlywheelStageCard
              v-for="(stage, key, idx) in data.narratives"
              :key="key"
              :stage-number="idx + 1"
              :name="stageNames[key]"
              :icon="stageIcons[key]"
              :tone="stageTones[key]"
              :health-badge="healthBadge(key)"
              :narrative="stage"
              :expanded="expandedStage === key"
              @expand="expandedStage = key"
              @collapse="expandedStage = null"
            />
          </div>
        </div>

        <!-- IMPACT SUMMARY -->
        <div class="card p-4">
          <div class="chart-title mb-3">
            Impact this period
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <ImpactStat
              label="Avg Score Δ"
              :value="data.impact.avgScoreDeltaThisPeriod"
              suffix=" pts"
              :tone="data.impact.avgScoreDeltaThisPeriod > 0 ? 'pass' : 'fail'"
            />
            <ImpactStat
              label="Success Rate"
              :value="data.impact.successRatePct"
              suffix="%"
              tone="pass"
            />
            <ImpactStat
              label="Measured Outcomes"
              :value="data.impact.measuredOutcomes"
              tone="primary"
            />
            <ImpactStat
              label="Manual Review Saved"
              :value="data.impact.manualReviewHoursSaved"
              suffix=" hrs"
              tone="secondary"
            />
          </div>
        </div>
      </template>
    </div>
  </AppShell>
</template>

<script setup>
import { ref, onMounted, h } from 'vue'
import client from '@/api/client'
import AppShell from '@/components/AppShell.vue'
import ValidationFunnel from '@/components/ValidationFunnel.vue'
import FlywheelStageCard from '@/components/FlywheelStageCard.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import ErrorState from '@/components/ErrorState.vue'

const stageNames  = { ingest: 'Ingest', score: 'Score', recommend: 'Recommend', apply: 'Apply', measure: 'Measure' }
const stageIcons  = { ingest: '📞', score: '🧠', recommend: '💡', apply: '✏️', measure: '✅' }
const stageTones  = { ingest: 'primary', score: 'secondary', recommend: 'warn', apply: 'primary', measure: 'pass' }

const rangeDays = ref(30)
const data      = ref(null)
const loading   = ref(false)
const error     = ref(null)
const expandedStage = ref('score')   // open Score by default — that's where issues surface

async function reload() {
  loading.value = true
  error.value   = null
  try {
    const res = await client.get('/flywheel/summary', { params: { days: rangeDays.value } })
    data.value = res.data
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

// Health badge per stage derived from funnel + counts. Deterministic, no extra fetch.
function healthBadge(key) {
  if (!data.value) return ''
  const counts = Object.fromEntries(data.value.funnel.map((f) => [f.stage, f.count]))
  if (key === 'ingest')    return counts['Issues Detected'] > 0 ? '🟢 active' : '🟡 idle'
  if (key === 'score')     return counts['Issues Detected'] > 5 ? '🔴 attention' : '🟢 healthy'
  if (key === 'recommend') return counts['Recommendations Generated'] > 0 ? '🟢 generating' : '🟡 idle'
  if (key === 'apply')     return counts['Recommendations Applied'] > 0 ? '🟢 applying'   : '🟡 waiting'
  if (key === 'measure')   return counts['Outcomes Measured'] > 0 ? '🟢 measuring'         : '🟡 pending'
  return ''
}

onMounted(reload)

// ── tiny inline component to keep impact cards consistent ──
const ImpactStat = {
  props: ['label', 'value', 'suffix', 'tone'],
  setup(p) {
    const toneClass = {
      pass:      'text-pass',
      fail:      'text-fail',
      warn:      'text-warn',
      primary:   'text-accent-primary',
      secondary: 'text-accent-secondary',
    }[p.tone] || 'text-text-primary'

    return () => h('div', { class: 'bg-bg-elevated rounded-card p-3' }, [
      h('div', { class: 'text-[10px] text-text-muted uppercase tracking-wide' }, p.label),
      h('div', { class: `text-2xl font-bold mt-0.5 ${toneClass}` }, [
        p.value !== null && p.value !== undefined ? p.value : '—',
        h('span', { class: 'text-xs text-text-muted ml-0.5' }, p.suffix || ''),
      ]),
    ])
  },
}
</script>
