<template>
  <div class="card overflow-hidden">
    <!-- Header — always visible -->
    <div
      class="p-3 flex items-start gap-3 cursor-pointer hover:bg-bg-elevated/50"
      @click="expanded = !expanded"
    >
      <div
        class="w-1 self-stretch rounded-full"
        :class="severityBar"
      />
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-1 flex-wrap">
          <span
            class="text-[10px] px-1.5 py-0.5 rounded-sm font-mono uppercase"
            :class="severityBadge"
          >{{ pattern.severity }}</span>
          <span
            v-if="pattern.urgencyDescriptor && pattern.urgencyDescriptor !== 'one-off'"
            class="text-[10px] px-1.5 py-0.5 rounded-sm font-mono uppercase"
            :class="urgencyBadge"
          >{{ pattern.urgencyDescriptor }}</span>
          <!-- NEW: apply-state pill — answers "is this pattern outstanding for me?" -->
          <span
            v-if="rollup"
            class="text-[10px] px-1.5 py-0.5 rounded-sm font-mono"
            :class="applyStateBadge"
            :title="applyStateTitle"
          >{{ applyStateLabel }}</span>
          <span class="text-[10px] text-text-muted">
            <strong class="text-text-primary">Detected in {{ pattern.callsAffected }} call{{ pattern.callsAffected === 1 ? '' : 's' }}</strong>
            <span v-if="pattern.failedCallsAffected > 0">
              · <span class="text-fail font-semibold">{{ pattern.failedCallsAffected }} failed</span>
            </span>
            · {{ pattern.affectedAgents }} agent{{ pattern.affectedAgents === 1 ? '' : 's' }} affected
            <span v-if="lastSeenRelative">· last {{ lastSeenRelative }}</span>
          </span>
          <span
            v-for="t in pattern.types"
            :key="t"
            class="text-[10px] px-1.5 py-0.5 rounded-sm bg-bg-elevated text-text-muted font-mono"
          >{{ t }}</span>
        </div>
        <div class="text-sm font-semibold text-text-primary truncate">
          {{ pattern.title }}
        </div>
      </div>

      <!-- Lifecycle bar — proportions of active/applied/dismissed -->
      <div class="hidden sm:flex flex-col items-end shrink-0 w-32">
        <div class="text-[10px] text-text-muted uppercase mb-0.5">
          Lifecycle
        </div>
        <div class="w-full h-2 flex rounded-sm overflow-hidden bg-bg-elevated">
          <div
            v-if="pattern.statusBreakdown.active > 0"
            class="bg-fail"
            :style="{ width: pct(pattern.statusBreakdown.active) + '%' }"
            :title="`Active: ${pattern.statusBreakdown.active}`"
          />
          <div
            v-if="pattern.statusBreakdown.applied > 0"
            class="bg-warn"
            :style="{ width: pct(pattern.statusBreakdown.applied) + '%' }"
            :title="`Applied: ${pattern.statusBreakdown.applied}`"
          />
          <div
            v-if="pattern.statusBreakdown.dismissed > 0"
            class="bg-text-muted/40"
            :style="{ width: pct(pattern.statusBreakdown.dismissed) + '%' }"
            :title="`Dismissed: ${pattern.statusBreakdown.dismissed}`"
          />
        </div>
        <div class="text-[10px] text-text-muted mt-0.5">
          {{ pattern.statusBreakdown.active }} active · {{ pattern.statusBreakdown.applied }} applied · {{ pattern.statusBreakdown.dismissed }} dismissed
        </div>
      </div>

      <span class="text-text-muted text-xs ml-1">{{ expanded ? '▴' : '▾' }}</span>
    </div>

    <!-- Expanded detail — per-agent breakdown, SPLIT by status -->
    <div
      v-if="expanded"
      class="border-t border-border-subtle px-3 py-3 space-y-3 bg-bg-base"
    >
      <!-- STILL NEEDED section — the action queue -->
      <div v-if="agentsStillActive.length > 0">
        <div class="text-[10px] text-fail-text uppercase tracking-wide mb-1.5 font-semibold flex items-center gap-2">
          ⚠ Still needs apply on {{ agentsStillActive.length }} agent{{ agentsStillActive.length === 1 ? '' : 's' }}
        </div>
        <div class="space-y-1.5">
          <div
            v-for="ag in agentsStillActive"
            :key="ag.id"
            class="flex items-start gap-2 text-xs flex-wrap pl-2 border-l-2 border-fail/30"
          >
            <RouterLink
              :to="`/agents/${ag.agentId}`"
              class="text-text-primary hover:text-accent-primary-text font-semibold shrink-0"
            >
              {{ ag.agentName }}
            </RouterLink>
            <span class="text-text-muted shrink-0">
              · flagged in {{ ag.callsAffected }} call{{ ag.callsAffected === 1 ? '' : 's' }}<span
                v-if="ag.failedCallsAffected > 0"
              > <span class="text-fail-text">({{ ag.failedCallsAffected }} failed)</span></span>
            </span>
            <span
              v-if="ag.suggestedChange"
              class="text-text-secondary italic ml-2 truncate flex-1 min-w-0"
            >"{{ ag.suggestedChange }}"</span>
            <ApplyRecommendationButton
              class="shrink-0 ml-auto"
              :recommendation="{ id: ag.id, agentId: ag.agentId, title: pattern.title, severity: ag.severity }"
              :agent-name="ag.agentName"
              @applied="$emit('rec-applied', ag)"
            />
          </div>
        </div>
      </div>

      <!-- ALREADY APPLIED section — collapsed by default to reduce noise -->
      <div v-if="agentsApplied.length > 0">
        <div class="text-[10px] text-pass uppercase tracking-wide mb-1.5 font-semibold flex items-center gap-2">
          ✓ Already applied on {{ agentsApplied.length }} agent{{ agentsApplied.length === 1 ? '' : 's' }}
        </div>
        <div class="space-y-1 text-xs">
          <div
            v-for="ag in agentsApplied"
            :key="ag.id"
            class="flex items-center gap-2 pl-2 border-l-2 border-pass/30 text-text-secondary"
          >
            <RouterLink
              :to="`/agents/${ag.agentId}`"
              class="hover:text-accent-primary-text font-medium"
            >
              {{ ag.agentName }}
            </RouterLink>
            <span class="text-text-muted">
              · flagged in {{ ag.callsAffected }} call{{ ag.callsAffected === 1 ? '' : 's' }}
            </span>
          </div>
        </div>
      </div>

      <!-- DISMISSED — minimal, just count -->
      <div
        v-if="agentsDismissed.length > 0"
        class="text-[10px] text-text-muted"
      >
        + {{ agentsDismissed.length }} dismissed on other agent{{ agentsDismissed.length === 1 ? '' : 's' }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { RouterLink } from 'vue-router'
import ApplyRecommendationButton from '@/components/ApplyRecommendationButton.vue'

const props = defineProps({
  pattern: { type: Object, required: true },
})
defineEmits(['rec-applied'])

const expanded = ref(false)

const severityBar = computed(() => ({
  critical:   'bg-fail',
  warning:    'bg-warn',
  suggestion: 'bg-accent-primary',
}[props.pattern.severity] || 'bg-text-muted'))

const severityBadge = computed(() => ({
  critical:   'bg-fail/15 text-fail',
  warning:    'bg-warn/15 text-warn',
  suggestion: 'bg-accent-primary/15 text-accent-primary',
}[props.pattern.severity]))

const urgencyBadge = computed(() => ({
  systemic:  'bg-fail/15 text-fail',
  recurring: 'bg-warn/15 text-warn',
}[props.pattern.urgencyDescriptor] || 'bg-bg-elevated text-text-muted'))

// "last 4h ago" / "last 2d ago" — short relative time string for the header
const lastSeenRelative = computed(() => {
  const iso = props.pattern.lastSeenAt
  if (!iso) return null
  const ms = Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()
  if (ms < 0 || Number.isNaN(ms)) return null
  const min = ms / 60000
  if (min < 60)         return `${Math.round(min)}m ago`
  if (min < 60 * 24)    return `${Math.round(min / 60)}h ago`
  return `${Math.round(min / (60 * 24))}d ago`
})

function statusBadge(s) {
  return {
    active:    'bg-fail/15 text-fail',
    applied:   'bg-pass/15 text-pass',
    dismissed: 'bg-text-muted/15 text-text-muted',
  }[s] || 'bg-bg-elevated text-text-muted'
}

const total = computed(() =>
  props.pattern.statusBreakdown.active + props.pattern.statusBreakdown.applied + props.pattern.statusBreakdown.dismissed
)
function pct(n) { return total.value > 0 ? (n / total.value) * 100 : 0 }

// ── Per-agent rollup (NEW backend field) ───────────────────────────────
// Backend now returns:
//   pattern.agentRollup      = { totalAgents, agentsApplied, agentsActive, agentsDismissed, applyState }
//   pattern.agentsApplied    = [{...agent details...}] — agents where it's already applied
//   pattern.agentsStillActive= [{...}] — agents where it's still queued
//   pattern.agentsDismissed  = [{...}]
// These let us split the expanded view + show the headline apply-state pill.
const rollup = computed(() => props.pattern.agentRollup || null)
const agentsApplied     = computed(() => props.pattern.agentsApplied || [])
const agentsStillActive = computed(() => props.pattern.agentsStillActive || [])
const agentsDismissed   = computed(() => props.pattern.agentsDismissed || [])

const applyStateLabel = computed(() => {
  const r = rollup.value
  if (!r) return ''
  if (r.applyState === 'all_applied')  return `✓ Applied to all ${r.totalAgents}`
  if (r.applyState === 'partial')      return `Applied ${r.agentsApplied}/${r.totalAgents} · ${r.agentsActive} still needed`
  if (r.applyState === 'not_started')  return `Not yet applied (${r.totalAgents} agent${r.totalAgents === 1 ? '' : 's'})`
  return ''
})
const applyStateBadge = computed(() => {
  const r = rollup.value
  if (!r) return ''
  if (r.applyState === 'all_applied') return 'bg-pass/15 text-pass'
  if (r.applyState === 'partial')     return 'bg-warn/15 text-warn'
  return 'bg-fail/15 text-fail-text'
})
const applyStateTitle = computed(() => {
  const r = rollup.value
  if (!r) return ''
  if (r.applyState === 'all_applied') return 'Every affected agent has this fix applied. No action needed.'
  if (r.applyState === 'partial')     return `Applied on ${r.agentsApplied} agent(s); still queued on ${r.agentsActive} other agent(s).`
  return `Active recommendation on ${r.totalAgents} agent(s). Apply per-agent to roll out.`
})
</script>
