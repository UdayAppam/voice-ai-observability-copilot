<template>
  <div
    class="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
    @click.self="onCancel"
  >
    <div
      class="bg-bg-surface border border-border-subtle rounded-card max-w-5xl w-full max-h-[90vh] flex flex-col shadow-2xl"
    >
      <!-- Header -->
      <header class="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div class="min-w-0">
          <div class="text-[10px] uppercase tracking-wide text-accent-primary font-semibold">
            One-click Apply · V4
          </div>
          <h2 class="text-base font-bold text-text-primary truncate">
            Apply recommendation: {{ recommendation.title }}
          </h2>
        </div>
        <button
          class="text-text-muted hover:text-text-primary text-base"
          :disabled="applying"
          @click="onCancel"
        >
          ✕
        </button>
      </header>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto p-4 space-y-4">
        <LoadingSpinner
          v-if="loading"
          label="Loading current agent + AI suggestion…"
        />
        <!-- Friendly empty-state when running against a demo/regression agent
             that doesn't exist in HighLevel -->
        <div
          v-else-if="isDemoAgentError"
          class="text-center py-10"
        >
          <div class="text-3xl mb-3">
            🧪
          </div>
          <div class="text-base font-semibold text-text-primary mb-1">
            Apply isn't available in test mode
          </div>
          <p class="text-xs text-text-secondary max-w-md mx-auto leading-relaxed">
            This recommendation belongs to a regression-test agent (used for verifying the
            copilot detects issues correctly). Apply writes to a real HighLevel Voice AI agent —
            switch to <strong class="text-text-primary">live mode</strong> to try it.
          </p>
          <pre class="text-[11px] text-text-muted mt-3 inline-block bg-bg-elevated px-3 py-2 rounded-sm">bash .runtime/use-data.sh live</pre>
        </div>
        <ErrorState
          v-else-if="loadError"
          title="Couldn't load preview"
          :message="loadError"
          :on-retry="load"
        />

        <!-- Receipt view (after successful apply) -->
        <ApplyReceiptPanel
          v-else-if="receipt"
          :receipt="receipt"
          @close="$emit('close', { applied: true, receipt })"
        />

        <!-- Diff + editable form (the main view) -->
        <template v-else-if="preview">
          <!-- Target -->
          <div class="text-xs text-text-secondary">
            <span class="text-text-muted">Agent:</span> <strong class="text-text-primary">{{ preview.agent.name }}</strong>
            <span class="text-text-muted mx-2">·</span>
            <span class="text-text-muted">Current prompt:</span> {{ preview.agent.currentPromptLength.toLocaleString() }} chars
            <span class="text-text-muted mx-2">·</span>
            <span class="text-text-muted">Will become:</span> ~{{ proposedText.length.toLocaleString() }} chars
          </div>

          <!-- Why this recommendation -->
          <div class="bg-bg-elevated rounded-card p-3">
            <div class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-1">
              Why this fix
            </div>
            <div class="text-xs text-text-secondary leading-relaxed">
              Severity: <span :class="severityClass">{{ recommendation.severity }}</span>.
              The AI's suggested addition: <em>"{{ truncate(preview.recommendation.suggestedChange, 200) }}"</em>
            </div>
          </div>

          <!-- The diff with editable right panel -->
          <div>
            <div class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-2">
              Diff · current vs proposed (right panel is editable)
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <!-- Current (read-only) -->
              <div>
                <div class="text-[10px] text-text-muted mb-1">
                  CURRENT
                </div>
                <pre class="bg-bg-elevated text-text-secondary text-[11px] font-mono p-3 rounded-card border border-border-subtle h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed">{{ preview.currentText }}</pre>
              </div>
              <!-- Proposed (editable) -->
              <div>
                <div class="text-[10px] text-text-muted mb-1 flex items-center justify-between">
                  <span>PROPOSED <span class="text-accent-primary normal-case">(editable)</span></span>
                  <button
                    v-if="edited"
                    class="text-[10px] text-accent-primary hover:text-accent-secondary"
                    @click="resetToAi"
                  >
                    ↺ Reset to AI suggestion
                  </button>
                </div>
                <textarea
                  v-model="proposedText"
                  class="bg-bg-elevated text-text-primary text-[11px] font-mono p-3 rounded-card border h-64 w-full overflow-y-auto whitespace-pre-wrap leading-relaxed resize-none focus:outline-none focus:ring-1"
                  :class="edited ? 'border-accent-primary/50 focus:ring-accent-primary' : 'border-border-subtle focus:ring-accent-primary/50'"
                  spellcheck="false"
                  @input="onEdit"
                />
                <div class="text-[10px] text-text-muted mt-1 flex items-center gap-2">
                  <span
                    v-if="!edited"
                    class="text-text-muted"
                  >ⓘ AI suggestion · ✎ 0 chars edited</span>
                  <span
                    v-else
                    class="text-accent-secondary"
                  >✎ {{ editDelta }} chars edited from AI suggestion</span>
                  <span class="text-text-muted">·</span>
                  <span :class="validating ? 'text-warn' : 'text-text-muted'">
                    {{ validating ? 'validating…' : 'validators ready' }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- Validators -->
          <div>
            <div class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-2">
              Validator checks <span class="normal-case">(re-run live as you edit)</span>
            </div>
            <div
              v-if="validation"
              class="space-y-1"
            >
              <div
                v-for="check in validation.checks"
                :key="check.name"
                class="flex items-start gap-2 text-xs"
              >
                <span :class="severityIconClass(check.severity)">{{ severityIcon(check.severity) }}</span>
                <span class="text-text-primary font-medium w-40 shrink-0">{{ checkLabel(check.name) }}</span>
                <span class="text-text-secondary flex-1 min-w-0">{{ check.message }}</span>
              </div>
            </div>
          </div>

          <!-- What will happen -->
          <div class="bg-bg-elevated rounded-card p-3">
            <div class="text-[10px] uppercase tracking-wide text-text-muted font-semibold mb-2">
              What will happen on Confirm
            </div>
            <ol class="text-xs text-text-secondary space-y-1 list-decimal list-inside">
              <li>Snapshot current agentPrompt to our DB (rollback safety)</li>
              <li>PATCH /voice-ai/agents/{{ shortId }} with the proposed text</li>
              <li>Mark recommendation as applied</li>
              <li>Future calls run on the new prompt — Flywheel Measure stage shows the delta after ≥1 call</li>
              <li>If it regresses, click Rollback on the rec card — previous prompt restored in seconds</li>
            </ol>
          </div>

          <!-- Optional user email (audit) -->
          <div>
            <label class="text-[10px] uppercase tracking-wide text-text-muted font-semibold block mb-1">
              Your email <span class="normal-case text-text-muted">(optional · audit)</span>
            </label>
            <input
              v-model="userEmail"
              type="email"
              placeholder="you@agency.com"
              class="bg-bg-elevated border border-border-subtle text-text-primary text-xs rounded-card px-2 py-1.5 w-64"
            >
          </div>

          <!-- Apply error (after a failed apply attempt) -->
          <div
            v-if="applyError"
            class="bg-fail/10 border border-fail/40 rounded-card p-3"
          >
            <div class="text-[10px] uppercase tracking-wide text-fail font-semibold mb-1">
              Apply failed
            </div>
            <div class="text-xs text-text-secondary">
              {{ applyError }}
            </div>
            <div class="text-[10px] text-text-muted mt-2">
              Your HL agent is unchanged. You can edit and retry, or copy the proposed text and paste it manually.
            </div>
          </div>
        </template>
      </div>

      <!-- Footer (hidden in receipt + demo-agent + loading modes) -->
      <footer
        v-if="!receipt && !loading && !isDemoAgentError"
        class="flex items-center justify-end gap-2 px-4 py-3 border-t border-border-subtle"
      >
        <button
          class="text-xs px-3 py-1.5 rounded-card border border-border-subtle text-text-secondary hover:text-text-primary"
          :disabled="applying"
          @click="onCancel"
        >
          Cancel
        </button>
        <button
          class="text-xs px-3 py-1.5 rounded-card border font-semibold transition-colors"
          :class="canConfirm
            ? 'bg-accent-primary text-white border-accent-primary hover:bg-accent-secondary'
            : 'bg-bg-elevated text-text-muted border-border-subtle cursor-not-allowed'"
          :disabled="!canConfirm"
          :title="canConfirm ? '' : (blockingReason || 'Fix the blocking validator issues to enable Confirm')"
          @click="onConfirm"
        >
          <span v-if="applying">Applying…</span>
          <span v-else-if="edited">▶ Apply your edit</span>
          <span v-else>▶ Apply AI suggestion</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import client from '@/api/client'
import { useDebouncedValidate } from '@/composables/useDebouncedValidate'
import LoadingSpinner from '@/components/LoadingSpinner.vue'
import ErrorState from '@/components/ErrorState.vue'
import ApplyReceiptPanel from '@/components/ApplyReceiptPanel.vue'

const props = defineProps({
  recommendation: { type: Object, required: true }, // { id, agentId, title, severity }
})
const emit = defineEmits(['close'])

const loading      = ref(true)
const loadError    = ref(null)
const isDemoAgentError = ref(false)
const preview      = ref(null)
const proposedText = ref('')
const userEmail    = ref(localStorage.getItem('copilot.userEmail') || '')
const applying     = ref(false)
const applyError   = ref(null)
const receipt      = ref(null)

const { validation, validating, run, setInitial } = useDebouncedValidate(props.recommendation.id)

const edited     = computed(() => proposedText.value !== preview.value?.aiSuggestedText)
const editDelta  = computed(() => Math.abs(proposedText.value.length - (preview.value?.aiSuggestedText.length || 0)))
const blockingReason = computed(() => {
  if (!validation.value) return null
  const blockers = validation.value.checks.filter((c) => c.severity === 'fail')
  if (blockers.length === 0) return null
  return blockers.map((b) => b.message).join(' · ')
})
const canConfirm = computed(() =>
  !applying.value && !validating.value && !!preview.value && !validation.value?.blocking
)

const severityClass = computed(() => ({
  critical:   'text-fail font-semibold',
  warning:    'text-warn font-semibold',
  suggestion: 'text-accent-primary font-semibold',
})[props.recommendation.severity])
const shortId = computed(() => props.recommendation.agentId?.slice(-6) || '…')

watch(userEmail, (v) => { localStorage.setItem('copilot.userEmail', v || '') })

async function load() {
  loading.value = true
  loadError.value = null
  isDemoAgentError.value = false
  try {
    const { data } = await client.get(`/recommendations/${props.recommendation.id}/preview-apply`)
    preview.value = data
    proposedText.value = data.aiSuggestedText
    setInitial(data.validation)
  } catch (err) {
    if (err.code === 'DEMO_AGENT') {
      isDemoAgentError.value = true
    } else {
      loadError.value = err.message || 'Failed to load preview'
    }
  } finally {
    loading.value = false
  }
}

function onEdit() { run(proposedText.value) }
function resetToAi() {
  proposedText.value = preview.value.aiSuggestedText
  setInitial(preview.value.validation)
}

async function onConfirm() {
  applying.value = true
  applyError.value = null
  try {
    const { data } = await client.post(
      `/agents/${props.recommendation.agentId}/recommendations/${props.recommendation.id}/apply`,
      { finalText: proposedText.value, userEmail: userEmail.value || null }
    )
    // Augment receipt with name for the panel header
    receipt.value = { ...data, agentName: preview.value.agent.name }
  } catch (err) {
    applyError.value = err.message || (err.body?.error?.message) || 'Apply failed'
  } finally {
    applying.value = false
  }
}

function onCancel() {
  if (applying.value) return
  if (edited.value && !receipt.value) {
    if (!confirm('Discard your edits and close?')) return
  }
  emit('close', { applied: !!receipt.value, receipt: receipt.value })
}

function severityIcon(sev) { return sev === 'fail' ? '✗' : sev === 'warn' ? '⚠' : '✓' }
function severityIconClass(sev) {
  return sev === 'fail' ? 'text-fail font-bold w-4 shrink-0' :
         sev === 'warn' ? 'text-warn font-bold w-4 shrink-0' :
                          'text-pass font-bold w-4 shrink-0'
}
function checkLabel(name) {
  return ({
    template_vars:     'Template vars',
    length:            'Length',
    tone:              'Tone',
    forbidden_content: 'Forbidden content',
    call_length:       'Call length',
    network:           'Network',
  }[name]) || name
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s }

onMounted(load)
</script>
