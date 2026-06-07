<template>
  <AppShell>
    <template #back>
      <BackLink
        label="Overview"
        to="/"
      />
    </template>
    <div class="p-6">
      <LoadingSpinner
        v-if="agentStore.loading && !agent"
        full-page
        label="Loading agent..."
      />

      <ErrorState
        v-else-if="agentStore.error && !agent"
        title="Failed to load agent"
        :message="agentStore.error.message"
        :on-retry="loadAll"
      />

      <div v-else-if="agent">
        <!-- Hero card: donut + name + worst-KPI -->
        <div class="card p-3 mb-3">
          <div class="flex items-center gap-3 mb-2">
            <HealthDonut
              :score="agent.performance.healthScore"
              :size="68"
            />
            <div class="min-w-0 flex-1">
              <h2 class="text-base font-bold text-hl-text truncate">
                {{ agent.name }}
              </h2>
              <p class="text-[11px] text-hl-muted mt-0.5 line-clamp-2 leading-snug">
                {{ agent.goal }}
              </p>
              <div class="mt-1 flex items-center gap-2">
                <span
                  class="text-[10px]"
                  :class="trendColor(agent.performance.trend)"
                >
                  {{ trendIcon(agent.performance.trend) }}
                </span>
                <WorstKpiBadge :worst-kpi="agent.performance.worstKpi" />
              </div>
            </div>
          </div>

          <!-- Status distribution -->
          <StatusBar
            :pass="agent.performance.statusDistribution?.pass || 0"
            :warning="agent.performance.statusDistribution?.warning || 0"
            :fail="agent.performance.statusDistribution?.fail || 0"
            :show-labels="true"
          />
        </div>

        <!-- Per-agent Validation Flywheel — horizontal 5-card narrative panel -->
        <AgentHorizontalFlywheel
          class="mb-3"
          :agent-id="agent.id"
          :agent-name="agent.name"
        />

        <!-- Worst KPI callout -->
        <div
          v-if="agent.performance.worstKpi"
          class="card p-3 mb-3 border-l-4 border-l-hl-fail"
        >
          <div class="flex items-start gap-2">
            <span class="text-hl-fail text-lg leading-none">⚠</span>
            <div class="flex-1 min-w-0">
              <div class="text-xs font-semibold text-hl-text">
                Biggest weak point: {{ agent.performance.worstKpi.label }}
              </div>
              <div class="text-[11px] text-hl-muted mt-0.5">
                Scoring {{ agent.performance.worstKpi.score }}/100 — that's
                <strong>{{ Math.abs(agent.performance.worstKpi.gap) }} points below</strong>
                the {{ agent.performance.worstKpi.threshold }}/100 pass threshold.
              </div>
            </div>
          </div>
        </div>

        <!-- KPI Bars view + inline editor for weights/thresholds -->
        <div class="card p-3 mb-3">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-xs font-semibold text-hl-text uppercase">
              KPI Performance
            </h3>
            <KpiEditor
              v-if="agent.kpiDefinitions.length"
              :agent-id="agent.id"
              :kpi-definitions="agent.kpiDefinitions"
              @updated="onKpisUpdated"
            />
          </div>
          <KpiBars
            v-if="hasKpiScores"
            :kpi-definitions="agent.kpiDefinitions"
            :kpi-scores="agent.performance.kpiScores"
          />
          <EmptyState
            v-else
            title="No KPI data yet"
            icon="📈"
          />
        </div>

        <!-- Radar shape — pattern view -->
        <details class="card p-3 mb-3">
          <summary class="text-xs font-semibold text-hl-text uppercase cursor-pointer">
            Radar Profile (pattern view)
          </summary>
          <KpiRadar
            v-if="hasKpiScores"
            class="mt-2"
            :kpi-definitions="agent.kpiDefinitions"
            :kpi-scores="agent.performance.kpiScores"
          />
        </details>

        <!-- AI Insights -->
        <div class="card p-3 mb-3">
          <div class="flex items-center justify-between mb-2">
            <div>
              <h3 class="text-xs font-semibold text-hl-text uppercase">
                AI Insights
              </h3>
              <p
                v-if="agentStore.currentInsights?.generatedAt"
                class="text-[10px] text-text-muted mt-0.5"
              >
                Analysed {{ agentStore.currentInsights.callCount }} call{{ agentStore.currentInsights.callCount === 1 ? '' : 's' }}
                · {{ insightsAge }}
                · OpenAI gpt-4o-mini
              </p>
            </div>
            <button
              class="text-[11px] px-2 py-1 rounded-sm border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-primary disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="agentStore.insightsLoading"
              title="Re-runs the AI analysis across this agent's recent calls. Costs ~$0.005 in OpenAI."
              @click="reanalyseInsights"
            >
              {{ agentStore.insightsLoading ? '…' : '↻ Re-analyse' }}
            </button>
          </div>
          <LoadingSpinner
            v-if="agentStore.insightsLoading && !agentStore.currentInsights"
            size="sm"
            label="Analyzing call history..."
          />
          <div v-else-if="agentStore.currentInsights && agentStore.currentInsights.patternedIssues?.length">
            <p class="text-xs text-hl-muted mb-2 leading-relaxed">
              {{ agentStore.currentInsights.summary }}
            </p>
            <div
              v-for="(p, i) in agentStore.currentInsights.patternedIssues"
              :key="i"
              class="border-t border-hl-border first:border-0 pt-2 first:pt-0 mt-2 first:mt-0"
            >
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs font-semibold">{{ p.pattern }}</span>
                <span :class="`badge-${p.recommendation?.severity || 'suggestion'}`">
                  {{ p.recommendation?.severity }}
                </span>
              </div>
              <p class="text-xs text-hl-muted leading-relaxed">
                {{ p.recommendation?.detail }}
              </p>
              <p
                v-if="p.recommendation?.suggestedChange"
                class="text-[11px] mt-1 bg-hl-bg p-2 rounded font-mono text-hl-text leading-relaxed"
              >
                {{ p.recommendation.suggestedChange }}
              </p>
            </div>
          </div>
          <p
            v-else
            class="text-xs text-hl-muted"
          >
            No cross-call patterns detected yet.
          </p>
        </div>

        <!-- Calls with status filters -->
        <div class="card p-3">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-xs font-semibold text-hl-text uppercase">
              Calls ({{ callStore.totalCalls }})
            </h3>
          </div>

          <div class="flex gap-1 mb-2 overflow-x-auto">
            <button
              v-for="opt in statusOptions"
              :key="opt.value"
              class="px-2 py-0.5 text-[11px] rounded-full border whitespace-nowrap transition-colors"
              :class="statusFilter === opt.value
                ? 'bg-hl-primary text-white border-hl-primary'
                : 'bg-hl-card text-hl-muted border-hl-border hover:border-hl-primary'"
              @click="setFilter(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>

          <LoadingSpinner
            v-if="callStore.loading && callStore.calls.length === 0"
            size="sm"
          />
          <EmptyState
            v-else-if="callStore.calls.length === 0"
            title="No calls in this filter"
            icon="🔍"
          />
          <div
            v-else
            class="space-y-1"
          >
            <RouterLink
              v-for="call in callStore.calls"
              :key="call.id"
              :to="`/calls/${call.id}`"
              class="block p-2 rounded hover:bg-hl-bg transition-colors text-xs"
            >
              <div class="flex items-center justify-between">
                <span :class="`badge-${call.status || 'suggestion'}`">
                  {{ statusIcon(call.status) }} {{ call.overall_score ?? '—' }}
                </span>
                <span class="font-mono text-hl-muted text-[10px]">
                  {{ formatTime(call.call_timestamp) }}
                </span>
              </div>
              <div class="mt-1 text-hl-muted truncate">
                {{ call.topIssue || call.outcome }}
              </div>
            </RouterLink>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<script setup>
import { onMounted, watch, computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useAgentStore } from '@/stores/agentStore'
import { useCallStore } from '@/stores/callStore'
import AppShell from '@/components/AppShell.vue'
import BackLink from '@/components/BackLink.vue'
import HealthDonut from '@/components/HealthDonut.vue'
import AgentHorizontalFlywheel from '@/components/AgentHorizontalFlywheel.vue'
import KpiEditor from '@/components/KpiEditor.vue'
import KpiRadar from '@/components/KpiRadar.vue'
import KpiBars from '@/components/KpiBars.vue'
import StatusBar from '@/components/StatusBar.vue'
import WorstKpiBadge from '@/components/WorstKpiBadge.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'

const route = useRoute()
const agentStore = useAgentStore()
const callStore = useCallStore()

const agent = computed(() => agentStore.currentAgent)
const hasKpiScores = computed(() =>
  agent.value && Object.keys(agent.value.performance.kpiScores || {}).length > 0
)

const statusFilter = ref('all')
const statusOptions = [
  { value: 'all',     label: 'All' },
  { value: 'pass',    label: '✓ Pass' },
  { value: 'warning', label: '⚠ Warn' },
  { value: 'fail',    label: '✗ Fail' },
]

async function loadAll() {
  const id = route.params.id
  await agentStore.fetchAgent(id)
  agentStore.fetchInsights(id)
  await callStore.fetchCalls(id, { limit: 20, status: statusFilter.value })
}

function setFilter(value) {
  statusFilter.value = value
  callStore.fetchCalls(route.params.id, { limit: 20, status: value })
}

onMounted(loadAll)
watch(() => route.params.id, () => {
  statusFilter.value = 'all'
  loadAll()
})

// Force-regenerate AI insights (Re-analyse button on the AI Insights card).
// Costs 1 OpenAI call (~$0.005). Gated behind explicit user click — never
// auto-triggered.
function reanalyseInsights() {
  agentStore.fetchInsights(route.params.id, { refresh: true })
}

// "3h ago" relative time for the insights freshness line
const insightsAge = computed(() => {
  const iso = agentStore.currentInsights?.generatedAt
  if (!iso) return ''
  const ms = Date.now() - new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')).getTime()
  if (ms < 0 || Number.isNaN(ms)) return ''
  const min = ms / 60000
  if (min < 1)            return 'just now'
  if (min < 60)           return `${Math.round(min)}m ago`
  if (min < 60 * 24)      return `${Math.round(min / 60)}h ago`
  return `${Math.round(min / (60 * 24))}d ago`
})

function onKpisUpdated(updatedKpis) {
  // Mutate the current agent's KPI definitions in-place via the store so the
  // KpiBars + worstKpi pickup the new thresholds without a refetch.
  if (agentStore.currentAgent) {
    agentStore.currentAgent.kpiDefinitions = updatedKpis
  }
}

function trendColor(trend) {
  if (trend === 'up') return 'text-hl-pass'
  if (trend === 'down') return 'text-hl-fail'
  return 'text-hl-muted'
}

function trendIcon(trend) {
  if (trend === 'up') return '↑ trending up'
  if (trend === 'down') return '↓ declining'
  return '→ stable'
}

function statusIcon(s) {
  if (s === 'pass') return '✓'
  if (s === 'warning') return '⚠'
  if (s === 'fail') return '✗'
  return '○'
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
</script>
