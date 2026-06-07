<template>
  <div>
    <div class="flex h-2 rounded-full overflow-hidden bg-hl-border">
      <div
        v-if="pass > 0"
        class="bg-hl-pass"
        :style="{ width: pct(pass) + '%' }"
        :title="`${pass} passing calls`"
      />
      <div
        v-if="warning > 0"
        class="bg-hl-warn"
        :style="{ width: pct(warning) + '%' }"
        :title="`${warning} warning calls`"
      />
      <div
        v-if="fail > 0"
        class="bg-hl-fail"
        :style="{ width: pct(fail) + '%' }"
        :title="`${fail} failing calls`"
      />
    </div>
    <div
      v-if="showLabels && total > 0"
      class="flex justify-between text-[10px] mt-0.5 font-mono"
    >
      <span class="text-hl-pass">✓ {{ pass }}</span>
      <span class="text-hl-warn">⚠ {{ warning }}</span>
      <span class="text-hl-fail">✗ {{ fail }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  pass:       { type: Number, default: 0 },
  warning:    { type: Number, default: 0 },
  fail:       { type: Number, default: 0 },
  showLabels: { type: Boolean, default: false },
})

const total = computed(() => props.pass + props.warning + props.fail)

function pct(n) {
  if (total.value === 0) return 0
  return (n / total.value) * 100
}
</script>
