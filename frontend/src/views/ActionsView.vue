<template>
  <AppShell>
    <template #filters>
      <button
        v-for="tab in tabs"
        :key="tab.key"
        class="text-xs px-3 py-1.5 rounded-card border transition-colors"
        :class="statusFilter === tab.key
          ? 'bg-accent-primary text-white border-accent-primary'
          : 'bg-bg-elevated border-border-subtle text-text-secondary hover:text-text-primary'"
        @click="selectTab(tab.key)"
      >
        {{ tab.label }}
        <span
          v-if="counts[tab.key] > 0"
          class="ml-1 font-mono"
        >({{ counts[tab.key] }})</span>
      </button>
    </template>

    <div class="p-6 space-y-4">
      <div>
        <h1 class="text-xl font-bold text-text-primary">
          Action Queue
        </h1>
        <p class="text-xs text-text-secondary mt-0.5">
          Moments in calls where the AI flagged human follow-up — resolve, dismiss, or escalate
        </p>
      </div>

      <LoadingSpinner
        v-if="loading && !actions.length"
        label="Loading action queue…"
      />
      <ErrorState
        v-else-if="error && !actions.length"
        title="Failed to load actions"
        :message="error.message"
        :on-retry="reload"
      />
      <EmptyState
        v-else-if="!loading && actions.length === 0"
        icon="✅"
        :title="statusFilter === 'pending' ? 'Inbox zero!' : `No ${statusFilter} actions`"
        :subtitle="statusFilter === 'pending'
          ? 'All caller-flagged moments have been addressed.'
          : 'Switch tab to see other action statuses.'"
      />

      <div
        v-else
        class="space-y-2"
      >
        <ActionRow
          v-for="a in actions"
          :key="rowKey(a)"
          :action="a"
          :pending="busyKey === rowKey(a)"
          @verb="onVerb(a, $event)"
        />
      </div>
    </div>
  </AppShell>
</template>

<script setup>
import { ref, onMounted, h } from 'vue'
import { RouterLink } from 'vue-router'
import client from '@/api/client'
import AppShell from '@/components/AppShell.vue'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import ErrorState from '@/components/ErrorState.vue'
import EmptyState from '@/components/EmptyState.vue'

const tabs = [
  { key: 'pending',    label: 'Pending' },
  { key: 'resolved',   label: 'Resolved' },
  { key: 'dismissed',  label: 'Dismissed' },
  { key: 'escalated',  label: 'Escalated' },
]

const statusFilter = ref('pending')
const actions      = ref([])
const counts       = ref({ pending: 0, resolved: 0, dismissed: 0, escalated: 0 })
const loading      = ref(false)
const error        = ref(null)
const busyKey      = ref(null)

function rowKey(a) { return `${a.callId}:${a.turnIndex}:${a.actionType}` }

async function reload() {
  loading.value = true
  error.value   = null
  try {
    const res = await client.get('/actions', {
      params: { status: statusFilter.value, limit: 200 },
    })
    actions.value = res.data.actions
    counts.value  = res.data.counts
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

function selectTab(key) {
  statusFilter.value = key
  reload()
}

// Optimistic: remove from current list immediately, post in background.
// On failure, refetch to restore.
async function onVerb(action, verb) {
  const key = rowKey(action)
  busyKey.value = key
  const idx = actions.value.findIndex((a) => rowKey(a) === key)
  const snapshot = actions.value[idx]
  if (idx >= 0) actions.value.splice(idx, 1)

  // Update tab counters optimistically
  const from = snapshot?.status || 'pending'
  const to   = { resolve: 'resolved', dismiss: 'dismissed', escalate: 'escalated' }[verb]
  counts.value[from] = Math.max(0, counts.value[from] - 1)
  counts.value[to]   = counts.value[to] + 1

  try {
    await client.post(`/actions/${action.callId}/${action.turnIndex}/${action.actionType}/${verb}`)
  } catch (err) {
    // Revert: put it back, refetch to reconcile
    if (idx >= 0 && snapshot) actions.value.splice(idx, 0, snapshot)
    counts.value[from] += 1
    counts.value[to]   -= 1
    error.value = err
  } finally {
    busyKey.value = null
  }
}

onMounted(reload)

// ── Inline row component ──
const ActionRow = {
  props: ['action', 'pending'],
  emits: ['verb'],
  setup(p, { emit }) {
    return () => {
      const a = p.action
      const tone = {
        human_intervention: { badge: 'bg-fail/15 text-fail',                label: 'Human Intervention' },
        script_training:    { badge: 'bg-warn/15 text-warn',                label: 'Script Training' },
        escalation:         { badge: 'bg-accent-primary/15 text-accent-primary', label: 'Escalation' },
      }[a.actionType] || { badge: 'bg-bg-elevated text-text-muted', label: a.actionType }

      // Honest tooltip on each verb — V4 ships the queue lifecycle; downstream
      // workflow actions (SMS, HL task, Slack ping) are V5 scope. Surface that
      // up-front rather than implying these buttons do more than they do.
      const verbTitle = {
        resolve:  'Marks this action as triaged in your queue. (V5 will wire to HL workflow actions — SMS, task creation.)',
        dismiss:  'Hides from the active queue. The AI\'s detection isn\'t affected; if the pattern recurs, it\'ll re-surface.',
        escalate: 'Flags for review. Currently a queue label — no notifications fire yet (V5).',
      }
      const verbBtn = (verb, label, cls) => h('button', {
        class: `text-[11px] px-2 py-1 rounded-sm border transition-colors ${cls}`,
        disabled: p.pending,
        title: verbTitle[verb] || '',
        onClick: () => emit('verb', verb),
      }, p.pending ? '…' : label)

      return h('div', { class: 'card p-3 flex items-start gap-3' }, [
        h('div', { class: 'flex-1 min-w-0' }, [
          h('div', { class: 'flex items-center gap-2 mb-1 flex-wrap' }, [
            h('span', { class: `text-[10px] px-1.5 py-0.5 rounded-sm font-mono ${tone.badge}` }, tone.label),
            h(RouterLink, {
              to: `/agents/${a.agentId}`,
              class: 'text-[11px] text-accent-primary hover:underline',
            }, () => a.agentName),
            h('span', { class: 'text-[10px] text-text-muted' }, '·'),
            // Link → Call Detail with `?turn=` so the transcript pre-scrolls
            // to the flagged turn. Visually distinct (underline + chevron) so
            // users know it's clickable.
            h(RouterLink, {
              to: { path: `/calls/${a.callId}`, query: { turn: a.turnIndex } },
              class: 'text-[11px] text-accent-primary hover:text-accent-secondary font-mono underline decoration-dotted underline-offset-2',
              title: `Open call ${a.callId.slice(-6)} · scrolls to turn ${a.turnIndex}`,
            }, () => `call ${a.callId.slice(-6)} ↗`),
            h('span', { class: 'text-[10px] text-text-muted' }, `· turn ${a.turnIndex}`),
            a.overallScore !== null && h('span', {
              class: `text-[10px] px-1.5 py-0.5 rounded-sm font-mono ${a.overallScore >= 70 ? 'bg-pass/15 text-pass' : a.overallScore >= 40 ? 'bg-warn/15 text-warn' : 'bg-fail/15 text-fail'}`,
            }, `${a.overallScore}/100`),
          ]),
          h('div', { class: 'text-sm text-text-primary' }, a.reason),
          a.transcriptSegment && h('div', {
            class: 'text-xs text-text-muted italic mt-1 truncate',
          }, `"${a.transcriptSegment}"`),
        ]),
        h('div', { class: 'flex flex-col gap-1 shrink-0' }, [
          a.status === 'pending'
            ? h('div', { class: 'flex gap-1' }, [
                verbBtn('resolve',  '✓ Resolve',  'border-pass/40 text-pass hover:bg-pass/10'),
                verbBtn('dismiss',  'Dismiss',    'border-border-subtle text-text-muted hover:bg-bg-elevated'),
                verbBtn('escalate', '↑ Escalate', 'border-fail/40 text-fail hover:bg-fail/10'),
              ])
            : h('div', { class: 'flex flex-col items-end gap-0.5' }, [
                h('span', {
                  class: `text-[11px] px-2 py-0.5 rounded-sm font-mono ${
                    a.status === 'resolved'  ? 'bg-pass/15 text-pass' :
                    a.status === 'dismissed' ? 'bg-text-muted/15 text-text-muted' :
                                               'bg-fail/15 text-fail'
                  }`,
                }, a.status),
                a.updatedAt && h('span', { class: 'text-[10px] text-text-muted' }, new Date(a.updatedAt).toLocaleString()),
              ]),
        ]),
      ])
    }
  },
}
</script>
