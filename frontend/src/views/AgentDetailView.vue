<template>
  <AppShell>
    <template #back>
      <BackLink label="Overview" to="/" />
    </template>
    <template #filters>
      <!-- V5.5 — period selector matching dashboard for consistency -->
      <select
        v-model.number="rangeDays"
        class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5"
        @change="loadAll"
      >
        <option :value="7">Last 7 days</option>
        <option :value="14">Last 14 days</option>
        <option :value="30">Last 30 days</option>
        <option :value="90">Last 90 days</option>
      </select>
    </template>

    <div class="p-6 space-y-4">
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

      <template v-else-if="agent">
        <!-- ════════ HERO — health, stats, primary actions ═══════════════ -->
        <section class="card p-4">
          <div class="flex items-start gap-4">
            <HealthDonut :score="agent.performance.healthScore" :size="80" />
            <div class="flex-1 min-w-0">
              <h2 class="text-lg font-bold text-text-primary truncate">{{ agent.name }}</h2>
              <p class="text-xs text-text-secondary mt-0.5 leading-relaxed line-clamp-2">
                {{ agent.goal }}
              </p>
              <!-- Quick stats — 4 numbers that answer "is this agent healthy?" -->
              <div v-if="qs" class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div class="bg-bg-elevated rounded-card p-2">
                  <div class="text-[10px] text-text-muted uppercase">Calls</div>
                  <div class="text-text-primary font-bold font-mono">{{ qs.totalCalls }}</div>
                  <div
                    v-if="qs.totalCallsDelta !== 0"
                    class="text-[10px] font-mono"
                    :class="qs.totalCallsDelta > 0 ? 'text-pass' : 'text-fail-text'"
                  >
                    {{ qs.totalCallsDelta > 0 ? '↑' : '↓' }} {{ Math.abs(qs.totalCallsDelta) }} vs prior {{ rangeDays }}d
                  </div>
                </div>
                <div class="bg-bg-elevated rounded-card p-2">
                  <div class="text-[10px] text-text-muted uppercase">Conversion</div>
                  <div class="text-text-primary font-bold font-mono">{{ qs.conversionRate }}%</div>
                  <div class="text-[10px] text-text-muted">{{ qs.conversionCount }} of {{ qs.totalCalls }}</div>
                </div>
                <div class="bg-bg-elevated rounded-card p-2">
                  <div class="text-[10px] text-text-muted uppercase">KPI Pass Rate</div>
                  <div class="text-text-primary font-bold font-mono">{{ qs.kpiPassRate }}%</div>
                  <div class="text-[10px] text-text-muted">{{ qs.passCount }} passing</div>
                </div>
                <div class="bg-bg-elevated rounded-card p-2">
                  <div class="text-[10px] text-text-muted uppercase">Cycle Time</div>
                  <div class="text-text-primary font-bold font-mono">
                    {{ qs.avgCycleDays !== null ? qs.avgCycleDays + 'd' : '—' }}
                  </div>
                  <div class="text-[10px] text-text-muted">issue → fix</div>
                </div>
              </div>
              <!-- Trend + worst KPI in a single line — no duplication -->
              <div class="mt-2 flex items-center gap-2 flex-wrap text-[11px]">
                <span :class="trendColor(agent.performance.trend)">
                  {{ trendIcon(agent.performance.trend) }} vs prior 7d
                </span>
                <span v-if="agent.performance.worstKpi" class="text-text-muted">·</span>
                <WorstKpiBadge v-if="agent.performance.worstKpi" :worst-kpi="agent.performance.worstKpi" />
                <span v-if="qs?.hallucinationCalls > 0" class="text-text-muted">·</span>
                <span
                  v-if="qs?.hallucinationCalls > 0"
                  class="badge-fail"
                  :title="`${qs.hallucinationCalls} calls where the agent made unverified factual claims — brand/legal risk, review them first`"
                >
                  ⚠ {{ qs.hallucinationCalls }} calls with unverified claims
                </span>
              </div>
            </div>
          </div>
          <StatusBar
            class="mt-3"
            :pass="agent.performance.statusDistribution?.pass || 0"
            :warning="agent.performance.statusDistribution?.warning || 0"
            :fail="agent.performance.statusDistribution?.fail || 0"
            :show-labels="true"
          />
        </section>

        <!-- ════════ USE ACTIONS — FSB-required "Highlight Use Actions" ═══ -->
        <section v-if="agent.useActionsBreakdown?.length > 0" class="card p-4">
          <div class="flex items-center justify-between mb-2">
            <div>
              <h3 class="text-sm font-semibold text-text-primary">Use Actions for this agent</h3>
              <p class="text-[11px] text-text-muted">
                Moments the AI flagged for human follow-up — operational queue.
                Resolving these doesn't change the agent itself; for agent improvement see recommendations below.
              </p>
            </div>
          </div>
          <div class="space-y-1.5">
            <div
              v-for="ua in agent.useActionsBreakdown"
              :key="ua.actionType"
              class="flex items-center gap-2 text-xs flex-wrap"
            >
              <span class="text-base shrink-0">{{ useActionIcon(ua.actionType) }}</span>
              <span class="font-semibold text-text-primary capitalize">
                {{ ua.actionType.replace(/_/g, ' ') }}
              </span>
              <span class="text-text-secondary font-mono">{{ ua.total }}</span>
              <span
                v-if="ua.pending > 0"
                class="text-[10px] text-fail-text"
              >({{ ua.pending }} pending)</span>
              <span
                v-if="ua.escalated > 0"
                class="text-[10px] text-warn"
              >· {{ ua.escalated }} escalated</span>
              <span
                v-if="ua.resolved > 0"
                class="text-[10px] text-pass"
              >· {{ ua.resolved }} resolved</span>
              <RouterLink
                :to="`/actions?agentId=${agent.id}`"
                class="ml-auto text-[10px] text-accent-primary-text hover:underline shrink-0"
              >
                View queue →
              </RouterLink>
            </div>
          </div>
        </section>

        <!-- ════════ V5.6 — PER-AGENT CALLER MOOD TREND ═════════════════ -->
        <!-- Reuses the SentimentTrend component from the Overview page.
             Empty `agents` list hides the dropdown (we're already on the
             agent). Spike footer auto-links to /patterns?agentId=…
             since computeSentimentSpike was passed this agent's id. -->
        <SentimentTrend
          v-if="agent.sentimentTrend"
          :trend="agent.sentimentTrend"
          :spike="agent.sentimentSpike"
          :thresholds="agent.sentimentBucketThresholds"
          :agents="[]"
          :current-agent-id="agent.id"
        />

        <!-- ════════ PER-AGENT FLYWHEEL (existing component) ═════════════ -->
        <AgentHorizontalFlywheel :agent-id="agent.id" :agent-name="agent.name" />

        <!-- ════════ RECURRING ISSUES + APPLIED PROOF ════════════════════ -->
        <!-- One card with three sub-sections: deviations, missed opps,
             recently applied (V5.5 — closes the FSB "identify deviations
             + immediate recommendations + Validation Flywheel" loop). -->
        <section class="card p-4 space-y-4">
          <div>
            <h3 class="text-sm font-semibold text-text-primary mb-2">
              📐 Recurring Deviations
              <span class="text-[11px] text-text-muted font-normal ml-2">
                Where this agent strays from its script
              </span>
            </h3>
            <div v-if="agent.deviationsAggregate?.length > 0" class="space-y-1 text-xs">
              <div
                v-for="(d, i) in agent.deviationsAggregate"
                :key="i"
                class="flex items-start gap-2 leading-relaxed"
              >
                <span class="text-fail-text font-bold mt-0.5 shrink-0">•</span>
                <span class="flex-1 min-w-0">
                  <span class="text-text-primary">{{ d.description }}</span>
                  <span class="text-text-muted ml-1 font-mono">
                    — {{ d.callCount }} of {{ qs?.totalCalls || 0 }} calls ({{ Math.round((d.callCount / (qs?.totalCalls || 1)) * 100) }}%)
                  </span>
                </span>
              </div>
            </div>
            <p v-else class="text-xs text-text-muted">
              No recurring deviations detected — script adherence looks clean.
            </p>
          </div>

          <div>
            <h3 class="text-sm font-semibold text-text-primary mb-2">
              💡 Missed Opportunities
              <span class="text-[11px] text-text-muted font-normal ml-2">
                Value the agent could have captured but didn't
              </span>
            </h3>
            <div v-if="agent.missedOpportunitiesAggregate?.length > 0" class="space-y-1 text-xs">
              <div
                v-for="(m, i) in agent.missedOpportunitiesAggregate"
                :key="i"
                class="flex items-start gap-2 leading-relaxed"
              >
                <span class="text-warn font-bold mt-0.5 shrink-0">•</span>
                <span class="flex-1 min-w-0">
                  <span class="text-text-primary">{{ m.description }}</span>
                  <span class="text-text-muted ml-1 font-mono">
                    — {{ m.callCount }} of {{ qs?.totalCalls || 0 }} calls
                  </span>
                </span>
              </div>
            </div>
            <p v-else class="text-xs text-text-muted">
              No missed opportunities flagged in this window.
            </p>
          </div>

          <div class="border-t border-border-subtle pt-3">
            <h3 class="text-sm font-semibold text-text-primary mb-2">
              ✅ Recently Applied — measurement proof
              <span class="text-[11px] text-text-muted font-normal ml-2">
                Did the applied fixes actually move scores?
              </span>
            </h3>
            <div v-if="agent.recentlyApplied?.length > 0" class="space-y-1.5">
              <div
                v-for="r in agent.recentlyApplied"
                :key="r.id"
                class="flex items-center gap-2 text-xs flex-wrap"
              >
                <span class="shrink-0">{{ appliedStatusIcon(r.status) }}</span>
                <span class="text-text-primary font-semibold truncate flex-1 min-w-0">{{ r.title }}</span>
                <span v-if="r.delta !== null" class="font-mono shrink-0" :class="r.delta > 0 ? 'text-pass' : 'text-fail-text'">
                  {{ r.delta > 0 ? '+' : '' }}{{ r.delta }} pts
                </span>
                <span class="text-text-muted text-[10px] shrink-0">
                  {{ r.afterSampleSize ? `(n=${r.afterSampleSize})` : '(measuring…)' }}
                </span>
                <span class="text-text-muted text-[10px] shrink-0">
                  {{ relativeTime(r.appliedAt) }}
                </span>
              </div>
            </div>
            <p v-else class="text-xs text-text-muted">
              No recommendations applied yet. Open
              <RouterLink to="/patterns" class="text-accent-primary-text hover:underline">Recommendations</RouterLink>
              to pick one.
            </p>
          </div>
        </section>

        <!-- ════════ KPI PERFORMANCE — bars + editor ═════════════════════ -->
        <section class="card p-4">
          <div class="flex items-center justify-between mb-2">
            <h3 class="text-sm font-semibold text-text-primary">KPI Performance</h3>
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
          <EmptyState v-else title="No KPI data yet" icon="📈" />
        </section>

        <details class="card p-4">
          <summary class="text-sm font-semibold text-text-primary cursor-pointer">
            Radar Profile (KPI pattern view)
          </summary>
          <KpiRadar
            v-if="hasKpiScores"
            class="mt-2"
            :kpi-definitions="agent.kpiDefinitions"
            :kpi-scores="agent.performance.kpiScores"
          />
        </details>

        <!-- ════════ AI INSIGHTS — now ACTIONABLE with Apply buttons ═════ -->
        <section class="card p-4">
          <div class="flex items-center justify-between mb-2">
            <div>
              <h3 class="text-sm font-semibold text-text-primary">AI Insights</h3>
              <p
                v-if="agentStore.currentInsights?.generatedAt"
                class="text-[11px] text-text-muted mt-0.5"
              >
                Analysed {{ agentStore.currentInsights.callCount }} call{{ agentStore.currentInsights.callCount === 1 ? '' : 's' }}
                · {{ insightsAge }} · OpenAI gpt-4o-mini
              </p>
            </div>
            <button
              class="text-[11px] px-2 py-1 rounded-sm border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-primary disabled:opacity-50 disabled:cursor-not-allowed"
              :disabled="agentStore.insightsLoading"
              title="Re-runs the AI analysis across this agent's recent calls. Costs ~$0.005."
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
            <p class="text-xs text-text-secondary mb-3 leading-relaxed">
              {{ agentStore.currentInsights.summary }}
            </p>
            <div
              v-for="(p, i) in agentStore.currentInsights.patternedIssues"
              :key="i"
              class="border-t border-border-subtle first:border-0 pt-3 first:pt-0 mt-3 first:mt-0"
            >
              <div class="flex items-start justify-between gap-2 mb-1">
                <div class="min-w-0 flex-1">
                  <span class="text-xs font-semibold text-text-primary">{{ p.pattern }}</span>
                  <span :class="`badge-${p.recommendation?.severity || 'suggestion'} ml-2`">
                    {{ p.recommendation?.severity }}
                  </span>
                </div>
                <!-- V5.5 — Apply button (one-click apply via the existing modal) -->
                <ApplyRecommendationButton
                  v-if="p.recommendation?.id"
                  class="shrink-0"
                  :recommendation="{
                    id: p.recommendation.id,
                    agentId: agent.id,
                    title: p.pattern,
                    severity: p.recommendation.severity,
                  }"
                  :agent-name="agent.name"
                  @applied="loadAll"
                />
              </div>
              <p class="text-xs text-text-secondary leading-relaxed">
                {{ p.recommendation?.detail }}
              </p>
              <p
                v-if="p.recommendation?.suggestedChange"
                class="text-[11px] mt-1 bg-bg-elevated p-2 rounded font-mono text-text-primary leading-relaxed"
              >
                {{ p.recommendation.suggestedChange }}
              </p>
            </div>
            <div class="mt-3 text-xs">
              <RouterLink
                :to="`/patterns?agentId=${agent.id}`"
                class="text-accent-primary-text hover:underline"
              >
                See all patterns for this agent →
              </RouterLink>
            </div>
          </div>
          <p v-else class="text-xs text-text-muted">
            No cross-call patterns detected yet.
          </p>
        </section>

        <!-- ════════ CALLS — V5.9 redesigned list ════════════════════════ -->
        <!--
          Goals (PM):
            1. Fix the bug: total said "47" but only 20 rendered → Load more.
            2. Help the user scan: card rows with caller, duration, time-ago,
               grouped by day (Today / Yesterday / date).
            3. Help the user find: sort dropdown + free-text search.
            4. Help the user triage hallucinations (highest-stakes signal):
               red left border + amber banner with count + tooltip with
               the most concerning claim — no need to open every call.
        -->
        <section class="card p-4">
          <div class="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <h3 class="text-sm font-semibold text-text-primary">
              Calls
              <span class="text-text-muted font-normal text-[11px] ml-1">
                showing {{ callStore.calls.length }} of {{ callStore.totalCalls }}
              </span>
            </h3>
            <div class="flex items-center gap-2 flex-wrap">
              <input
                v-model.trim="searchInput"
                type="search"
                placeholder="🔎 caller or issue"
                class="bg-bg-elevated border border-border-subtle text-text-primary text-xs rounded-card px-2 py-1 w-44 placeholder:text-text-muted"
                @input="onSearchInput"
                @keyup.enter="applyCallFilters"
              />
              <select
                v-model="sortBy"
                class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1"
                @change="applyCallFilters"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="score_asc">Lowest score</option>
                <option value="score_desc">Highest score</option>
                <option value="duration_desc">Longest</option>
                <option value="duration_asc">Shortest</option>
              </select>
            </div>
          </div>

          <div class="flex gap-1 mb-3 overflow-x-auto pb-1">
            <button
              v-for="opt in callFilterOptions"
              :key="opt.value"
              class="px-2 py-0.5 text-[11px] rounded-full border whitespace-nowrap transition-colors"
              :class="activeFilter === opt.value
                ? 'bg-accent-primary text-white border-accent-primary'
                : 'bg-bg-elevated text-text-secondary border-border-subtle hover:border-accent-primary'"
              :title="opt.tooltip"
              @click="setCallFilter(opt.value)"
            >
              {{ opt.label }}
            </button>
          </div>

          <LoadingSpinner v-if="callStore.loading && callStore.calls.length === 0" size="sm" />
          <EmptyState v-else-if="callStore.calls.length === 0" title="No calls match" icon="🔍" />

          <div v-else class="space-y-3">
            <div v-for="group in callGroups" :key="group.label">
              <!-- Day-grouping header (skipped when sorted by score/duration since
                   the dates won't be contiguous and grouping adds noise) -->
              <div
                v-if="showDayGroups"
                class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1.5 px-1"
              >
                {{ group.label }}
              </div>
              <div class="space-y-1.5">
                <RouterLink
                  v-for="call in group.calls"
                  :key="call.id"
                  :to="`/calls/${call.id}`"
                  class="block rounded-card hover:bg-bg-elevated transition-colors text-xs overflow-hidden border-l-4"
                  :class="call.hasHallucination
                    ? 'border-l-fail-text bg-fail/5'
                    : 'border-l-transparent'"
                >
                  <!-- Layer 2: visual prominence banner for hallucinated calls.
                       Tooltip surfaces the most concerning claim (Layer 3). -->
                  <div
                    v-if="call.hasHallucination"
                    class="px-3 py-1 bg-fail/15 text-fail-text font-semibold border-b border-fail-text/30 flex items-center gap-2"
                    :title="call.topHallucinationQuote
                      ? `Most concerning unverified claim: \&quot;${call.topHallucinationQuote}\&quot;\n\nClick to review all ${call.unverifiedClaimsCount} claim${call.unverifiedClaimsCount > 1 ? 's' : ''}.`
                      : 'Click to review the unverified claims in this call'"
                  >
                    <span class="shrink-0">⚠</span>
                    <span class="shrink-0">
                      {{ call.unverifiedClaimsCount }} unverified
                      claim{{ call.unverifiedClaimsCount > 1 ? 's' : '' }}
                    </span>
                    <span v-if="call.topHallucinationQuote" class="font-normal text-text-secondary truncate min-w-0">
                      — &ldquo;{{ call.topHallucinationQuote }}&rdquo;
                    </span>
                  </div>

                  <div class="p-2.5 space-y-1">
                    <!-- Line 1: status, score, caller, duration, time-ago -->
                    <div class="flex items-center gap-2 flex-wrap">
                      <span :class="`badge-${call.status || 'suggestion'} shrink-0`">
                        {{ statusIcon(call.status) }} {{ call.overall_score ?? '—' }}/100
                      </span>
                      <span v-if="call.caller_number" class="font-mono text-text-secondary shrink-0">
                        📞 {{ call.caller_number }}
                      </span>
                      <span v-if="call.duration" class="font-mono text-text-muted shrink-0">
                        ⏱ {{ formatDuration(call.duration) }}
                      </span>
                      <span
                        class="font-mono text-text-muted text-[10px] ml-auto shrink-0"
                        :title="formatDateTime(call.call_timestamp)"
                      >
                        {{ relativeTime(call.call_timestamp) }}
                      </span>
                    </div>
                    <!-- Line 2: top issue + use-actions badge -->
                    <div class="flex items-center gap-2 flex-wrap">
                      <span
                        class="text-text-secondary flex-1 min-w-0 truncate"
                        :title="call.topIssue || call.outcome || ''"
                      >
                        {{ call.topIssue || call.outcome || 'Clean — no issues flagged' }}
                      </span>
                      <span
                        v-if="call.useActionsCount > 0"
                        class="badge-warning shrink-0"
                        title="Moments flagged for human follow-up — open call to see details"
                      >
                        ⚡ {{ call.useActionsCount }}
                        use action{{ call.useActionsCount > 1 ? 's' : '' }}
                      </span>
                    </div>
                  </div>
                </RouterLink>
              </div>
            </div>

            <div v-if="callStore.hasMore" class="pt-1">
              <button
                class="w-full text-xs py-2 rounded-card border border-border-subtle text-text-secondary hover:text-text-primary hover:border-accent-primary disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="callStore.loadingMore"
                @click="callStore.loadMore"
              >
                {{ callStore.loadingMore
                  ? 'Loading…'
                  : `⬇ Load ${callStore.totalCalls - callStore.calls.length} more` }}
              </button>
            </div>
          </div>
        </section>
      </template>
    </div>
  </AppShell>
</template>

<script setup>
import { onMounted, watch, computed, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
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
import ApplyRecommendationButton from '@/components/ApplyRecommendationButton.vue'
import SentimentTrend from '@/components/SentimentTrend.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import EmptyState from '@/components/EmptyState.vue'
import ErrorState from '@/components/ErrorState.vue'

const route = useRoute()
const agentStore = useAgentStore()
const callStore = useCallStore()

const agent = computed(() => agentStore.currentAgent)
const qs = computed(() => agent.value?.quickStats)
const hasKpiScores = computed(() =>
  agent.value && Object.keys(agent.value.performance.kpiScores || {}).length > 0
)

const rangeDays = ref(30)

// V5.9 — calls list controls. Chips map to (status, flag) pairs so we can
// express "Pass status" and "calls with unverified claims" with one model.
const CALL_PAGE_SIZE = 20
const activeFilter = ref('all')
const sortBy = ref('newest')
const searchInput = ref('')
const callFilterOptions = [
  { value: 'all',         label: 'All',           status: 'all',     flag: null,          tooltip: 'All calls' },
  { value: 'pass',        label: '✓ Pass',        status: 'pass',    flag: null,          tooltip: 'Calls that passed all KPI thresholds' },
  { value: 'warning',     label: '⚠ Warn',        status: 'warning', flag: null,          tooltip: 'Borderline calls — some KPIs missed threshold' },
  { value: 'fail',        label: '✗ Fail',        status: 'fail',    flag: null,          tooltip: 'Calls that failed overall scoring' },
  { value: 'unverified',  label: '⚠ Unverified',  status: 'all',     flag: 'unverified',  tooltip: 'Calls where the agent made unverified factual claims — brand/legal risk' },
  { value: 'use_actions', label: '⚡ Use Actions', status: 'all',     flag: 'use_actions', tooltip: 'Calls with moments flagged for human follow-up' },
]

// Day-grouping only makes sense for chronological sorts. Score/duration sorts
// would scatter dates → grouping would be visual noise.
const showDayGroups = computed(() => sortBy.value === 'newest' || sortBy.value === 'oldest')

const callGroups = computed(() => {
  if (!showDayGroups.value) {
    return [{ label: '', calls: callStore.calls }]
  }
  const today = startOfDay(new Date())
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const groups = new Map()
  for (const c of callStore.calls) {
    const label = c.call_timestamp ? dayLabel(new Date(c.call_timestamp), today, yesterday) : 'Unknown date'
    if (!groups.has(label)) groups.set(label, { label, calls: [] })
    groups.get(label).calls.push(c)
  }
  return [...groups.values()]
})

async function loadAll() {
  const id = route.params.id
  // V5.5 — pass days param so aggregates respect the period selector
  await agentStore.fetchAgent(id, { days: rangeDays.value })
  agentStore.fetchInsights(id)
  await applyCallFilters()
}

function applyCallFilters() {
  const f = callFilterOptions.find((o) => o.value === activeFilter.value) || callFilterOptions[0]
  return callStore.fetchCalls(route.params.id, {
    limit:  CALL_PAGE_SIZE,
    status: f.status,
    flag:   f.flag,
    sort:   sortBy.value,
    search: searchInput.value,
  })
}

function setCallFilter(value) {
  activeFilter.value = value
  applyCallFilters()
}

// Debounce search so we don't refetch on every keystroke
let searchTimer = null
function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(applyCallFilters, 300)
}

onMounted(loadAll)
watch(() => route.params.id, () => {
  activeFilter.value = 'all'
  sortBy.value = 'newest'
  searchInput.value = ''
  loadAll()
})

function reanalyseInsights() {
  agentStore.fetchInsights(route.params.id, { refresh: true })
}

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
  if (agentStore.currentAgent) {
    agentStore.currentAgent.kpiDefinitions = updatedKpis
  }
}

function trendColor(trend) {
  if (trend === 'up')   return 'text-pass'
  if (trend === 'down') return 'text-fail-text'
  return 'text-text-muted'
}
function trendIcon(trend) {
  if (trend === 'up')   return '↑ trending up'
  if (trend === 'down') return '↓ declining'
  return '→ stable'
}
function statusIcon(s) {
  if (s === 'pass')    return '✓'
  if (s === 'warning') return '⚠'
  if (s === 'fail')    return '✗'
  return '○'
}

// Tooltip variant — full date+time so hovering the row gives precise context
function formatDateTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
         ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

// Visible time-ago label — broader range so it covers "just now" up to >7d
function relativeTime(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const sec = Math.round(ms / 1000)
  if (sec < 60)        return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60)        return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24)         return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7)         return `${day}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// "2:14" for a 134-second call. Returns "—" for missing/invalid input.
function formatDuration(seconds) {
  const n = Number(seconds)
  if (!Number.isFinite(n) || n < 0) return '—'
  const m = Math.floor(n / 60)
  const s = Math.floor(n % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function startOfDay(d) {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x
}
function dayLabel(d, today, yesterday) {
  const day = startOfDay(d)
  if (day.getTime() === today.getTime())     return 'Today'
  if (day.getTime() === yesterday.getTime()) return 'Yesterday'
  return day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

// V5.5 — Use Action type → icon. Matches the categories used in analyses.
function useActionIcon(type) {
  return {
    human_intervention: '⚠',
    script_training:    '📚',
    escalation:         '↑',
    callback:           '📞',
    follow_up:          '📋',
  }[type] || '○'
}

// V5.5 — recently-applied status → icon + tone
function appliedStatusIcon(status) {
  if (status === 'measured_significant') return '✓'
  if (status === 'measured_minor')       return '→'
  if (status === 'measured_regression')  return '✗'
  return '⏳'  // waiting
}
</script>
