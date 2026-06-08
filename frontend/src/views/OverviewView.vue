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
      <button
        class="btn-primary text-xs px-3 py-1.5"
        :disabled="syncingAll"
        @click="onSyncAll"
      >
        {{ syncingAll ? 'Syncing…' : '↻ Sync All' }}
      </button>
    </template>

    <div class="p-6 space-y-4">
      <!-- Loading / empty / error -->
      <LoadingSpinner
        v-if="loading && !summary"
        full-page
        label="Loading observability data…"
      />
      <ErrorState
        v-else-if="error && !summary"
        title="Failed to load dashboard"
        :message="error.message"
        :on-retry="reload"
      />
      <EmptyState
        v-else-if="summary && summary.totalAgents === 0"
        icon="📊"
        title="No agents yet"
        subtitle="Install the Marketplace App on a sub-account that has Voice AI agents."
      />

      <template v-else-if="summary">
        <!-- First-time welcome card — dismissable, persists in localStorage -->
        <div
          v-if="showWelcome"
          class="card p-3 border-l-4 border-l-accent-primary bg-accent-primary/5"
        >
          <div class="flex items-start gap-3">
            <span class="text-base leading-none mt-0.5">👋</span>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-semibold text-text-primary mb-1">
                Welcome to AI Copilot
              </div>
              <p class="text-xs text-text-secondary leading-relaxed mb-2">
                This dashboard auto-scores every Voice AI call against your agent's KPIs,
                surfaces the issues, suggests fixes, and measures whether those fixes worked.
                Three places to start:
              </p>
              <ul class="text-xs text-text-secondary space-y-1 mb-2">
                <li>
                  <strong class="text-text-primary">♻️ Flywheel</strong> — the full loop
                  overview (issues → recommendations → applied → measured)
                </li>
                <li>
                  <strong class="text-text-primary">🔍 Patterns</strong> — recurring
                  failure clusters across your agents, with paste-ready fixes
                </li>
                <li>
                  <strong class="text-text-primary">⚠️ Actions</strong> — moments the AI
                  flagged for human follow-up
                </li>
              </ul>
              <div class="flex gap-2 mt-2">
                <RouterLink
                  to="/flywheel"
                  class="text-xs px-2.5 py-1 rounded-card bg-accent-primary text-white font-semibold hover:bg-accent-secondary"
                >
                  Start with Flywheel →
                </RouterLink>
                <RouterLink
                  to="/patterns"
                  class="text-xs px-2.5 py-1 rounded-card border border-border-subtle text-text-secondary hover:text-text-primary"
                >
                  Or jump to Patterns
                </RouterLink>
              </div>
            </div>
            <button
              class="text-text-muted hover:text-text-primary text-xs"
              title="Dismiss (won't show again)"
              @click="dismissWelcome"
            >
              ✕
            </button>
          </div>
        </div>

        <!-- Sync status banner -->
        <div
          v-if="syncStatus"
          class="card p-3 border-accent-primary/30"
        >
          <div class="flex items-center gap-2 text-xs">
            <LoadingSpinner
              v-if="syncStatus.phase === 'running'"
              size="sm"
            />
            <span
              v-else
              class="text-pass"
            >✓</span>
            <span class="text-text-primary">{{ syncStatus.message }}</span>
          </div>
        </div>

        <!-- Row 1: hero metrics -->
        <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <MetricHeroCard
            label="Total Calls"
            :value="summary.hero.totalCalls.value"
            :delta="summary.hero.totalCalls.delta"
            icon="📞"
            tone="primary"
          />
          <MetricHeroCard
            label="Success Rate"
            :value="summary.hero.successRate.value"
            :delta="summary.hero.successRate.delta"
            icon="✓"
            tone="success"
            format="percent"
          />
          <MetricHeroCard
            label="Avg Call Duration"
            :value="summary.hero.avgDuration.value"
            :delta="summary.hero.avgDuration.delta"
            icon="⏱"
            tone="secondary"
            format="duration"
          />
          <MetricHeroCard
            label="KPI Avg"
            :value="summary.hero.avgHealthScore.value"
            :delta="summary.hero.avgHealthScore.delta"
            icon="🎯"
            tone="primary"
            format="score"
          />
          <MetricHeroCard
            label="Actions Required"
            :value="summary.hero.actionsRequired.value"
            :delta="summary.hero.actionsRequired.delta"
            icon="⚠"
            tone="fail"
            :invert-delta="true"
          />
        </div>

        <!-- Row 2: Monitor → Analyze hero (FSB Core Functionality framing) -->
        <MonitorAnalyzeHero :summary="flywheelSummary" />

        <!-- Row 3: Flywheel snapshot + Agent Status Strip -->
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-3">
          <div class="lg:col-span-2">
            <FlywheelSnapshotTile :summary="flywheelSummary" />
          </div>
          <div class="lg:col-span-3">
            <AgentStatusStrip :agents="augmentedAgents" />
          </div>
        </div>

        <!-- Demo-scale banner (only when ?demo-scale=N is set) -->
        <div
          v-if="demoScale > 0"
          class="card p-2 border-accent-secondary/40 bg-accent-secondary/5 text-[11px] flex items-center gap-2"
        >
          <span class="text-accent-secondary">🧪</span>
          <span class="text-text-secondary">
            <strong class="text-text-primary">Demo scale active:</strong>
            {{ syntheticAgents.length }} synthetic agents added to the
            <em>Agents vs Success Criteria</em> card (deterministic — same URL = same data).
            Other widgets show real backend data only.
          </span>
          <RouterLink
            to="/"
            class="ml-auto text-accent-primary-text hover:underline"
          >
            Reset →
          </RouterLink>
        </div>

        <!-- Row 4: KPI Performance (radar) -->
        <div class="card p-4">
          <div class="chart-title">
            KPI Performance (all agents)
          </div>
          <div class="chart-subtitle">
            Averaged across calls in window
          </div>
          <KpiRadar
            v-if="hasKpis"
            :kpi-definitions="kpiDefsForRadar"
            :kpi-scores="summary.kpiPerformance"
          />
          <EmptyState
            v-else
            title="No KPI data yet"
            icon="📈"
          />
        </div>

        <!-- Row 4: failure reasons + sentiment trend -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <FailureReasonsList :items="summary.topFailureReasons" />
          <SentimentTrend :trend="summary.sentimentTrend" />
        </div>

        <!-- Row 5: calls needing attention + recommendations -->
        <div class="grid grid-cols-1 lg:grid-cols-5 gap-3">
          <div class="lg:col-span-3">
            <CallsNeedingAttention :calls="summary.callsNeedingAttention" />
          </div>
          <div class="lg:col-span-2">
            <AggregatedRecommendations :items="summary.aggregatedRecommendations" />
          </div>
        </div>
      </template>
    </div>
  </AppShell>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useAgentStore } from '@/stores/agentStore'
import { useCallStore } from '@/stores/callStore'
import client from '@/api/client'
import { generateSyntheticAgents } from '@/utils/demoAgents'

import AppShell from '@/components/AppShell.vue'
import MetricHeroCard from '@/components/MetricHeroCard.vue'
import MonitorAnalyzeHero from '@/components/MonitorAnalyzeHero.vue'
import FlywheelSnapshotTile from '@/components/FlywheelSnapshotTile.vue'
import AgentStatusStrip from '@/components/AgentStatusStrip.vue'
import KpiRadar from '@/components/KpiRadar.vue'
import FailureReasonsList from '@/components/FailureReasonsList.vue'
import SentimentTrend from '@/components/SentimentTrend.vue'
import CallsNeedingAttention from '@/components/CallsNeedingAttention.vue'
import AggregatedRecommendations from '@/components/AggregatedRecommendations.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'

const agentStore = useAgentStore()
const callStore = useCallStore()
const route = useRoute()

const rangeDays = ref(30)
const summary = ref(null)
const flywheelSummary = ref(null)
const loading = ref(false)

// First-time welcome card — persists dismissal in localStorage
const WELCOME_DISMISSED_KEY = 'copilot.welcomeDismissed'
const showWelcome = ref(
  typeof window !== 'undefined' && !localStorage.getItem(WELCOME_DISMISSED_KEY)
)
function dismissWelcome() {
  showWelcome.value = false
  if (typeof window !== 'undefined') localStorage.setItem(WELCOME_DISMISSED_KEY, '1')
}

// ─── Demo-scale switch ──────────────────────────────────────────────
// Visit /dashboard/?demo-scale=100 to pad AgentStatusStrip with 100 synthetic
// agents (deterministic per index). Useful for showing the scale-aware UX
// without needing 100 real HL agents. Only affects the agent strip — other
// widgets render real backend data only.
const demoScale = computed(() => {
  const n = parseInt(route.query['demo-scale'], 10)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 0
})

const syntheticAgents = computed(() =>
  demoScale.value > 0 ? generateSyntheticAgents(demoScale.value) : []
)

const augmentedAgents = computed(() => {
  if (!summary.value) return []
  if (demoScale.value === 0) return summary.value.agentStatusStrip
  return [...summary.value.agentStatusStrip, ...syntheticAgents.value]
})
const error = ref(null)
const syncingAll = ref(false)
const syncStatus = ref(null)

async function reload() {
  loading.value = true
  error.value = null
  try {
    const [dashboardRes, flywheelRes] = await Promise.all([
      client.get('/dashboard/summary', { params: { days: rangeDays.value } }),
      client.get('/flywheel/summary',  { params: { days: rangeDays.value } }),
    ])
    summary.value = dashboardRes.data
    flywheelSummary.value = flywheelRes.data
    agentStore.dashboardSummary = dashboardRes.data    // keep legacy stores aligned
    agentStore.agents = dashboardRes.data.agents
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

onMounted(reload)

async function onSyncAll() {
  syncingAll.value = true
  syncStatus.value = { phase: 'running', message: 'Scanning HighLevel for new calls across all agents…' }
  const result = await callStore.syncAll()
  if (result) {
    const callChanges = result.results
      .filter((r) => r.newCallsCount > 0)
      .map((r) => `${r.agentName}: +${r.newCallsCount}`)
      .join(', ')

    const bits = []
    if (result.newAgentCount > 0) {
      bits.push(`+${result.newAgentCount} new agent${result.newAgentCount > 1 ? 's' : ''} discovered`)
    }
    if (result.totalNew > 0) {
      bits.push(`+${result.totalNew} new call${result.totalNew > 1 ? 's' : ''} (${callChanges})`)
    }

    syncStatus.value = {
      phase: 'done',
      message: bits.length
        ? `${bits.join(' · ')}. Refreshing…`
        : `All ${result.agentsScanned} agents up to date. Refreshing…`,
    }
    await reload()
  } else {
    syncStatus.value = { phase: 'error', message: 'Sync All failed — check backend logs' }
  }
  setTimeout(() => { syncStatus.value = null }, 5000)
  syncingAll.value = false
}

const hasKpis = computed(() => summary.value && Object.keys(summary.value.kpiPerformance || {}).length > 0)

const kpiDefsForRadar = computed(() => {
  if (!summary.value?.agentStatusStrip?.[0]) return []
  return summary.value.agentStatusStrip[0].kpis.map((k) => ({
    name: k.name, label: k.label, threshold: k.threshold,
  }))
})
</script>
