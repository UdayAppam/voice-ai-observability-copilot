import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  // Vite base is /dashboard/ in prod, / in dev — Vue Router needs the same base
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'overview',
      component: () => import('@/views/OverviewView.vue'),
      meta: { title: 'Overview' },
    },
    {
      path: '/agents/:id',
      name: 'agent-detail',
      component: () => import('@/views/AgentDetailView.vue'),
      meta: { title: 'Agent' },
    },
    {
      path: '/calls',
      name: 'calls',
      component: () => import('@/views/CallsView.vue'),
      meta: { title: 'Calls' },
    },
    {
      path: '/calls/:id',
      name: 'call-detail',
      component: () => import('@/views/CallDetailView.vue'),
      meta: { title: 'Call' },
    },
    {
      path: '/flywheel',
      name: 'flywheel',
      component: () => import('@/views/FlywheelView.vue'),
      meta: { title: 'Flywheel' },
    },
    {
      path: '/patterns',
      name: 'patterns',
      component: () => import('@/views/PatternsView.vue'),
      meta: { title: 'Patterns' },
    },
    {
      path: '/actions',
      name: 'actions',
      component: () => import('@/views/ActionsView.vue'),
      meta: { title: 'Actions' },
    },
  ],
})

export default router
