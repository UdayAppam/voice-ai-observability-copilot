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

          <!-- V4.2 — section-aware insertion info + V4.6 enhancements (A, B) -->
          <div
            v-if="preview.sectionAware"
            class="bg-accent-primary/5 border-l-4 border-l-accent-primary rounded-card p-3"
          >
            <div class="flex items-center justify-between mb-1">
              <div class="text-[10px] uppercase tracking-wide text-accent-primary-text font-semibold">
                Section-aware insertion
                <span
                  v-if="preview.sectionAware.userForcedSection"
                  class="ml-1 text-warn normal-case"
                >· manual override</span>
              </div>
              <div class="text-[10px] text-text-muted">
                Parsed into {{ preview.sectionAware.sections?.length || 0 }} section{{ (preview.sectionAware.sections?.length || 0) === 1 ? '' : 's' }}
              </div>
            </div>

            <div class="text-xs text-text-secondary leading-relaxed">
              The AI determined this fix belongs in the
              <strong class="text-text-primary">{{ preview.sectionAware.targetSectionName }}</strong>
              section ({{ preview.sectionAware.confidence }} confidence,
              <code class="text-[10px]">{{ preview.sectionAware.insertionMode }}</code>).
              <span class="text-text-muted block mt-1 italic">
                {{ preview.sectionAware.reasoning }}
              </span>
              <span
                v-if="preview.sectionAware.fallback"
                class="block mt-2 text-warn text-[11px]"
              >
                ⚠ Insertion fell back to append (<code>{{ preview.sectionAware.fallback }}</code>) —
                review the diff carefully or edit the textarea below.
              </span>
            </div>

            <!-- (B) Manual section override dropdown -->
            <div
              v-if="preview.sectionAware.sections?.length > 1"
              class="mt-3 flex items-center gap-2 text-[11px]"
            >
              <label class="text-text-muted shrink-0">Place this fix in:</label>
              <select
                v-model="userChosenSectionId"
                class="bg-bg-elevated border border-border-subtle text-text-primary rounded-sm px-2 py-1 text-[11px]"
                :disabled="reloading"
                @change="onSectionOverride"
              >
                <option :value="null">
                  AI chooses (default)
                </option>
                <option
                  v-for="s in preview.sectionAware.sections"
                  :key="s.id"
                  :value="s.id"
                >
                  {{ s.name }} ({{ s.textLength }} chars)
                </option>
              </select>
              <span
                v-if="reloading"
                class="text-text-muted text-[10px]"
              >regenerating…</span>
            </div>

            <!-- (A) Toggleable full section breakdown -->
            <details
              v-if="preview.sectionAware.sections?.length > 0"
              class="mt-3"
            >
              <summary class="text-[11px] text-accent-primary-text cursor-pointer hover:text-text-primary">
                ▾ See all {{ preview.sectionAware.sections.length }} sections in this agent's prompt
              </summary>
              <div class="mt-2 space-y-1 pl-3 border-l-2 border-border-subtle">
                <div
                  v-for="s in preview.sectionAware.sections"
                  :key="s.id"
                  class="text-[11px] leading-relaxed"
                  :class="s.id === preview.sectionAware.targetSectionId ? 'text-text-primary' : 'text-text-muted'"
                >
                  <span :class="s.id === preview.sectionAware.targetSectionId ? 'text-accent-primary-text font-semibold' : ''">
                    {{ s.id === preview.sectionAware.targetSectionId ? '►' : '·' }}
                    {{ s.name }}
                  </span>
                  <span class="text-text-muted ml-1">({{ s.textLength }} chars)</span>
                  <span class="block ml-3 text-text-muted italic">{{ s.summary }}</span>
                </div>
              </div>
            </details>
          </div>

          <!-- V4.7 — Edit-mode toggle (section-focused vs whole-prompt) -->
          <div class="flex items-center justify-between">
            <div class="text-[10px] uppercase tracking-wide text-text-muted font-semibold">
              {{ editMode === 'section' ? `Edit just the ${preview.sectionAware?.targetSectionName || 'target'} section` : 'Edit whole prompt' }}
              <span class="normal-case text-text-muted">— added text is highlighted</span>
            </div>
            <div class="flex items-center gap-2">
              <button
                v-if="sectionEditAvailable"
                class="text-[10px] text-accent-primary-text hover:text-text-primary px-2 py-1 rounded-sm border border-border-subtle"
                @click="toggleEditMode"
              >
                {{ editMode === 'section' ? '⤢ Edit whole prompt instead' : '⤡ Back to section-focused edit' }}
              </button>
              <button
                v-if="edited"
                class="text-[10px] text-accent-primary-text hover:text-accent-secondary-text"
                @click="resetToAi"
              >
                ↺ Reset to AI suggestion
              </button>
            </div>
          </div>

          <!-- V4.7a — SECTION-FOCUSED EDITOR (default when sectionAware works) -->
          <div v-if="editMode === 'section' && sectionEditAvailable">
            <!-- Inline diff preview at top — shows the AI's section change with added/removed highlights -->
            <div
              v-if="!edited && sectionDiff"
              class="bg-pass/5 border-l-4 border-l-pass/50 rounded-card p-3 mb-3"
            >
              <div class="text-[10px] uppercase tracking-wide text-pass font-semibold mb-1.5">
                AI's change to <strong>{{ preview.sectionAware.targetSectionName }}</strong>
                — added text highlighted
              </div>
              <pre class="text-[11px] font-mono whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto"><span
                v-for="(c, i) in sectionDiff"
                :key="i"
                :class="diffChunkClass(c.type)"
              >{{ c.text }}</span></pre>
              <div class="text-[10px] text-text-muted mt-2">
                {{ preview.sectionAware.modifiedSectionText.length - preview.sectionAware.targetSectionText.length }} chars added · review or edit below
              </div>
            </div>

            <!-- The actual editable surface — just the target section -->
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <!-- BEFORE (read-only) -->
              <div>
                <div class="text-[10px] text-text-muted mb-1">
                  ORIGINAL · {{ preview.sectionAware.targetSectionName }}
                  ({{ preview.sectionAware.targetSectionText?.length || 0 }} chars)
                </div>
                <pre class="bg-bg-elevated text-text-secondary text-[11px] font-mono p-3 rounded-card border border-border-subtle h-56 overflow-y-auto whitespace-pre-wrap leading-relaxed">{{ preview.sectionAware.targetSectionText }}</pre>
              </div>
              <!-- AFTER (editable) -->
              <div>
                <div class="text-[10px] mb-1 flex items-center justify-between">
                  <span class="text-pass">MODIFIED <span class="text-accent-primary-text normal-case">(editable)</span></span>
                  <span class="text-text-muted normal-case">{{ editedSectionText.length }} chars</span>
                </div>
                <textarea
                  v-model="editedSectionText"
                  class="bg-bg-elevated text-text-primary text-[11px] font-mono p-3 rounded-card border h-56 w-full overflow-y-auto whitespace-pre-wrap leading-relaxed resize-none focus:outline-none focus:ring-1"
                  :class="edited ? 'border-accent-primary/50 focus:ring-accent-primary' : 'border-pass/30 focus:ring-pass/50'"
                  spellcheck="false"
                />
                <div class="text-[10px] text-text-muted mt-1 flex items-center gap-2">
                  <span
                    v-if="!edited"
                    class="text-text-muted"
                  >ⓘ AI's section text · click textarea to tune wording</span>
                  <span
                    v-else
                    class="text-accent-secondary-text"
                  >✎ {{ editDelta }} chars edited from AI suggestion</span>
                  <span class="text-text-muted">·</span>
                  <span :class="validating ? 'text-warn' : 'text-text-muted'">
                    {{ validating ? 'validating…' : 'validators ready' }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Collapsed "see full prompt context" expand -->
            <details class="mt-3">
              <summary class="text-[11px] text-accent-primary-text cursor-pointer hover:text-text-primary">
                ▾ Show full prompt context (read-only, with your section spliced in)
              </summary>
              <div class="mt-2">
                <div class="text-[10px] uppercase tracking-wide text-text-muted mb-1">
                  Full prompt after splice ({{ proposedFullText.length }} chars total)
                </div>
                <pre
                  v-if="fullPromptDiff"
                  class="bg-bg-elevated text-[11px] font-mono p-3 rounded-card border border-border-subtle max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed"
                ><span
                  v-for="(c, i) in fullPromptDiff"
                  :key="i"
                  :class="diffChunkClass(c.type)"
                >{{ c.text }}</span></pre>
              </div>
            </details>
          </div>

          <!-- V4.7b — WHOLE-PROMPT EDITOR (fallback OR user opted in) -->
          <div v-else>
            <div
              v-if="!sectionEditAvailable"
              class="text-[10px] text-warn mb-2"
            >
              ⚠ Section-focused edit unavailable
              ({{ preview.sectionAware?.fallback || 'no section info' }}) — editing the whole prompt instead.
            </div>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <!-- Current full prompt (read-only, with highlights) -->
              <div>
                <div class="text-[10px] text-text-muted mb-1">
                  CURRENT (whole prompt, {{ preview.currentText.length }} chars)
                </div>
                <pre class="bg-bg-elevated text-text-secondary text-[11px] font-mono p-3 rounded-card border border-border-subtle h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed">{{ preview.currentText }}</pre>
              </div>
              <!-- Proposed full prompt (editable) -->
              <div>
                <div class="text-[10px] mb-1 flex items-center justify-between">
                  <span class="text-text-muted">PROPOSED <span class="text-accent-primary-text normal-case">(editable)</span></span>
                  <span class="text-text-muted normal-case">{{ editedFullText.length }} chars</span>
                </div>
                <textarea
                  v-model="editedFullText"
                  class="bg-bg-elevated text-text-primary text-[11px] font-mono p-3 rounded-card border h-64 w-full overflow-y-auto whitespace-pre-wrap leading-relaxed resize-none focus:outline-none focus:ring-1"
                  :class="edited ? 'border-accent-primary/50 focus:ring-accent-primary' : 'border-border-subtle focus:ring-accent-primary/50'"
                  spellcheck="false"
                />
                <div class="text-[10px] text-text-muted mt-1 flex items-center gap-2">
                  <span
                    v-if="!edited"
                    class="text-text-muted"
                  >ⓘ AI suggestion · ✎ 0 chars edited</span>
                  <span
                    v-else
                    class="text-accent-secondary-text"
                  >✎ {{ editDelta }} chars edited from AI suggestion</span>
                  <span class="text-text-muted">·</span>
                  <span :class="validating ? 'text-warn' : 'text-text-muted'">
                    {{ validating ? 'validating…' : 'validators ready' }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Inline change overview (highlighted) -->
            <details
              v-if="fullPromptDiff"
              class="mt-3"
            >
              <summary class="text-[11px] text-accent-primary-text cursor-pointer hover:text-text-primary">
                ▾ Show what changed (highlighted view, read-only)
              </summary>
              <div class="mt-2">
                <pre class="bg-bg-elevated text-[11px] font-mono p-3 rounded-card border border-border-subtle max-h-64 overflow-y-auto whitespace-pre-wrap leading-relaxed"><span
                  v-for="(c, i) in fullPromptDiff"
                  :key="i"
                  :class="diffChunkClass(c.type)"
                >{{ c.text }}</span></pre>
              </div>
            </details>
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
                class="text-xs"
              >
                <div class="flex items-start gap-2">
                  <span :class="severityIconClass(check.severity)">{{ severityIcon(check.severity) }}</span>
                  <span class="text-text-primary font-medium w-40 shrink-0">{{ checkLabel(check.name) }}</span>
                  <span class="text-text-secondary flex-1 min-w-0">{{ check.message }}</span>
                </div>
                <!-- V4.2 — expand context_consistency issues with the conflicting phrase -->
                <div
                  v-if="check.name === 'context_consistency' && check.issues?.length"
                  class="ml-6 mt-1 mb-2 space-y-1"
                >
                  <div
                    v-for="(issue, j) in check.issues"
                    :key="j"
                    class="text-[11px] border-l-2 border-warn/40 pl-2 py-0.5"
                  >
                    <span class="font-semibold text-warn">{{ kindLabel(issue.kind) }}:</span>
                    <span class="text-text-secondary"> {{ issue.detail }}</span>
                    <div
                      v-if="issue.conflictsWith"
                      class="text-text-muted italic mt-0.5"
                    >
                      ↳ Conflicts with: "<span class="text-text-secondary">{{ truncate(issue.conflictsWith, 120) }}</span>"
                    </div>
                  </div>
                </div>
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
import { diffWords } from 'diff'
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
const userEmail    = ref(localStorage.getItem('copilot.userEmail') || '')
const applying     = ref(false)
const applyError   = ref(null)
const receipt      = ref(null)
// V4.6 — user-chosen section override. null = let the AI choose.
const userChosenSectionId = ref(null)
const reloading    = ref(false)
// V4.7 — section-focused editor as primary surface
//   editedSectionText: just the modified-section text (default editing mode)
//   editedFullText:    fallback when section-focused path can't apply (no sectionAware,
//                      or splice mismatch). Also used when user expands "edit full prompt".
//   editMode:          'section' (focused) | 'full' (whole prompt). Default 'section'
//                      when sectionAware is usable; auto-switches to 'full' otherwise.
const editedSectionText = ref('')
const editedFullText    = ref('')
const editMode          = ref('section')

const { validation, validating, run, setInitial } = useDebouncedValidate(props.recommendation.id)

// Is the section-focused path viable for this preview?
//   - sectionAware metadata exists
//   - no fallback (LLM didn't fall back to blind append)
//   - targetSectionText exists in the original prompt (sanity check for splice)
const sectionEditAvailable = computed(() => {
  const sa = preview.value?.sectionAware
  if (!sa || sa.fallback) return false
  if (!sa.targetSectionText || !sa.modifiedSectionText) return false
  return preview.value.currentText.includes(sa.targetSectionText)
})

// The final full prompt to send to the apply endpoint. In 'section' mode this
// is computed by splicing editedSectionText back into the original prompt; in
// 'full' mode it's the user's whole-prompt edit verbatim.
const proposedFullText = computed(() => {
  if (!preview.value) return ''
  if (editMode.value === 'full' || !sectionEditAvailable.value) return editedFullText.value
  const ct = preview.value.currentText
  const orig = preview.value.sectionAware.targetSectionText
  const idx = ct.indexOf(orig)
  if (idx === -1) return editedFullText.value  // safety: splice failed → fall back
  return ct.slice(0, idx) + editedSectionText.value + ct.slice(idx + orig.length)
})

// Edited = user diverged from the AI's suggestion in whichever mode they're using.
const edited = computed(() => {
  if (!preview.value) return false
  if (editMode.value === 'full') return editedFullText.value !== preview.value.aiSuggestedText
  return editedSectionText.value !== preview.value.sectionAware?.modifiedSectionText
})
const editDelta = computed(() => {
  if (!preview.value) return 0
  if (editMode.value === 'full') return Math.abs(editedFullText.value.length - preview.value.aiSuggestedText.length)
  return Math.abs(editedSectionText.value.length - (preview.value.sectionAware?.modifiedSectionText?.length || 0))
})

// V4.7 — word-level diff helper. Returns [{type, text}] chunks for highlight rendering.
// `added`/`removed` chunks are colored; others are unchanged.
function diffChunks(before, after) {
  if (!before || !after) return [{ type: 'unchanged', text: after || before || '' }]
  return diffWords(before, after).map((part) => ({
    type: part.added ? 'added' : part.removed ? 'removed' : 'unchanged',
    text: part.value,
  }))
}
const sectionDiff = computed(() => {
  const sa = preview.value?.sectionAware
  if (!sa?.targetSectionText || !sa?.modifiedSectionText) return null
  return diffChunks(sa.targetSectionText, sa.modifiedSectionText)
})
const fullPromptDiff = computed(() => {
  if (!preview.value) return null
  return diffChunks(preview.value.currentText, proposedFullText.value)
})
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

async function load(opts = {}) {
  const { silent = false } = opts
  if (silent) reloading.value = true
  else loading.value = true
  loadError.value = null
  isDemoAgentError.value = false
  try {
    const params = userChosenSectionId.value ? { targetSectionId: userChosenSectionId.value } : {}
    const { data } = await client.get(`/recommendations/${props.recommendation.id}/preview-apply`, { params })
    preview.value = data
    // V4.7 init: pre-fill both edit surfaces from the preview, auto-pick mode.
    editedSectionText.value = data.sectionAware?.modifiedSectionText || ''
    editedFullText.value    = data.aiSuggestedText
    editMode.value = (data.sectionAware && !data.sectionAware.fallback &&
                      data.sectionAware.targetSectionText &&
                      data.currentText?.includes(data.sectionAware.targetSectionText))
      ? 'section' : 'full'
    setInitial(data.validation)
  } catch (err) {
    if (err.code === 'DEMO_AGENT') {
      isDemoAgentError.value = true
    } else {
      loadError.value = err.message || 'Failed to load preview'
    }
  } finally {
    loading.value = false
    reloading.value = false
  }
}

// V4.6 — user changed the manual section override. Re-fetch preview with
// the new targetSectionId. Loading is silent so the modal stays open.
async function onSectionOverride() {
  await load({ silent: true })
}

// V4.7 — re-validate whenever the final spliced text changes (either mode).
watch(proposedFullText, (v) => {
  if (preview.value) run(v)
})

function resetToAi() {
  if (!preview.value) return
  editedSectionText.value = preview.value.sectionAware?.modifiedSectionText || ''
  editedFullText.value    = preview.value.aiSuggestedText
  setInitial(preview.value.validation)
}

function toggleEditMode() {
  // When entering 'full' mode, seed editedFullText from the currently-spliced
  // proposedFullText so the user keeps any section-mode edits.
  if (editMode.value === 'section') {
    editedFullText.value = proposedFullText.value
    editMode.value = 'full'
  } else {
    // Going back to section mode discards full-prompt edits outside the
    // target section — warn if there are any.
    const sa = preview.value?.sectionAware
    if (sa?.targetSectionText && preview.value.currentText.includes(sa.targetSectionText)) {
      // Try to re-extract the user's section edits from the full prompt
      // (best-effort: only succeeds if other-section text is unchanged).
      const ct = preview.value.currentText
      const orig = sa.targetSectionText
      const idx = ct.indexOf(orig)
      const fullPrefix = ct.slice(0, idx)
      const fullSuffix = ct.slice(idx + orig.length)
      if (editedFullText.value.startsWith(fullPrefix) && editedFullText.value.endsWith(fullSuffix)) {
        editedSectionText.value = editedFullText.value.slice(fullPrefix.length, editedFullText.value.length - fullSuffix.length)
      }
    }
    editMode.value = 'section'
  }
}

async function onConfirm() {
  applying.value = true
  applyError.value = null
  try {
    const { data } = await client.post(
      `/agents/${props.recommendation.agentId}/recommendations/${props.recommendation.id}/apply`,
      { finalText: proposedFullText.value, userEmail: userEmail.value || null }
    )
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

// V4.7 — color spans by diff chunk type. `added` green, `removed` red strikethrough,
// `unchanged` muted so the eye lands on the change.
function diffChunkClass(type) {
  if (type === 'added')    return 'bg-pass/20 text-pass rounded-sm px-0.5'
  if (type === 'removed')  return 'bg-fail/15 text-fail-text line-through rounded-sm px-0.5'
  return 'text-text-secondary'
}

function severityIcon(sev) { return sev === 'fail' ? '✗' : sev === 'warn' ? '⚠' : '✓' }
function severityIconClass(sev) {
  return sev === 'fail' ? 'text-fail font-bold w-4 shrink-0' :
         sev === 'warn' ? 'text-warn font-bold w-4 shrink-0' :
                          'text-pass font-bold w-4 shrink-0'
}
function checkLabel(name) {
  return ({
    template_vars:        'Variables',
    length:               'Length limit',
    tone:                 'Brand voice',
    forbidden_content:    'Safety check',
    call_length:          'Call-length impact',
    network:              'Connection',
    context_consistency:  'Context consistency',
    section_fit:          'Section fit',
  }[name]) || name
}
// V4.2 — labels for context_consistency issue kinds (mirrors backend _kindLabel)
function kindLabel(kind) {
  return ({
    contradiction:     'Contradiction',
    tone_drift:        'Tone drift',
    scope_creep:       'Scope creep',
    sequencing:        'Sequencing conflict',
    redundancy:        'Redundancy',
    variable_mismatch: 'Template variable mismatch',
  })[kind] || kind
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s }

onMounted(load)
</script>
