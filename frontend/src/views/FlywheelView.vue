<template>
  <AppShell>
    <template #filters>
      <div class="flex items-center gap-2">
        <div class="inline-flex rounded-card border border-border-subtle bg-bg-elevated p-0.5">
          <button
            v-for="opt in modeOpts"
            :key="opt.value"
            class="px-2 py-1 text-[11px] rounded-sm font-medium transition-colors"
            :class="windowMode === opt.value
              ? 'bg-accent-primary text-white'
              : 'text-text-muted hover:text-text-primary'"
            :title="opt.help"
            @click="setMode(opt.value)"
          >
            {{ opt.label }}
          </button>
        </div>
        <select
          v-model.number="rangeDays"
          class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5"
          @change="reload"
        >
          <option :value="7">Last 7 days</option>
          <option :value="14">Last 14 days</option>
          <option :value="30">Last 30 days</option>
          <option :value="90">Last 90 days</option>
        </select>
      </div>
    </template>

    <div class="p-6 max-w-7xl mx-auto space-y-6">
      <!-- Page header -->
      <div>
        <h1 class="text-2xl font-bold text-text-primary">Validation Flywheel</h1>
        <p class="text-sm text-text-secondary mt-1">
          {{ windowMode === 'window' ? `Last ${rangeDays} days` : 'All-time view' }} —
          how AI recommendations turn into measurable improvements
        </p>
      </div>

      <LoadingSpinner v-if="loading && !data" label="Loading flywheel state…" />
      <ErrorState
        v-else-if="error && !data"
        title="Failed to load flywheel"
        :message="error.message"
        :on-retry="reload"
      />

      <template v-else-if="data">
        <!-- ════════════════════════════════════════════════════════════════
             EMPTY STATE — no data yet
             ════════════════════════════════════════════════════════════════ -->
        <div v-if="isEmpty" class="card p-10 text-center">
          <div class="text-5xl mb-3">⏳</div>
          <div class="text-lg font-semibold text-text-primary">Waiting for first calls</div>
          <div class="text-sm text-text-secondary mt-2 max-w-md mx-auto leading-relaxed">
            The flywheel activates once HighLevel calls are ingested. Once scored,
            you'll see issues → recommendations → applied fixes → measured outcomes
            flow through this page.
          </div>
        </div>

        <template v-else>
          <!-- ════════════════════════════════════════════════════════════
               HERO 1 — THIS PERIOD'S STORY
               One headline outcome + one-line lifecycle summary
               ════════════════════════════════════════════════════════════ -->
          <section
            class="card p-6 relative overflow-hidden"
            :class="hero1Border"
          >
            <!-- Subtle decoration -->
            <div class="absolute -right-12 -top-12 w-48 h-48 rounded-full opacity-5 bg-accent-primary blur-3xl pointer-events-none" />

            <div class="relative">
              <div class="text-[10px] uppercase tracking-wide text-text-muted">
                {{ windowMode === 'window' ? `Last ${rangeDays} days` : 'All-time' }}
              </div>

              <!-- HERO METRIC — the one number that matters -->
              <div class="flex items-baseline gap-3 mt-1">
                <div
                  class="text-5xl font-bold leading-none tabular-nums"
                  :class="heroMetric.toneClass"
                >
                  {{ heroMetric.value }}
                </div>
                <div class="text-xl text-text-secondary leading-tight">
                  {{ heroMetric.unit }}
                </div>
              </div>
              <div class="text-sm font-semibold text-text-primary mt-1">
                {{ heroMetric.headline }}
              </div>

              <!-- ONE-LINE LIFECYCLE STORY — the flywheel in a sentence -->
              <div class="mt-4 pt-4 border-t border-border-subtle">
                <div class="text-xs text-text-muted mb-2">Lifecycle this period</div>
                <div class="flex items-center gap-1 text-sm font-medium flex-wrap">
                  <template v-for="(step, i) in lifecycleStory" :key="i">
                    <span :class="step.toneClass">
                      <span class="font-bold font-mono">{{ step.value }}</span>
                      <span class="text-text-secondary ml-1">{{ step.label }}</span>
                    </span>
                    <span
                      v-if="i < lifecycleStory.length - 1"
                      class="text-text-muted px-1"
                    >→</span>
                  </template>
                </div>
              </div>

              <!-- SECONDARY METRICS — small row -->
              <div class="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-muted">
                <div v-if="data.impact.passRatePct !== null">
                  Pass rate:
                  <span
                    class="font-mono font-semibold"
                    :class="data.impact.passRatePct >= 30 ? 'text-pass' : 'text-fail-text'"
                  >
                    {{ data.impact.passRatePct }}%
                  </span>
                  <span class="text-text-muted">
                    ({{ data.impact.passedInWindow }} of {{ data.impact.analysedInWindow }})
                  </span>
                </div>
                <div v-if="data.impact.avgDaysIssueToFix !== null">
                  Cycle time:
                  <span class="text-text-secondary font-mono font-semibold">
                    {{ data.impact.avgDaysIssueToFix }} days
                  </span>
                  <span class="text-text-muted">issue → fix</span>
                </div>
                <div v-if="data.rootCausesIdentified > 0">
                  Distinct root causes:
                  <span class="text-text-secondary font-mono font-semibold">
                    {{ data.rootCausesIdentified }}
                  </span>
                </div>
                <div>
                  Closure rate:
                  <span class="text-text-secondary font-mono font-semibold">
                    {{ data.closureRate !== null ? `${data.closureRate}%` : '—' }}
                  </span>
                  <span class="text-text-muted">issue → significant improvement</span>
                </div>
              </div>
            </div>
          </section>

          <!-- ════════════════════════════════════════════════════════════
               HERO 2 — WHAT'S BLOCKING YOU
               The single thing to do. Big, dominant, actionable.
               ════════════════════════════════════════════════════════════ -->
          <section
            v-if="data.nextAction"
            class="card p-5 border-2"
            :class="hero2Border"
          >
            <div class="flex items-start gap-4">
              <div class="text-4xl leading-none mt-0.5">{{ hero2Icon }}</div>
              <div class="flex-1 min-w-0">
                <div class="text-[10px] uppercase tracking-wide text-text-muted mb-1">
                  {{ hero2Label }}
                </div>
                <div class="text-lg font-bold text-text-primary leading-tight">
                  {{ data.nextAction.label }}
                </div>
                <div class="text-sm text-text-secondary mt-2 leading-relaxed">
                  {{ data.nextAction.why }}
                </div>
                <div v-if="data.biggestLeak && data.nextAction.tone !== 'pass'"
                     class="text-xs text-text-muted mt-2">
                  Biggest drop-off:
                  <span class="text-text-secondary font-mono">{{ data.biggestLeak.stage }}</span>
                  <span class="text-fail-text font-mono ml-1">{{ data.biggestLeak.conversionFromPrev }}% from prev</span>
                </div>
                <div v-else-if="data.waitingStage && data.nextAction.tone !== 'pass'"
                     class="text-xs text-text-muted mt-2">
                  ⏳
                  <span class="text-text-secondary font-mono">{{ data.waitingStage.stage }}</span>
                  <span class="ml-1">{{ data.waitingStage.reason }}</span>
                </div>
              </div>
              <RouterLink
                v-if="data.nextAction.href && data.nextAction.href.startsWith('/')"
                :to="data.nextAction.href"
                class="btn-primary text-sm whitespace-nowrap shrink-0"
              >
                {{ hero2Cta }} →
              </RouterLink>
            </div>
          </section>

          <!-- ════════════════════════════════════════════════════════════
               DRILL-IN — opt-in detail. Collapsed by default.
               Keeps the page focused unless user asks for more.
               ════════════════════════════════════════════════════════════ -->
          <section>
            <button
              class="w-full flex items-center justify-between text-left px-4 py-3 rounded-card
                     bg-bg-elevated border border-border-subtle text-sm font-medium
                     text-text-secondary hover:text-text-primary hover:border-border-strong
                     transition-colors"
              @click="drilledIn = !drilledIn"
            >
              <span>
                {{ drilledIn ? '▾' : '▸' }}
                Drill in — funnel, stage cards, full metrics
              </span>
              <span class="text-xs text-text-muted">
                {{ drilledIn ? 'Hide details' : 'Show details' }}
              </span>
            </button>

            <div v-if="drilledIn" class="mt-4 space-y-4">
              <ValidationFunnel
                :funnel="data.funnel"
                :closure-rate="data.closureRate"
                :biggest-leak-stage="data.biggestLeak?.stage || null"
                :root-causes-identified="data.rootCausesIdentified"
              />

              <div>
                <div class="text-xs uppercase tracking-wide text-text-muted mb-2">
                  Operational stages — click any card to expand
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
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
            </div>
          </section>
        </template>
      </template>
    </div>
  </AppShell>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { RouterLink } from 'vue-router'
import client from '@/api/client'
import AppShell from '@/components/AppShell.vue'
import ValidationFunnel from '@/components/ValidationFunnel.vue'
import FlywheelStageCard from '@/components/FlywheelStageCard.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import ErrorState from '@/components/ErrorState.vue'

const stageNames  = { ingest: 'Ingest', score: 'Score', recommend: 'Recommend', apply: 'Apply', measure: 'Measure' }
const stageIcons  = { ingest: '📞', score: '🧠', recommend: '💡', apply: '✏️', measure: '✅' }
const stageTones  = { ingest: 'primary', score: 'secondary', recommend: 'warn', apply: 'primary', measure: 'pass' }

const modeOpts = [
  { value: 'window',   label: 'This period', help: 'Counts scoped to the selected days filter.' },
  { value: 'all-time', label: 'All-time',    help: 'Cumulative counts since project start.' },
]

const rangeDays = ref(30)
const windowMode = ref('window')
const data       = ref(null)
const loading    = ref(false)
const error      = ref(null)
const expandedStage = ref('score')
const drilledIn  = ref(false)   // detail collapsed by default

async function reload() {
  loading.value = true
  error.value   = null
  try {
    const res = await client.get('/flywheel/summary', { params: { days: rangeDays.value, mode: windowMode.value } })
    data.value = res.data
  } catch (err) { error.value = err }
  finally { loading.value = false }
}
function setMode(v) {
  if (windowMode.value === v) return
  windowMode.value = v
  reload()
}

const isEmpty = computed(() => {
  if (!data.value) return false
  const f = Object.fromEntries(data.value.funnel.map((s) => [s.stage, s.count]))
  return (f['Issues Detected'] || 0) === 0
      && (f['Recommendations Generated'] || 0) === 0
      && (f['Recommendations Applied'] || 0) === 0
})

// ── HERO 1: pick the one headline metric that tells the story ──────────
// Priority order (PM call):
//   1. Significant improvements measured → celebrate
//   2. Score delta exists → trend signal
//   3. User has applied fixes but waiting for measurement → show that
//   4. User has unapplied recommendations → show ratio
//   5. True fallback: analysis volume
const heroMetric = computed(() => {
  const d = data.value
  const f = Object.fromEntries(d.funnel.map((s) => [s.stage, s.count]))
  const significant = f['Improved Scores'] || 0
  const applied     = f['Recommendations Applied'] || 0
  const generated   = f['Recommendations Generated'] || 0
  const issues      = f['Issues Detected'] || 0
  const delta       = d.impact.avgScoreDeltaThisPeriod
  const passRate    = d.impact.passRatePct
  const waiting     = d.waitingStage

  if (significant > 0) {
    return {
      value: `+${significant}`,
      unit: `significant improvement${significant === 1 ? '' : 's'}`,
      headline: 'Applied recommendations are measurably lifting agent scores',
      toneClass: 'text-pass',
    }
  }
  if (delta !== null && delta !== undefined) {
    const positive = delta > 0
    return {
      value: `${positive ? '+' : ''}${delta}`,
      unit: 'pts avg score Δ',
      headline: positive
        ? 'Agents trending up vs prior 7 days'
        : delta < 0 ? 'Agents trending down vs prior 7 days — investigate' : 'Scores flat — push more applied recommendations',
      toneClass: positive ? 'text-pass' : delta < 0 ? 'text-fail-text' : 'text-text-primary',
    }
  }
  // Action taken, waiting for downstream measurement — honest framing
  if (applied > 0 && waiting) {
    return {
      value: applied,
      unit: `fix${applied === 1 ? '' : 'es'} applied`,
      headline: waiting.reason,
      toneClass: 'text-accent-primary-text',
    }
  }
  // Loop is producing recs but they need to be applied
  if (generated > 0 && applied === 0) {
    return {
      value: generated,
      unit: `recommendation${generated === 1 ? '' : 's'} queued`,
      headline: 'Loop is generating signal — apply the top patterns to start the measurement cycle',
      toneClass: 'text-warn',
    }
  }
  // True fallback: signal volume, framed neutrally
  return {
    value: issues,
    unit: `call${issues === 1 ? '' : 's'} analysed`,
    headline: passRate !== null && passRate < 30
      ? `Only ${passRate}% passed thresholds — investigate whether thresholds or agents are the cause`
      : 'Loop is collecting signal — no improvements measured yet',
    toneClass: passRate !== null && passRate < 30 ? 'text-fail-text' : 'text-accent-primary-text',
  }
})

// ── HERO 1: one-line lifecycle story ───────────────────────────────────
// Compresses the 5-stage funnel into a sentence: 43 issues → 41 recs → 2 applied → 0 measured → 0 improved
const lifecycleStory = computed(() => {
  const f = Object.fromEntries(data.value.funnel.map((s) => [s.stage, s.count]))
  const leak = data.value.biggestLeak?.stage
  const isLeak = (stageName) => leak === stageName
  return [
    { value: f['Issues Detected'] || 0,           label: 'issues',
      toneClass: 'text-text-primary' },
    { value: f['Recommendations Generated'] || 0, label: 'generated',
      toneClass: isLeak('Recommendations Generated') ? 'text-fail-text' : 'text-text-primary' },
    { value: f['Recommendations Applied'] || 0,   label: 'applied',
      toneClass: isLeak('Recommendations Applied') ? 'text-fail-text' : 'text-text-primary' },
    { value: f['Outcomes Measured'] || 0,         label: 'measured',
      toneClass: isLeak('Outcomes Measured') ? 'text-fail-text' : 'text-text-primary' },
    { value: f['Improved Scores'] || 0,           label: 'improved',
      toneClass: (f['Improved Scores'] || 0) > 0 ? 'text-pass' : 'text-text-muted' },
  ]
})

const hero1Border = computed(() => {
  const t = data.value?.healthSummary?.tone
  if (t === 'pass') return 'border-pass/40'
  if (t === 'warn') return 'border-warn/40'
  if (t === 'fail') return 'border-fail/40'
  return ''
})

// ── HERO 2: the blocking action — high visual weight ───────────────────
const hero2Border = computed(() => {
  const t = data.value?.nextAction?.tone
  if (t === 'pass') return 'border-pass/50 bg-pass/5'
  if (t === 'warn') return 'border-warn/50 bg-warn/5'
  if (t === 'fail') return 'border-fail/50 bg-fail/5'
  if (t === 'secondary') return 'border-accent-secondary/40 bg-accent-secondary/5'
  return 'border-accent-primary/50 bg-accent-primary/5'
})
const hero2Icon = computed(() => {
  const t = data.value?.nextAction?.tone
  if (t === 'pass') return '✅'
  if (t === 'warn') return '⚠️'
  if (t === 'fail') return '🚨'
  if (t === 'secondary') return '⏳'
  return '👉'
})
const hero2Label = computed(() => {
  const t = data.value?.nextAction?.tone
  if (t === 'pass') return 'Loop is healthy'
  if (t === 'warn') return 'Action needed'
  if (t === 'fail') return 'Investigate'
  if (t === 'secondary') return 'Waiting'
  return 'Next step'
})
const hero2Cta = computed(() => {
  const t = data.value?.nextAction?.tone
  if (t === 'warn') return 'Apply now'
  if (t === 'fail') return 'Review'
  return 'Open'
})

// Health badge per stage (used inside drilled-in section only)
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
</script>
