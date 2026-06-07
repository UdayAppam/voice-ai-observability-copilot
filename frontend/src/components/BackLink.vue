<template>
  <RouterLink
    :to="to"
    class="flex items-center gap-1.5 text-xs text-text-secondary hover:text-text-primary px-2 py-1 rounded-card hover:bg-bg-elevated transition-colors"
  >
    <span class="text-base leading-none">←</span>
    <span class="font-medium">{{ label }}</span>
  </RouterLink>
</template>

<script setup>
defineProps({
  label: { type: String, default: 'Back' },
  // Explicit destination — label always matches where the link goes.
  // No router.back() / history magic, which would otherwise lie about destination
  // when user lands deep-linked (HL Custom Page iframe) or arrives via filter UI.
  to: { type: [String, Object], required: true },
})
</script>
