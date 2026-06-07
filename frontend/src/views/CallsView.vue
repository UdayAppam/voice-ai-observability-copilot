<template>
  <AppShell>
    <template #back>
      <BackLink
        label="Overview"
        to="/"
      />
    </template>
    <template #filters>
      <select
        v-model="agentFilter"
        class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5 max-w-[150px]"
        @change="reload(1)"
      >
        <option value="">
          All agents
        </option>
        <option
          v-for="a in agents"
          :key="a.id"
          :value="a.id"
        >
          {{ a.name }}
        </option>
      </select>
      <select
        v-model="statusFilter"
        class="bg-bg-elevated border border-border-subtle text-text-secondary text-xs rounded-card px-2 py-1.5"
        @change="reload(1)"
      >
        <option value="all">
          All statuses
        </option>
        <option value="pass">
          ✓ Pass
        </option>
        <option value="warning">
          ⚠ Warning
        </option>
        <option value="fail">
          ✗ Fail
        </option>
      </select>
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Search by ID, number, agent…"
        class="bg-bg-elevated border border-border-subtle text-text-primary text-xs rounded-card px-2 py-1.5 w-48 placeholder:text-text-muted"
        @input="debouncedSearch"
      >
    </template>

    <div class="p-6 space-y-4">
      <!-- Result count + sort -->
      <div class="flex items-center justify-between">
        <div class="text-sm text-text-secondary">
          <span class="font-semibold text-text-primary">{{ total }}</span>
          {{ total === 1 ? 'call' : 'calls' }}
          <span
            v-if="agentFilter || statusFilter !== 'all' || searchQuery"
            class="text-text-muted"
          >
            (filtered from {{ unfilteredTotal }})
          </span>
        </div>
        <div class="flex items-center gap-2 text-xs text-text-muted">
          Sort by:
          <button
            class="btn-ghost"
            :class="{ 'text-accent-primary': sortBy === 'date' }"
            @click="setSort('date')"
          >
            Date {{ sortBy === 'date' ? (sortDir === 'desc' ? '↓' : '↑') : '' }}
          </button>
          <button
            class="btn-ghost"
            :class="{ 'text-accent-primary': sortBy === 'score' }"
            @click="setSort('score')"
          >
            KPI {{ sortBy === 'score' ? (sortDir === 'desc' ? '↓' : '↑') : '' }}
          </button>
        </div>
      </div>

      <!-- Loading / empty -->
      <LoadingSpinner
        v-if="loading && !calls.length"
        full-page
        label="Loading calls…"
      />
      <EmptyState
        v-else-if="!calls.length"
        title="No calls match your filters"
        subtitle="Try clearing search or expanding the filter range."
        icon="🔍"
      />

      <!-- Calls table -->
      <div
        v-else
        class="card overflow-hidden"
      >
        <table class="w-full text-xs">
          <thead class="bg-bg-elevated">
            <tr class="text-[10px] uppercase text-text-muted">
              <th class="text-left font-medium px-3 py-2">
                Call
              </th>
              <th class="text-left font-medium px-3 py-2">
                Agent
              </th>
              <th class="text-left font-medium px-3 py-2">
                Outcome
              </th>
              <th class="text-right font-medium px-3 py-2">
                KPI
              </th>
              <th class="text-left font-medium px-3 py-2 hidden md:table-cell">
                Top issue
              </th>
              <th class="text-right font-medium px-3 py-2 hidden sm:table-cell">
                Duration
              </th>
              <th class="text-right font-medium px-3 py-2">
                Date
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="call in calls"
              :key="call.id"
              class="border-t border-border-subtle hover:bg-bg-elevated cursor-pointer transition-colors"
              @click="$router.push(`/calls/${call.id}`)"
            >
              <td class="px-3 py-2 font-mono text-text-muted">
                #{{ shortId(call.id) }}
              </td>
              <td class="px-3 py-2 text-text-secondary truncate max-w-[180px]">
                {{ call.agentName }}
              </td>
              <td class="px-3 py-2">
                <span :class="`badge-${call.status || 'suggestion'}`">{{ call.outcome || '—' }}</span>
              </td>
              <td
                class="px-3 py-2 text-right font-mono font-semibold"
                :class="scoreColor(call.overall_score)"
              >
                {{ call.overall_score ?? '—' }}
              </td>
              <td class="px-3 py-2 text-text-secondary truncate max-w-[300px] hidden md:table-cell">
                {{ call.topIssue || '—' }}
              </td>
              <td class="px-3 py-2 text-right text-text-muted font-mono hidden sm:table-cell">
                {{ formatDuration(call.duration) }}
              </td>
              <td class="px-3 py-2 text-right text-text-muted font-mono whitespace-nowrap">
                {{ formatTime(call.call_timestamp) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div
        v-if="totalPages > 1"
        class="flex items-center justify-between text-xs"
      >
        <span class="text-text-muted">Page {{ page }} of {{ totalPages }}</span>
        <div class="flex items-center gap-1">
          <button
            class="btn-secondary px-3 py-1.5 text-xs"
            :disabled="page <= 1"
            @click="reload(page - 1)"
          >
            ← Prev
          </button>
          <button
            class="btn-secondary px-3 py-1.5 text-xs"
            :disabled="page >= totalPages"
            @click="reload(page + 1)"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import client from '@/api/client'

import AppShell from '@/components/AppShell.vue'
import BackLink from '@/components/BackLink.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import EmptyState from '@/components/EmptyState.vue'

const route = useRoute()
const router = useRouter()

const calls = ref([])
const agents = ref([])
const total = ref(0)
const unfilteredTotal = ref(0)
const totalPages = ref(1)
const page = ref(1)
const loading = ref(false)

const agentFilter = ref(route.query.agentId || '')
const statusFilter = ref(route.query.status || 'all')
const searchQuery = ref(route.query.q || '')
const sortBy = ref(route.query.sortBy || 'date')
const sortDir = ref(route.query.sortDir || 'desc')

let searchTimer = null
function debouncedSearch() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => reload(1), 250)
}

function setSort(field) {
  if (sortBy.value === field) {
    sortDir.value = sortDir.value === 'desc' ? 'asc' : 'desc'
  } else {
    sortBy.value = field
    sortDir.value = 'desc'
  }
  reload(1)
}

async function loadAgents() {
  try {
    const { data } = await client.get('/agents')
    agents.value = data.agents
  } catch { /* non-critical */ }
}

async function reload(targetPage = page.value) {
  loading.value = true
  page.value = targetPage
  try {
    const params = {
      page: targetPage,
      limit: 50,
      sortBy: sortBy.value,
      sortDir: sortDir.value,
    }
    if (agentFilter.value) params.agentId = agentFilter.value
    if (statusFilter.value !== 'all') params.status = statusFilter.value
    if (searchQuery.value) params.q = searchQuery.value

    // Sync to URL so filters survive refresh + work with back/forward
    router.replace({ query: { ...params, page: String(targetPage) } })

    const { data } = await client.get('/calls', { params })
    calls.value = data.calls
    total.value = data.total
    totalPages.value = data.totalPages

    // Get unfiltered baseline once
    if (unfilteredTotal.value === 0) {
      const { data: all } = await client.get('/calls', { params: { limit: 1 } })
      unfilteredTotal.value = all.total
    }
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadAgents()
  await reload(parseInt(route.query.page) || 1)
})

function shortId(id) { return id ? id.slice(-6).toUpperCase() : '' }
function scoreColor(s) {
  if (s === null || s === undefined) return 'text-text-muted'
  if (s >= 70) return 'text-pass'
  if (s >= 50) return 'text-warn'
  return 'text-fail'
}
function formatDuration(s) {
  if (!s) return '—'
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
</script>
