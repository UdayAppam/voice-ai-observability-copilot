// EditSummaryService — one-line LLM summary of what the user changed vs the
// AI suggestion. Used on the post-apply receipt + product-intelligence metrics.
//
// Called only when edited_from_suggestion === true. Skipped (returns null)
// when the user clicked through without editing. Cheap (~$0.001 per call).

const OpenAI = require('openai')
const logger = require('../logger')

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL  = process.env.OPENAI_MODEL || 'gpt-4o-mini'

class EditSummaryService {
  // Returns a short string (≤120 chars) describing what changed, OR null on
  // failure / no edit. Failures are non-blocking — apply still succeeds.
  static async summarise({ aiSuggestedText, finalText }) {
    if (!aiSuggestedText || !finalText || aiSuggestedText === finalText) return null

    try {
      const res = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: 'system', content:
            `You compare two short pieces of text — an AI's suggestion and a human's edit of it — ` +
            `and describe the human's change in ONE sentence under 120 chars. ` +
            `Lead with the verb. Examples: "Added Spanish translation", "Softened the ask and added please", ` +
            `"Removed the sales-style closing". Return only the sentence, no quotes, no preamble.` },
          { role: 'user', content:
            `AI SUGGESTED:\n${aiSuggestedText.slice(0, 2000)}\n\n` +
            `USER FINAL:\n${finalText.slice(0, 2000)}` },
        ],
      })
      const summary = res.choices[0].message.content.trim().slice(0, 120)
      return summary || null
    } catch (err) {
      logger.warn({ err: err.message }, 'edit summary: LLM call failed; receipt will omit edit_summary')
      return null
    }
  }
}

module.exports = EditSummaryService
