<template>
  <div
    class="flex items-center justify-center"
    :class="fullPage ? 'h-64' : 'h-12'"
  >
    <div
      class="animate-spin rounded-full border-2 border-hl-border border-t-hl-primary"
      :class="size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-10 w-10' : 'h-6 w-6'"
    />
    <span
      v-if="label"
      class="ml-3 text-sm text-hl-muted"
    >{{ label }}</span>
  </div>
</template>

<script setup>
defineProps({
  size:     { type: String, default: 'md' },   // sm | md | lg
  label:    { type: String, default: '' },
  fullPage: { type: Boolean, default: false },
})
</script>
