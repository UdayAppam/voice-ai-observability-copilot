<template>
  <div class="flex flex-col items-center justify-center py-16 text-center">
    <div class="mb-4 text-4xl">
      ⚠️
    </div>
    <p class="text-sm font-semibold text-hl-fail">
      {{ title }}
    </p>
    <p class="mt-1 text-xs text-hl-muted">
      {{ message }}
    </p>
    <button
      v-if="onRetry"
      class="mt-4 btn-primary text-xs"
      @click="onRetry"
    >
      Retry
    </button>
  </div>
</template>

<script setup>
defineProps({
  title:   { type: String, default: 'Something went wrong' },
  message: { type: String, default: 'Check your connection and try again.' },
  onRetry: { type: Function, default: null },
})
</script>
