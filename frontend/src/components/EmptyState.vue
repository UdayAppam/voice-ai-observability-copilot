<template>
  <div class="flex flex-col items-center justify-center py-16 text-center">
    <div class="mb-4 text-4xl opacity-30">
      {{ icon }}
    </div>
    <p class="text-sm font-medium text-hl-text">
      {{ title }}
    </p>
    <p
      v-if="subtitle"
      class="mt-1 text-xs text-hl-muted"
    >
      {{ subtitle }}
    </p>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  icon:     { type: String, default: '📭' },
  title:    { type: String, required: true },
  subtitle: { type: String, default: '' },
})
</script>
