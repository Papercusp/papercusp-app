/**
 * P5 diagnostic (throwaway): dump the REAL operator system + user
 * prompts that operator:converse would send, so an isolated omp
 * spawn can be tested with faithful inputs. Not part of the suite.
 */
import { writeFileSync } from 'node:fs';
import { buildOperatorPrompt } from '@papercusp/operator-core/lib/agent-tools/operator/converse-prompt';

async function main() {
  const { systemPromptText, userPromptText } = await buildOperatorPrompt(
    {
      messages: [
        {
          role: 'user',
          content:
            'List every harness in this workspace with its slug and feature counts. ' +
            'Use your tools to read the real data — do not guess.',
        },
      ],
      trigger: 'user_message',
      modality: 'text',
    },
    null,
  );
  writeFileSync('/tmp/op-system.md', systemPromptText, 'utf8');
  writeFileSync('/tmp/op-user.md', userPromptText, 'utf8');
  console.log('system bytes:', systemPromptText.length);
  console.log('user bytes:', userPromptText.length);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
