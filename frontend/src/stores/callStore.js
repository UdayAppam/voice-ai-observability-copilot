import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import client from '@/api/client'

export const useCallStore = defineStore('calls', () => {
  const calls = ref([])
  const totalCalls = ref(0)
  const currentCall = ref(null)
  const currentAnalysis = ref(null)
  const loading = ref(false)
  const loadingMore = ref(false)
  const error = ref(null)
  const currentPage = ref(1)
  const currentLimit = ref(20)
  const lastQuery = ref({ agentId: null, status: 'all', flag: null, sort: 'newest', search: '' })

  // V5.9 — fetchCalls accepts append + sort/search/flag.
  // Default replaces (used when filters change). append=true is what the Load More button uses.
  async function fetchCalls(agentId, {
    page = 1, limit = 20, status = 'all', flag = null, sort = 'newest', search = '', append = false,
  } = {}) {
    if (append) loadingMore.value = true
    else loading.value = true
    error.value = null
    try {
      const { data } = await client.get(`/agents/${agentId}/calls`, {
        params: { page, limit, status, flag: flag || undefined, sort, search: search || undefined },
      })
      if (append) {
        // Dedupe defensively in case of overlapping pages (filter changes mid-flight)
        const seen = new Set(calls.value.map((c) => c.id))
        calls.value = [...calls.value, ...data.calls.filter((c) => !seen.has(c.id))]
      } else {
        calls.value = data.calls
      }
      totalCalls.value = data.total
      currentPage.value = data.page
      currentLimit.value = data.limit
      lastQuery.value = { agentId, status, flag, sort, search }
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
      loadingMore.value = false
    }
  }

  // hasMore tells the view whether to show the Load more button
  const hasMore = computed(() => calls.value.length < totalCalls.value)

  async function loadMore() {
    if (!hasMore.value || loadingMore.value) return
    const q = lastQuery.value
    if (!q.agentId) return
    await fetchCalls(q.agentId, {
      page: currentPage.value + 1,
      limit: currentLimit.value,
      status: q.status, flag: q.flag, sort: q.sort, search: q.search,
      append: true,
    })
  }

  async function fetchCall(id) {
    loading.value = true
    error.value = null
    currentCall.value = null
    currentAnalysis.value = null
    try {
      const [callRes, analysisRes] = await Promise.all([
        client.get(`/calls/${id}`),
        client.get(`/calls/${id}/analysis`).catch(() => null),
      ])
      currentCall.value = callRes.data
      currentAnalysis.value = analysisRes?.data ?? null
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  async function reAnalyze(id) {
    loading.value = true
    error.value = null
    try {
      const { data } = await client.post(`/calls/${id}/analyze`)
      currentAnalysis.value = data
      // Update call status in the list
      const idx = calls.value.findIndex((c) => c.id === id)
      if (idx !== -1) {
        calls.value[idx].overall_score = data.overallScore
        calls.value[idx].status = data.status
      }
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  // Triggers the demo simulator — backend loads a canned transcript and analyzes it
  async function simulateNewCall(agentId) {
    error.value = null
    try {
      const { data } = await client.post(`/transcripts/simulate/${agentId}`)
      return data
    } catch (err) {
      error.value = err
      return null
    }
  }

  // Sync all agents — pulls latest from HL for every agent, analyses new calls
  async function syncAll() {
    error.value = null
    try {
      const { data } = await client.post('/transcripts/sync-all')
      return data
    } catch (err) {
      error.value = err
      return null
    }
  }

  return {
    calls,
    totalCalls,
    currentCall,
    currentAnalysis,
    loading,
    loadingMore,
    error,
    currentPage,
    hasMore,
    fetchCalls,
    loadMore,
    fetchCall,
    reAnalyze,
    simulateNewCall,
    syncAll,
  }
})
