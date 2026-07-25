/**
 * askUserQuestionTool — port from vercel-labs/open-agents.
 *
 * Client-side tool: NO execute function. The host UI receives the
 * tool call, renders question UI, sends the user's answer back as
 * the tool result. `toModelOutput` formats the answer for the LLM.
 */

import { z } from 'zod';

const optionSchema = z.object({
  label: z.string().describe('1-5 words, concise choice text.'),
  description: z.string().describe('Explanation of trade-offs/implications.'),
});

const questionSchema = z.object({
  question: z.string().describe("The complete question to ask, ends with '?'."),
  header: z.string().max(12).describe('Short label for tab/chip display.'),
  options: z.array(optionSchema).min(2).max(4),
  multiSelect: z.boolean().default(false),
});

const askInputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4),
});

const answerValueSchema = z.string().or(z.array(z.string()));
const askOutputSchema = z
  .object({
    answers: z.record(z.string(), answerValueSchema),
  })
  .or(z.object({ declined: z.literal(true) }));

type AskOutput = z.infer<typeof askOutputSchema>;

export function askUserQuestionTool() {
  return {
    description: `Ask the user questions during execution to gather preferences, clarify requirements, or get decisions.

WHEN TO USE:
- Gather user preferences or requirements
- Clarify ambiguous instructions
- Get decisions on implementation choices
- Offer choices about direction to take

USAGE NOTES:
- Users can always select "Other" to provide custom text input
- Use multiSelect: true to allow multiple answers
- If you recommend a specific option, make it the first option and add "(Recommended)"
- Questions appear as tabs; users navigate between them before submitting`,
    inputSchema: askInputSchema,
    outputSchema: askOutputSchema,
    // NO execute — host UI handles this
    toModelOutput: ({ output }: { output: AskOutput | undefined }) => {
      if (!output) {
        return { type: 'text', value: 'User did not respond to questions.' };
      }
      if ('declined' in output && output.declined) {
        return {
          type: 'text',
          value:
            'User declined to answer questions. You should continue without this information or ask in a different way.',
        };
      }
      if ('answers' in output) {
        const formatted = Object.entries(output.answers)
          .map(([q, a]) => {
            const v = Array.isArray(a) ? a.join(', ') : a;
            return `"${q}"="${v}"`;
          })
          .join(', ');
        return {
          type: 'text',
          value: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
        };
      }
      return { type: 'text', value: 'User responded to questions.' };
    },
  };
}
