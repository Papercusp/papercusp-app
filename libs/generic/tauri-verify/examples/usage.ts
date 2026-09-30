import { createVerifier } from '@papercusp/tauri-verify';

export async function verifyLearningScreen(tauriPID: number, harnessSlug: string) {
  const verify = createVerifier({ tauriPID });

  const ready = await verify.appReady();
  if (!ready.ok) throw new Error(`${ready.code ?? 'verification_failed'}: ${ready.error}`);

  const scope = await verify.scope({ harnessSlug });
  if (!scope.ok) throw new Error(`${scope.code ?? 'scope_failed'}: ${scope.error}`);

  const learning = await verify.navigateToScreen('learning');
  if (!learning.ok) throw new Error(`${learning.code ?? 'screen_failed'}: ${learning.error}`);

  return { ready: ready.value, scope: scope.value, screen: learning.value };
}
