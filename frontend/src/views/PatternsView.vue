<template>
  <AppShell>
    <template #filters>
      <select
        v-model="statusFilter"
        class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5"
        @change="reload"
      >
        <option value="active">
          Active only
        </option>
        <option value="applied">
          Applied
        </option>
        <option value="dismissed">
          Dismissed
        </option>
        <option value="all">
          All
        </option>
      </select>
      <select
        v-model.number="minAgents"
        class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5"
        @change="reload"
      >
        <option :value="1">
          ≥ 1 agent
        </option>
        <option :value="2">
          ≥ 2 agents (cross-agent)
        </option>
        <option :value="3">
          ≥ 3 agents
        </option>
      </select>
    </template>

    <div class="p-6 space-y-4">
      <div>
        <h1 class="text-xl font-bold text-text-primary">
          Failure Patterns
        </h1>
        <p class="text-xs text-text-secondary mt-0.5">
          Recommendations clustered by failure mode — fix once, help many agents
        </p>
      </div>

      <LoadingSpinner
        v-if="loading && !patterns.length"
        label="Loading patterns…"
      />
      <ErrorState
        v-else-if="error && !patterns.length"
        title="Failed to load patterns"
        :message="error.message"
        :on-retry="reload"
      />
      <EmptyState
        v-else-if="!loading && patterns.length === 0"
        icon="🔍"
        :title="emptyTitle"
        :subtitle="emptySubtitle"
      />

      <template v-else>
        <!-- Summary row -->
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          <SummaryStat
            label="Patterns"
            :value="patterns.length"
            tone="primary"
          />
          <SummaryStat
            label="Critical"
            :value="counts.critical"
            tone="fail"
          />
          <SummaryStat
            label="Warning"
            :value="counts.warning"
            tone="warn"
          />
          <SummaryStat
            label="Suggestion"
            :value="counts.suggestion"
            tone="primary"
          />
        </div>

        <!-- Pattern cards -->
        <div class="space-y-2">
          <PatternCard
            v-for="p in patterns"
            :key="p.clusterKey"
            :pattern="p"
            @rec-applied="reload"
          />
        </div>
      </template>
    </div>
  </AppShell>
</template>

<script setup>
import { ref, computed, onMounted, watch, h } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import client from '@/api/client'
import AppShell from '@/components/AppShell.vue'
import PatternCard from '@/components/PatternCard.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'

const route  = useRoute()
const router = useRouter()

// Init from query string so deep links like /patterns?status=applied work.
// Falls back to sensible defaults when no/invalid query is present.
const VALID_STATUS = ['active', 'applied', 'dismissed', 'all']
const statusFilter = ref(VALID_STATUS.includes(route.query.status) ? route.query.status : 'active')
const minAgents    = ref([1, 2, 3].includes(parseInt(route.query.minAgents)) ? parseInt(route.query.minAgents) : 1)
const patterns     = ref([])
const loading      = ref(false)
const error        = ref(null)

// Keep the URL in sync with the filter so the view is shareable + back-button-friendly
watch([statusFilter, minAgents], ([status, ma]) => {
  router.replace({ query: { ...route.query, status, minAgents: ma } })
})

const counts = computed(() => {
  const out = { critical: 0, warning: 0, suggestion: 0 }
  patterns.value.forEach((p) => { out[p.severity] = (out[p.severity] || 0) + 1 })
  return out
})

const emptyTitle = computed(() => minAgents.value > 1
  ? `No patterns affect ${minAgents.value}+ agents yet`
  : 'No patterns matching your filter'
)
const emptySubtitle = computed(() => minAgents.value > 1
  ? 'Cross-agent patterns emerge once multiple agents share the same failure mode. Single-agent patterns are still visible at ≥1.'
  : 'Try a wider status filter or analyze more calls.'
)

async function reload() {
  loading.value = true
  error.value = null
  try {
    const res = await client.get('/patterns', {
      params: { status: statusFilter.value, minAgents: minAgents.value, limit: 100 },
    })
    patterns.value = res.data.patterns
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

onMounted(reload)

const SummaryStat = {
  props: ['label', 'value', 'tone'],
  setup(p) {
    const toneClass = {
      primary: 'text-accent-primary',
      fail:    'text-fail',
      warn:    'text-warn',
      pass:    'text-pass',
    }[p.tone] || 'text-text-primary'
    return () => h('div', { class: 'card p-3' }, [
      h('div', { class: 'text-[10px] uppercase tracking-wide text-text-muted' }, p.label),
      h('div', { class: `text-2xl font-bold ${toneClass}` }, String(p.value)),
    ])
  },
}
</script>
