<template>
  <div class="h-screen flex flex-col bg-bg-base font-sans overflow-hidden text-text-primary">
    <Topbar>
      <template #left>
        <slot name="back" />
      </template>
      <template #filters>
        <slot name="filters" />
      </template>
    </Topbar>
    <main class="flex-1 overflow-y-auto">
      <slot />
    </main>
  </div>
</template>

<script setup>
import Topbar from '@/components/Topbar.vue'
</script>
