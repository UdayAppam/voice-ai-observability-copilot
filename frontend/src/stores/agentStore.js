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

  async function fetchAgent(id) {
    loading.value = true
    error.value = null
    currentAgent.value = null
    currentInsights.value = null
    try {
      const { data } = await client.get(`/agents/${id}`)
      currentAgent.value = data
    } catch (err) {
      error.value = err
    } finally {
      loading.value = false
    }
  }

  async function fetchInsights(id) {
    insightsLoading.value = true
    try {
      const { data } = await client.get(`/agents/${id}/insights`)
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
