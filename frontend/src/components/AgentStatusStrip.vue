<template>
  <div class="card p-4">
    <!-- Header + status summary pills -->
    <div class="flex items-start justify-between mb-3 gap-4">
      <div class="min-w-0">
        <div class="chart-title">
          Agents vs Success Criteria
        </div>
        <div
          class="chart-subtitle"
          title="Per-agent KPI averages use last 10 analysed calls (a rolling baseline) regardless of the dashboard filter — so agents stay comparable across viewing windows."
        >
          Per-agent pass / warning / fail against each KPI threshold
          <span class="text-text-muted cursor-help">ⓘ</span>
        </div>
      </div>
      <div class="flex items-center gap-2 text-[10px] font-mono shrink-0 flex-wrap justify-end">
        <span class="badge-fail">✗ {{ counts.fail }} fail</span>
        <span class="badge-warning">⚠ {{ counts.warning }} warn</span>
        <span class="badge-pass">✓ {{ counts.pass }} pass</span>
        <span
          v-if="counts.no_data > 0"
          class="px-1.5 py-0.5 rounded-sm bg-bg-elevated text-text-muted border border-border-subtle"
        >○ {{ counts.no_data }} no data</span>
        <span class="text-text-muted">·  {{ counts.total }} total</span>
      </div>
    </div>

    <!-- Empty state -->
    <div
      v-if="!agents.length"
      class="text-xs text-text-muted py-6 text-center"
    >
      No agents yet.
    </div>

    <template v-else>
      <!-- Filter + sort controls — only show when worth it (>5 agents) -->
      <div
        v-if="agents.length > 5"
        class="flex gap-2 mb-3 items-center"
      >
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Search agents…"
          class="flex-1 bg-bg-elevated border border-border-subtle text-text-primary text-xs rounded-card px-2 py-1.5 placeholder:text-text-muted"
        >
        <select
          v-model="sortBy"
          class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5"
        >
          <option value="worst">
            Worst first
          </option>
          <option value="name">
            Name (A→Z)
          </option>
          <option value="callCount">
            Most calls
          </option>
        </select>
        <label class="flex items-center gap-1.5 text-[11px] text-text-secondary cursor-pointer whitespace-nowrap">
          <input
            v-model="failingOnly"
            type="checkbox"
            class="accent-accent-primary"
          >
          Failing only
        </label>
      </div>

      <!-- Filtered "no match" state -->
      <div
        v-if="!visibleAgents.length"
        class="text-xs text-text-muted py-6 text-center"
      >
        No agents match "{{ searchQuery }}".
      </div>

      <template v-else>
        <!-- Failing & Warning section (always visible) -->
        <section
          v-if="failingAgents.length"
          class="mb-3"
        >
          <div class="flex items-center justify-between mb-2">
            <h4 class="text-[11px] uppercase text-text-secondary tracking-wide font-medium">
              Needs attention ({{ failingAgents.length }})
            </h4>
            <span class="text-[10px] text-text-muted">sorted {{ sortLabel }}</span>
          </div>
          <div
            class="space-y-1.5"
            :class="needsAttentionScroll"
          >
            <AgentRow
              v-for="agent in failingAgents"
              :key="agent.agentId"
              :agent="agent"
            />
          </div>
        </section>

        <!-- Passing section (collapsible) -->
        <section v-if="passingAgents.length">
          <button
            class="w-full flex items-center justify-between py-2 px-2 -mx-2 rounded hover:bg-bg-elevated transition-colors text-[11px] uppercase tracking-wide text-text-secondary"
            @click="showPassing = !showPassing"
          >
            <span class="font-medium">
              <span class="inline-block w-3">{{ showPassing ? '▼' : '▶' }}</span>
              Passing ({{ passingAgents.length }})
            </span>
            <span class="text-[10px] text-text-muted normal-case">
              {{ showPassing ? 'click to collapse' : 'meeting all criteria — click to expand' }}
            </span>
          </button>
          <div
            v-if="showPassing"
            class="space-y-1.5 mt-1.5"
            :class="passingScroll"
          >
            <AgentRow
              v-for="agent in passingAgents"
              :key="agent.agentId"
              :agent="agent"
            />
          </div>
        </section>

        <!-- No-data section — agents that exist but haven't received any calls yet -->
        <section
          v-if="noDataAgents.length"
          class="mt-2"
        >
          <button
            class="w-full flex items-center justify-between py-2 px-2 -mx-2 rounded hover:bg-bg-elevated transition-colors text-[11px] uppercase tracking-wide text-text-secondary"
            @click="showNoData = !showNoData"
          >
            <span class="font-medium">
              <span class="inline-block w-3">{{ showNoData ? '▼' : '▶' }}</span>
              No calls yet ({{ noDataAgents.length }})
            </span>
            <span class="text-[10px] text-text-muted normal-case">
              {{ showNoData ? 'click to collapse' : 'agents configured but nothing ingested — click to expand' }}
            </span>
          </button>
          <div
            v-if="showNoData"
            class="space-y-1.5 mt-1.5"
          >
            <AgentRow
              v-for="agent in noDataAgents"
              :key="agent.agentId"
              :agent="agent"
            />
          </div>
        </section>
      </template>
    </template>

    <!-- KPI legend -->
    <div class="mt-3 pt-2 border-t border-border-subtle flex items-center gap-3 text-[10px] text-text-muted flex-wrap">
      <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-pass" /> Pass</span>
      <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-warn" /> Within 15pts</span>
      <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-fail" /> Below threshold</span>
      <span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-bg-elevated border border-border-subtle" /> No data</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, h } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({ agents: { type: Array, default: () => [] } })

// ─── Filter / sort state ──────────────────────────────────────────
const searchQuery = ref('')
const sortBy = ref('worst')
const failingOnly = ref(false)
// Default-collapse passing section once there are enough agents that the
// passing list would dominate the card visually. At small N, show everything.
const showPassing = ref(props.agents.length <= 10)
// No-data section starts collapsed by default — it's informational, not urgent
const showNoData = ref(false)

// ─── Derived agent properties ─────────────────────────────────────
function getOverallStatus(agent) {
  if (agent.kpis.some((k) => k.status === 'fail')) return 'fail'
  if (agent.kpis.some((k) => k.status === 'warning')) return 'warning'
  if (agent.kpis.every((k) => k.status === 'no_data')) return 'no_data'
  return 'pass'
}

// Higher = worse, used as the "worst first" sort key.
// Weights fail > warning so a single fail beats many warnings.
function getBadness(agent) {
  const fails = agent.kpis.filter((k) => k.status === 'fail').length
  const warns = agent.kpis.filter((k) => k.status === 'warning').length
  return fails * 10 + warns
}

const enriched = computed(() =>
  props.agents.map((a) => ({
    ...a,
    overallStatus: getOverallStatus(a),
    badness: getBadness(a),
    worstKpi: [...a.kpis]
      .filter((k) => k.status === 'fail' || k.status === 'warning')
      .sort((a, b) => (a.score ?? 100) - (b.score ?? 100))[0] ?? null,
  }))
)

const counts = computed(() => {
  const c = { fail: 0, warning: 0, pass: 0, no_data: 0, total: enriched.value.length }
  enriched.value.forEach((a) => { c[a.overallStatus]++ })
  return c
})

const sortLabel = computed(() => ({
  worst: 'worst first',
  name: 'A → Z',
  callCount: 'most calls first',
}[sortBy.value]))

// ─── Filter / sort pipeline ───────────────────────────────────────
const filtered = computed(() => {
  let list = enriched.value
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter((a) => a.agentName.toLowerCase().includes(q))
  }
  if (failingOnly.value) {
    list = list.filter((a) => a.overallStatus !== 'pass')
  }
  return list
})

const sorted = computed(() => {
  const list = [...filtered.value]
  if (sortBy.value === 'worst') return list.sort((a, b) => b.badness - a.badness)
  if (sortBy.value === 'name') return list.sort((a, b) => a.agentName.localeCompare(b.agentName))
  if (sortBy.value === 'callCount') return list.sort((a, b) => (b.callCount || 0) - (a.callCount || 0))
  return list
})

const visibleAgents = computed(() => sorted.value)
// Three buckets — no_data is its own thing, not "needs attention" and not "passing"
const failingAgents = computed(() => visibleAgents.value.filter((a) => a.overallStatus === 'fail' || a.overallStatus === 'warning'))
const passingAgents = computed(() => visibleAgents.value.filter((a) => a.overallStatus === 'pass'))
const noDataAgents  = computed(() => visibleAgents.value.filter((a) => a.overallStatus === 'no_data'))

// Cap visible heights so the card never dominates the viewport at high N
const needsAttentionScroll = computed(() =>
  failingAgents.value.length > 15 ? 'max-h-[480px] overflow-y-auto pr-1' : ''
)
const passingScroll = computed(() =>
  passingAgents.value.length > 15 ? 'max-h-[400px] overflow-y-auto pr-1' : ''
)

// ─── Inline AgentRow component ────────────────────────────────────
const AgentRow = (rowProps) => {
  const a = rowProps.agent
  const statusBorder = {
    fail: 'border-l-fail',
    warning: 'border-l-warn',
    pass: 'border-l-pass',
    no_data: 'border-l-border-subtle',
  }[a.overallStatus]

  const kpiClass = (status) => ({
    pass: 'bg-pass/15 text-pass border border-pass/30',
    warning: 'bg-warn/15 text-warn border border-warn/30',
    fail: 'bg-fail/15 text-fail border border-fail/30',
    no_data: 'bg-bg-elevated text-text-muted border border-border-subtle',
  }[status] || 'bg-bg-elevated text-text-muted border border-border-subtle')

  const shortLabel = (label) => label
    .replace('Call Completion', 'Compl')
    .replace('Script Adherence', 'Script')
    .replace('Objection Handling', 'Obj')
    .replace('Caller Sentiment', 'Sent')
    .replace('Response Quality', 'Resp')
    .replace('Escalation Rate', 'Esc')

  return h(RouterLink, {
    to: `/agents/${a.agentId}`,
    class: `flex items-center gap-3 py-1.5 px-2 -mx-2 rounded hover:bg-bg-elevated transition-colors border-l-2 ${statusBorder}`,
  }, () => [
    h('div', { class: 'w-36 min-w-0 flex flex-col' }, [
      h('span', { class: 'text-xs text-text-primary truncate font-medium' }, a.agentName),
      // Subtitle reflects the ACTUAL data state, not just absence of failing KPIs
      a.overallStatus === 'no_data'
        ? h('span', { class: 'text-[10px] text-text-muted truncate' }, 'no calls yet')
        : a.worstKpi
          ? h('span', { class: 'text-[10px] text-text-muted truncate' },
              `worst: ${a.worstKpi.label} ${a.worstKpi.score ?? '—'}/${a.worstKpi.threshold}`)
          : h('span', { class: 'text-[10px] text-pass truncate' }, 'all KPIs passing'),
    ]),
    h('div', { class: 'flex-1 grid grid-cols-6 gap-1' },
      a.kpis.map((kpi) =>
        h('div', {
          class: `rounded text-[9px] uppercase text-center py-1 px-1 cursor-help font-medium ${kpiClass(kpi.status)}`,
          title: `${kpi.label}: ${kpi.score ?? '—'} / threshold ${kpi.threshold}`,
        }, shortLabel(kpi.label))
      )
    ),
    h('div', { class: 'text-[10px] text-text-muted w-14 text-right font-mono shrink-0' },
      `${a.callCount ?? 0} calls`),
  ])
}
</script>
