<template>
  <AppShell>
    <template #back>
      <BackLink
        :label="call?.agentName ? call.agentName : 'Overview'"
        :to="call?.agent_id ? `/agents/${call.agent_id}` : '/'"
      />
    </template>
    <div class="p-6 pb-32">
      <LoadingSpinner
        v-if="callStore.loading && !call"
        full-page
        label="Loading call..."
      />

      <ErrorState
        v-else-if="callStore.error && !call"
        title="Failed to load call"
        :message="callStore.error.message"
        :on-retry="() => callStore.fetchCall(route.params.id)"
      />

      <div v-else-if="call">
        <!-- Header -->
        <div class="card p-3 mb-3 flex items-center gap-3">
          <HealthDonut
            v-if="analysis"
            :score="analysis.overallScore"
            :size="56"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 mb-0.5">
              <span :class="`badge-${analysis?.status || 'suggestion'}`">{{ statusLabel(analysis?.status) }}</span>
              <span
                v-if="hallucinationCount > 0"
                class="text-[10px] px-1.5 py-0.5 rounded-sm bg-fail/15 text-fail font-mono"
                :title="`${hallucinationCount} hallucination${hallucinationCount > 1 ? 's' : ''} detected`"
              >🔺 {{ hallucinationCount }} hallucination{{ hallucinationCount > 1 ? 's' : '' }}</span>
              <span class="font-mono text-[10px] text-hl-muted truncate">{{ call.id }}</span>
            </div>
            <div class="text-sm font-semibold">
              {{ call.agentName }}
            </div>
            <div class="text-xs text-hl-muted">
              {{ call.outcome }} · {{ formatDuration(call.duration) }} · {{ formatTime(call.call_timestamp) }}
            </div>
          </div>
        </div>

        <!-- Summary -->
        <div
          v-if="analysis"
          class="card p-3 mb-3"
        >
          <h3 class="text-xs font-semibold text-hl-text uppercase mb-1">
            Summary
          </h3>
          <p class="text-xs text-hl-muted leading-relaxed">
            {{ analysis.summary }}
          </p>
        </div>

        <!-- KPI Bars (replaces plain grid — shows threshold markers) -->
        <div
          v-if="analysis && kpiDefs.length"
          class="card p-3 mb-3"
        >
          <h3 class="text-xs font-semibold text-hl-text uppercase mb-1">
            KPI Performance
          </h3>
          <p class="text-[10px] text-hl-muted mb-2">
            Vertical line = pass threshold
          </p>
          <KpiBars
            :kpi-definitions="kpiDefs"
            :kpi-scores="analysis.kpiScores"
          />
        </div>

        <!-- Recommendations -->
        <div
          v-if="analysis?.recommendations?.length"
          class="card p-3 mb-3"
        >
          <h3 class="text-xs font-semibold text-hl-text uppercase mb-2">
            Recommendations
          </h3>
          <div
            v-for="(rec, i) in analysis.recommendations"
            :key="i"
            class="border-t border-hl-border first:border-0 pt-2 first:pt-0 mt-2 first:mt-0"
          >
            <div class="flex items-center gap-2 mb-1">
              <span :class="`badge-${rec.severity}`">{{ rec.severity }}</span>
              <span class="text-xs font-semibold">{{ rec.title }}</span>
            </div>
            <p class="text-xs text-hl-muted leading-relaxed mb-1">
              {{ rec.detail }}
            </p>
            <p class="text-[11px] bg-hl-bg p-2 rounded font-mono text-hl-text leading-relaxed">
              {{ rec.suggestedChange }}
            </p>
          </div>
        </div>

        <!-- Flags Timeline (FSB Use Actions) -->
        <div
          v-if="flags.length"
          class="card p-3 mb-3"
        >
          <h3 class="text-xs font-semibold text-hl-text uppercase mb-2">
            Flags Timeline
          </h3>
          <div class="space-y-1">
            <button
              v-for="(flag, i) in flags"
              :key="i"
              class="w-full text-left text-xs flex items-start gap-2 p-1.5 rounded hover:bg-hl-bg transition-colors"
              @click="scrollToTurn(flag.turnIndex)"
            >
              <span class="font-mono text-hl-muted w-12 shrink-0">Turn {{ flag.turnIndex }}</span>
              <span
                :class="flagBadgeClass(flag.type)"
                class="shrink-0"
              >{{ flagIcon(flag.type) }}</span>
              <span class="text-hl-muted truncate">{{ flag.description }}</span>
            </button>
          </div>
        </div>

        <!-- Transcript -->
        <div class="card p-3">
          <h3 class="text-xs font-semibold text-hl-text uppercase mb-2">
            Transcript
          </h3>
          <div class="space-y-2">
            <div
              v-for="turn in call.transcript"
              :key="turn.turnIndex"
              :ref="(el) => (turnRefs[turn.turnIndex] = el)"
              class="text-xs"
              :class="turn.speaker === 'agent' ? 'text-right' : 'text-left'"
            >
              <div
                class="inline-block max-w-[88%] p-2 rounded-lg"
                :class="turnBubbleClass(turn)"
              >
                <div class="font-semibold text-[9px] opacity-60 uppercase mb-0.5">
                  {{ turn.speaker }} · Turn {{ turn.turnIndex }}
                </div>
                <div class="leading-relaxed">
                  {{ turn.text }}
                </div>

                <div
                  v-if="turn.hallucination"
                  class="mt-1 pt-1 border-t border-fail/40 text-[10px] text-left"
                >
                  <div class="flex items-center gap-1 mb-0.5">
                    <span class="font-semibold text-fail">🔺 Hallucination:</span>
                    <span class="font-mono text-[9px] uppercase text-fail/80">{{ formatHallucinationType(turn.hallucination.type) }}</span>
                    <span class="text-[9px] text-text-muted">· {{ turn.hallucination.confidence }} confidence</span>
                  </div>
                  <div class="italic text-hl-muted">
                    "{{ turn.hallucination.claim }}"
                  </div>
                  <div class="text-hl-muted mt-0.5">
                    Impact: {{ turn.hallucination.impact }}
                  </div>
                </div>
                <div
                  v-if="turn.useAction"
                  class="mt-1 pt-1 border-t border-hl-fail/40 text-[10px] text-left"
                >
                  <span class="font-semibold text-hl-fail">⚠ Use Action:</span> {{ turn.useAction.reason }}
                </div>
                <div
                  v-if="turn.missedOpportunity"
                  class="mt-1 pt-1 border-t border-hl-warn/40 text-[10px] text-left"
                >
                  <span class="font-semibold text-hl-warn">💡 Missed:</span> {{ turn.missedOpportunity.opportunity }}
                </div>
                <div
                  v-if="turn.deviation"
                  class="mt-1 pt-1 border-t border-hl-deviation/40 text-[10px] text-left"
                >
                  <span class="font-semibold text-hl-deviation">✗ Deviation:</span> {{ turn.deviation.description }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<script setup>
import { onMounted, watch, computed, ref, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import { useCallStore } from '@/stores/callStore'
import { useAgentStore } from '@/stores/agentStore'
import AppShell from '@/components/AppShell.vue'
import BackLink from '@/components/BackLink.vue'
import HealthDonut from '@/components/HealthDonut.vue'
import KpiBars from '@/components/KpiBars.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import ErrorState from '@/components/ErrorState.vue'

const route = useRoute()
const callStore = useCallStore()
const agentStore = useAgentStore()

const call = computed(() => callStore.currentCall)
const analysis = computed(() => callStore.currentAnalysis)
const turnRefs = ref({})

// Pull KPI defs for this call's agent so KpiBars knows thresholds + labels
const kpiDefs = computed(() => agentStore.currentAgent?.kpiDefinitions ?? [])

const flags = computed(() => {
  if (!analysis.value) return []
  const list = []
  for (const d of analysis.value.deviations ?? []) {
    list.push({ turnIndex: d.turnIndex, type: 'deviation', description: d.description })
  }
  for (const m of analysis.value.missedOpportunities ?? []) {
    list.push({ turnIndex: m.turnIndex, type: 'missed', description: m.opportunity })
  }
  for (const u of analysis.value.useActions ?? []) {
    list.push({ turnIndex: u.turnIndex, type: 'use_action', description: u.reason })
  }
  for (const h of analysis.value.hallucinations ?? []) {
    list.push({
      turnIndex: h.turnIndex,
      type: 'hallucination',
      description: `${formatHallucinationType(h.type)} — "${truncate(h.claim, 80)}"`,
    })
  }
  return list.sort((a, b) => a.turnIndex - b.turnIndex)
})

const hallucinationCount = computed(() => analysis.value?.hallucinations?.length || 0)

function formatHallucinationType(t) {
  return ({
    fabricated_fact:     'Fabricated fact',
    invented_policy:     'Invented policy',
    made_up_capability:  'Made-up capability',
    wrong_price:         'Wrong price',
    unverified_claim:    'Unverified claim',
  }[t]) || t
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s }

async function load(id) {
  await callStore.fetchCall(id)
  // Ensure we have the agent's KPI definitions for the bars
  const agentId = callStore.currentCall?.agent_id
  if (agentId && agentStore.currentAgent?.id !== agentId) {
    agentStore.fetchAgent(agentId)
  }
}

onMounted(() => load(route.params.id))
watch(() => route.params.id, (id) => id && load(id))

async function scrollToTurn(turnIndex) {
  await nextTick()
  const el = turnRefs.value[turnIndex]
  if (el?.scrollIntoView) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

function turnBubbleClass(turn) {
  const base = turn.speaker === 'agent'
    ? 'bg-hl-primary/10 text-hl-text'
    : 'bg-hl-bg text-hl-text border border-hl-border'

  // Hallucination ring takes top priority — it's a quality/safety failure
  if (turn.hallucination)     return base + ' ring-2 ring-fail'
  if (turn.useAction)         return base + ' ring-2 ring-hl-fail'
  if (turn.missedOpportunity) return base + ' ring-2 ring-hl-warn'
  if (turn.deviation)         return base + ' ring-2 ring-hl-deviation'
  return base
}

function flagIcon(type) {
  if (type === 'use_action')    return '⚠'
  if (type === 'missed')        return '💡'
  if (type === 'hallucination') return '🔺'
  return '✗'
}

function flagBadgeClass(type) {
  if (type === 'use_action')    return 'text-hl-fail font-semibold'
  if (type === 'missed')        return 'text-hl-warn font-semibold'
  if (type === 'hallucination') return 'text-fail font-semibold'
  return 'text-hl-deviation font-semibold'
}

function statusLabel(s) {
  if (s === 'pass') return '✓ Pass'
  if (s === 'warning') return '⚠ Warning'
  if (s === 'fail') return '✗ Fail'
  return '○ Pending'
}

function formatDuration(s) {
  if (!s) return ''
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

</script>
