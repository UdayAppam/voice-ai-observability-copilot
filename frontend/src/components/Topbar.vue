<template>
  <header class="h-14 bg-bg-surface border-b border-border-subtle flex items-center px-4 gap-4 shrink-0">
    <!-- Brand -->
    <RouterLink
      to="/"
      class="flex items-center gap-2 shrink-0"
    >
      <div
        class="w-7 h-7 rounded-card bg-gradient-to-br from-accent-primary to-accent-secondary
                  flex items-center justify-center text-white text-xs font-bold shadow-glow"
      >
        🤖
      </div>
      <span class="text-sm font-bold tracking-tight bg-gradient-to-r from-accent-primary to-accent-secondary text-transparent bg-clip-text">
        AI COPILOT
      </span>
    </RouterLink>

    <!-- Primary nav: 4 persona-aligned tabs -->
    <nav class="hidden md:flex items-center gap-1 ml-3">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        :class="[
          'px-3 py-1.5 text-xs rounded-card font-semibold transition-colors flex items-center gap-1.5',
          isActive(tab) ? 'bg-accent-primary/15 text-accent-primary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated',
        ]"
      >
        <span>{{ tab.icon }}</span>
        <span>{{ tab.label }}</span>
      </RouterLink>
    </nav>

    <!-- Left slot — used by detail views for back navigation -->
    <div class="flex items-center gap-2 ml-2">
      <slot name="left" />
    </div>

    <div class="flex-1" />

    <!-- Filters slot — used by views for date range, sync etc. -->
    <slot name="filters" />

    <!-- Status pill -->
    <div class="flex items-center gap-1.5 text-[11px] text-text-secondary shrink-0">
      <span class="w-2 h-2 rounded-full bg-pass animate-pulse" />
      <span>Live</span>
    </div>
  </header>
</template>

<script setup>
import { RouterLink, useRoute } from 'vue-router'

const route = useRoute()

const tabs = [
  { to: '/',          label: 'Overview', icon: '📊', match: ['overview', 'agent-detail', 'call-detail', 'calls'] },
  { to: '/flywheel',  label: 'Flywheel', icon: '♻️', match: ['flywheel'] },
  { to: '/patterns',  label: 'Patterns', icon: '🔍', match: ['patterns'] },
  { to: '/actions',   label: 'Actions',  icon: '⚠️', match: ['actions'] },
]

function isActive(tab) {
  return tab.match.includes(route.name)
}
</script>
