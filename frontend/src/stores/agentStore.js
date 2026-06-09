import { defineStore } from 'pinia'
import { ref } from 'vue'
import client from '@/api/client'

export const useAgentStore = defineStore('agents', () => {
  const agents = ref([])
  const currentAgent = ref(null)
  const currentInsights = ref(null)
  const dashboardSummary = ref(null)
  const loading = ref(false)
  const insightsLoading = ref(false)
  const error = ref(null)

  async function fetchDashboard() {
    loading.value = true
    error.value = null
    try {
      const { data } = await client.get('/dashboard/summary')
      dashboardSummary.value = data
      agents.value = data.agents
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  async function fetchAgents() {
    loading.value = true
    error.value = null
    try {
      const { data } = await client.get('/agents')
      agents.value = data.agents
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  // V5.5 — accepts { days } so aggregates (useActions, deviations, recently
  // applied) respect the period selector on Agent Detail.
  async function fetchAgent(id, { days = 30 } = {}) {
    loading.value = true
    error.value = null
    currentAgent.value = null
    currentInsights.value = null
    try {
      const { data } = await client.get(`/agents/${id}`, { params: { days } })
      currentAgent.value = data
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  // Pass { refresh: true } to bypass server-side cache (Re-analyse button)
  async function fetchInsights(id, { refresh = false } = {}) {
    insightsLoading.value = true
    try {
      const params = refresh ? { refresh: 'true' } : {}
      const { data } = await client.get(`/agents/${id}/insights`, { params })
      currentInsights.value = data
    } catch (err) {
      currentInsights.value = null
    } finally {
      insightsLoading.value = false
    }
  }

  return {
    agents,
    currentAgent,
    currentInsights,
    dashboardSummary,
    loading,
    insightsLoading,
    error,
    fetchDashboard,
    fetchAgents,
    fetchAgent,
    fetchInsights,
  }
})
