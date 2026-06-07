<template>
  <div
    class="card transition-all duration-200"
    :class="expanded ? 'border-accent-primary/40 shadow-glow' : 'cursor-pointer hover:border-border-strong'"
    @click="!expanded && $emit('expand')"
  >
    <!-- COLLAPSED HEADER -->
    <div class="p-3 flex items-start gap-3">
      <div
        class="w-9 h-9 rounded-card flex items-center justify-center text-base shrink-0"
        :class="iconBg"
      >
        {{ icon }}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 mb-0.5">
          <div class="text-[10px] text-text-muted uppercase tracking-wide">
            Stage {{ stageNumber }}
          </div>
          <div
            v-if="healthBadge"
            class="text-[10px] px-1.5 py-0.5 rounded-sm font-mono"
            :class="badgeClass"
          >
            {{ healthBadge }}
          </div>
        </div>
        <div class="text-sm font-semibold text-text-primary truncate">
          {{ name }}
        </div>
        <div class="text-xs text-text-secondary mt-0.5 truncate">
          {{ narrative.what }}
        </div>
      </div>
      <button
        v-if="expanded"
        class="text-text-muted hover:text-text-primary text-xs"
        @click.stop="$emit('collapse')"
      >
        ✕
      </button>
      <span
        v-else
        class="text-text-muted text-xs"
      >▾</span>
    </div>

    <!-- EXPANDED BODY -->
    <div
      v-if="expanded"
      class="border-t border-border-subtle px-3 py-3 space-y-3"
    >
      <div>
        <div class="text-[10px] text-text-muted uppercase tracking-wide mb-1">
          Why
        </div>
        <div class="text-xs text-text-secondary leading-relaxed">
          {{ narrative.why }}
        </div>
      </div>

      <div v-if="narrative.evidence && narrative.evidence.length > 0">
        <div class="text-[10px] text-text-muted uppercase tracking-wide mb-1">
          Evidence
        </div>
        <div class="flex flex-wrap gap-1.5">
          <component
            :is="evidenceComponent(ev)"
            v-for="(ev, i) in narrative.evidence"
            :key="i"
            v-bind="evidenceProps(ev)"
            class="inline-flex items-center text-[11px] px-2 py-1 rounded-sm
                   bg-bg-elevated text-text-secondary hover:bg-bg-surface hover:text-text-primary
                   border border-border-subtle"
          >
            {{ ev.label }}
          </component>
        </div>
      </div>

      <div v-if="narrative.actionLabel">
        <component
          :is="actionComponent"
          v-bind="actionProps"
          class="inline-flex items-center gap-1 text-xs font-semibold text-accent-primary hover:text-accent-secondary"
        >
          {{ narrative.actionLabel }}
        </component>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'

const props = defineProps({
  stageNumber: { type: Number, required: true },
  name:        { type: String, required: true },
  icon:        { type: String, default: '●' },
  tone:        { type: String, default: 'primary' }, // primary|secondary|warn|pass|fail
  healthBadge: { type: String, default: '' },        // optional "🟢 healthy" / "🔴 attention"
  narrative:   { type: Object, required: true },     // { what, why, evidence[], actionLabel, actionHref }
  expanded:    { type: Boolean, default: false },
})
defineEmits(['expand', 'collapse'])

const iconBg = computed(() => ({
  primary:   'bg-accent-primary/15 text-accent-primary',
  secondary: 'bg-accent-secondary/15 text-accent-secondary',
  warn:      'bg-warn/15 text-warn',
  pass:      'bg-pass/15 text-pass',
  fail:      'bg-fail/15 text-fail',
}[props.tone]))

const badgeClass = computed(() => {
  if (props.healthBadge.startsWith('🟢')) return 'bg-pass/15 text-pass'
  if (props.healthBadge.startsWith('🟡')) return 'bg-warn/15 text-warn'
  if (props.healthBadge.startsWith('🔴')) return 'bg-fail/15 text-fail'
  return 'bg-bg-elevated text-text-muted'
})

// Evidence items can be { type: 'call', refId, label } → router link
//                       { type: 'recommendation', refId, label } → link to patterns
//                       anything else → static span
function evidenceComponent(ev) {
  if (ev.type === 'call' && ev.refId) return RouterLink
  if (ev.type === 'agent' && ev.refId) return RouterLink
  if (ev.type === 'recommendation') return RouterLink
  return 'span'
}
function evidenceProps(ev) {
  if (ev.type === 'call' && ev.refId)  return { to: `/calls/${ev.refId}` }
  if (ev.type === 'agent' && ev.refId) return { to: `/agents/${ev.refId}` }
  if (ev.type === 'recommendation')    return { to: '/patterns' }
  return {}
}

// Action CTA: route internally or scroll target
const actionComponent = computed(() => {
  if (!props.narrative.actionHref) return 'span'
  if (props.narrative.actionHref.startsWith('/')) return RouterLink
  return 'a'
})
const actionProps = computed(() => {
  if (!props.narrative.actionHref) return {}
  if (props.narrative.actionHref.startsWith('/')) return { to: props.narrative.actionHref }
  return { href: props.narrative.actionHref }
})
</script>
