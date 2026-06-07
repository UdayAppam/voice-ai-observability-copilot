import { defineStore } from 'pinia'
import { ref } from 'vue'
import client from '@/api/client'

export const useCallStore = defineStore('calls', () => {
  const calls = ref([])
  const totalCalls = ref(0)
  const currentCall = ref(null)
  const currentAnalysis = ref(null)
  const loading = ref(false)
  const error = ref(null)
  const currentPage = ref(1)

  async function fetchCalls(agentId, { page = 1, limit = 20, status = 'all' } = {}) {
    loading.value = true
    error.value = null
    try {
      const { data } = await client.get(`/agents/${agentId}/calls`, {
        params: { page, limit, status },
      })
      calls.value = data.calls
      totalCalls.value = data.total
      currentPage.value = data.page
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
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
    error,
    currentPage,
    fetchCalls,
    fetchCall,
    reAnalyze,
    simulateNewCall,
    syncAll,
  }
})
