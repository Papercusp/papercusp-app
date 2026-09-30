/**
 * P5 bug-#5 diagnostic — dump the REAL assembled operator system +
 * user prompt so we can grep it for the `papercusp-su` leak.
 * Throwaway. Delete after P5 triage closes.
 */
import { writeFileSync } from 'node:fs';
import { buildOperatorPrompt } from '@papercusp/operator-core/lib/agent-tools/operator/converse-prompt';

async function main() {
  const { systemPromptText, userPromptText } = await buildOperatorPrompt(
    { messages: [], trigger: 'open_canvas', modality: 'text' },
    null,
  );

  writeFileSync('/tmp/op-sys.md', systemPromptText);
  writeFileSync('/tmp/op-user.md', userPromptText);

  console.log('systemPromptText chars:', systemPromptText.length);
  console.log('userPromptText chars:', userPromptText.length);
  console.log('papercusp-su in system:', systemPromptText.includes('papercusp-su'));
  console.log('papercusp-su in user  :', userPromptText.includes('papercusp-su'));
  console.log('WaitForMcpServers in system:', systemPromptText.includes('WaitForMcpServers'));
  console.log('papercusp-su.tools in system:', systemPromptText.includes('papercusp-su.tools'));
}

main().catch((e) => { console.error('DUMP FAILED:', e); process.exit(1); });
