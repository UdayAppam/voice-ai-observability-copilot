// useDebouncedValidate — wraps POST /api/recommendations/:recId/validate with
// 300ms debounce so the modal doesn't fire on every keystroke.
//
// Usage in a Vue component:
//   const { validation, validating, run } = useDebouncedValidate(recId)
//   watch(proposedText, (t) => run(t))

import { ref } from 'vue'
import client from '@/api/client'

const DEBOUNCE_MS = 300

export function useDebouncedValidate(recId) {
  const validation = ref(null)
  const validating = ref(false)
  let timer = null
  let seq = 0

  // Cancel any pending call + schedule a new one. The seq counter ensures
  // we ignore stale responses if multiple requests are in flight.
  function run(proposedText) {
    if (timer) clearTimeout(timer)
    validating.value = true
    const mySeq = ++seq
    timer = setTimeout(async () => {
      try {
        const { data } = await client.post(
          `/recommendations/${recId}/validate`,
          { proposedText }
        )
        if (mySeq === seq) validation.value = data
      } catch (err) {
        if (mySeq === seq) {
          validation.value = {
            blocking: false,
            checks: [{ name: 'network', severity: 'warn', message: 'Validation unavailable: ' + (err.message || 'unknown error') }],
          }
        }
      } finally {
        if (mySeq === seq) validating.value = false
      }
    }, DEBOUNCE_MS)
  }

  // Set the initial validation result without making a network call
  // (used to seed from /preview-apply's response)
  function setInitial(v) { validation.value = v }

  return { validation, validating, run, setInitial }
}
