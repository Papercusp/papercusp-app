"use client";

/**
 * 01 Connect — provider admission.
 *
 * Two changes from the pre-redesign page, both about keeping the form and its
 * subject on screen together:
 *
 *  - the three provider CARDS became compact ROWS, so all three providers and
 *    their status fit above the fold instead of filling it;
 *  - the connect MODAL became an inline PANEL beside the rows, so you can read
 *    the provider you are admitting while you fill in its credential reference.
 *
 * The GCP admission contract is unchanged: label, credentialRef, projectId and
 * serviceAccountEmail are all required, and the `connect` /
 * `validate-connection` argument shapes are exactly what they were.
 */

import { useRef } from "react";
import { Cloud, Plus, ShieldCheck, X } from "lucide-react";
import { Button } from "@/app/harness/Button";
import { TextInput } from "@/app/harness/TextInput";
import {
  Field,
  StageHeader,
  StatusBadge,
  useFocusLifecycle,
} from "./stage-primitives";
import { PROVIDERS } from "./workspace-host-actions";
import {
  formatTimestamp,
  type ProviderTarget,
  type WorkspaceHostConnectionRow,
} from "./workspace-view-model";
import styles from "./cloud-workspaces.module.css";

export interface ConnectDraft {
  label: string;
  credentialRef: string;
  projectId: string;
  serviceAccountEmail: string;
}

export const EMPTY_CONNECT_DRAFT: ConnectDraft = {
  label: "",
  credentialRef: "",
  projectId: "",
  serviceAccountEmail: "",
};

/** Every field of the GCP admission contract must be non-blank. */
export function connectDraftComplete(draft: ConnectDraft): boolean {
  return Boolean(
    draft.label.trim() &&
      draft.credentialRef.trim() &&
      draft.projectId.trim() &&
      draft.serviceAccountEmail.trim(),
  );
}

export function ConnectStage({
  connections,
  selectedConnectionId,
  busyKeys,
  connectTarget,
  draft,
  onDraftChange,
  onSelectTarget,
  onConnect,
  onValidate,
}: {
  connections: readonly WorkspaceHostConnectionRow[];
  selectedConnectionId: string | null;
  busyKeys: ReadonlySet<string>;
  connectTarget: ProviderTarget | null;
  draft: ConnectDraft;
  onDraftChange: (patch: Partial<ConnectDraft>) => void;
  onSelectTarget: (target: ProviderTarget | null) => void;
  onConnect: (target: ProviderTarget) => void;
  onValidate: (connectionId: string, providerLabel: string) => void;
}) {
  const activeProvider =
    PROVIDERS.find((provider) => provider.target === connectTarget) ?? null;

  /*
   * The panel is a DISCLOSURE, so it owes the disclosure focus contract; it is
   * conditionally rendered, which is exactly what makes the close direction a
   * real bug rather than a nicety.
   *
   * Closing unmounts the whole <form> — including the Cancel/Close button that
   * currently holds focus. The browser's fallback for a removed active element
   * is <body>, so without this a keyboard user is silently dropped to the start
   * of the document and a screen-reader user loses their place (WCAG 2.4.3).
   * Restoring focus to the provider row that opened the panel is what puts them
   * back where they were.
   *
   * The open direction is the same contract from the other side: the form
   * renders elsewhere in the DOM, so without a focus move the user would have
   * to tab forward through the remaining provider rows to reach the form they
   * just asked for.
   */
  const triggerRefs = useRef(
    new Map<ProviderTarget, HTMLButtonElement | null>(),
  );
  const panelRef = useRef<HTMLFormElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useFocusLifecycle({
    open: Boolean(activeProvider),
    onOpenFocus: () => panelRef.current?.querySelector<HTMLElement>("input"),
    onCloseFocus: () => returnFocusRef.current,
  });

  return (
    <section
      className={styles.stage}
      aria-labelledby="connect-stage-heading"
      data-stage="connect"
    >
      <StageHeader
        id="connect-stage-heading"
        step="01"
        eyebrow="Connect"
        title="Provider readiness"
        description="Credential references stay outside the repository; this surface stores only their injected reference."
      />

      <div className={styles.connectLayout} data-panel-open={activeProvider ? "true" : "false"}>
        <ul className={styles.providerRows} aria-label="Provider connections">
          {PROVIDERS.map((provider) => {
            const connection =
              connections.find(
                (row) => row.id === selectedConnectionId && row.target === provider.target,
              ) ?? connections.find((row) => row.target === provider.target);
            const selected = connectTarget === provider.target;
            return (
              <li key={provider.target}>
                <article
                  className={styles.providerRow}
                  data-ready={connection?.status === "connected" ? "true" : "false"}
                  data-selected={selected ? "true" : "false"}
                  data-supported={provider.supported ? "true" : "false"}
                >
                  <span className={styles.providerIcon} aria-hidden="true">
                    <Cloud size={15} />
                  </span>
                  <div className={styles.providerIdentity}>
                    <p className={styles.providerName}>
                      {provider.label}
                      <span className={styles.providerMark}>
                        {provider.accent}
                      </span>
                    </p>
                    {connection ? (
                      <p className={styles.providerFacts}>
                        <span>{connection.label}</span>
                        <code>{connection.credentialRef}</code>
                        <span>
                          validated {formatTimestamp(connection.lastValidatedAt)}
                        </span>
                      </p>
                    ) : (
                      <p className={styles.providerFacts}>
                        {provider.supported
                          ? `${provider.scope} discovery, capacity, images, networks, and price estimates.`
                          : "Connection admission is not available in this local build yet."}
                      </p>
                    )}
                  </div>

                  <div className={styles.providerStatus}>
                    {connection ? (
                      <StatusBadge state={connection.status} />
                    ) : (
                      <span
                        className={`${styles.badge} ${provider.supported ? styles.neutral : styles.planned}`}
                      >
                        {provider.supported ? "not connected" : "planned"}
                      </span>
                    )}
                  </div>

                  <div className={styles.providerActions}>
                    {connection ? (
                      <Button
                        variant="ghost"
                        aria-label={`Validate ${provider.label} connection`}
                        disabled={
                          !provider.supported ||
                          busyKeys.has(`validate:${connection.id}`)
                        }
                        onClick={() =>
                          onValidate(connection.id, provider.label)
                        }
                      >
                        <ShieldCheck size={14} aria-hidden="true" /> Validate
                      </Button>
                    ) : (
                      <Button
                        /* The close-direction focus restore target. */
                        ref={(node) => {
                          triggerRefs.current.set(provider.target, node);
                        }}
                        variant={provider.supported ? "primary" : "ghost"}
                        aria-label={
                          provider.supported
                            ? `Connect ${provider.label}`
                            : `${provider.label} connection is not available`
                        }
                        disabled={!provider.supported}
                        onClick={(event) => {
                          returnFocusRef.current = event.currentTarget;
                          onSelectTarget(provider.target);
                        }}
                      >
                        <Plus size={14} aria-hidden="true" />{" "}
                        {provider.supported ? "Connect" : "Not yet available"}
                      </Button>
                    )}
                  </div>
                </article>
              </li>
            );
          })}
        </ul>

        {activeProvider ? (
          <form
            ref={panelRef}
            className={styles.connectPanel}
            aria-labelledby="connect-panel-heading"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !connectDraftComplete(draft) ||
                activeProvider.target !== "gcp" ||
                busyKeys.has("connect")
              )
                return;
              onConnect(activeProvider.target);
            }}
          >
            <div className={styles.connectPanelHeader}>
              <div>
                <h3 id="connect-panel-heading">
                  Connect {activeProvider.label}
                </h3>
                <p>
                  Store a reference to an injected credential, then validate
                  provider discovery. Raw secrets never enter this form.
                </p>
              </div>
              <Button
                variant="ghost"
                type="button"
                aria-label="Close connection panel"
                onClick={() => onSelectTarget(null)}
              >
                <X size={14} aria-hidden="true" />
              </Button>
            </div>

            <Field label="Connection label">
              <TextInput
                value={draft.label}
                onChange={(event) =>
                  onDraftChange({ label: event.target.value })
                }
                placeholder="production-gcp"
                aria-label="Connection label"
              />
            </Field>
            <Field
              label="Injected credential reference"
              hint="Use adc://default or gcloud://active-user. Service-account key files are rejected."
            >
              {(hintId) => (
                <TextInput
                  value={draft.credentialRef}
                  onChange={(event) =>
                    onDraftChange({ credentialRef: event.target.value })
                  }
                  placeholder="adc://default"
                  aria-label="Injected credential reference"
                  aria-describedby={hintId}
                />
              )}
            </Field>
            <Field
              label="Google Cloud project ID"
              hint="The project must be active and visible to the selected credential."
            >
              {(hintId) => (
                <TextInput
                  value={draft.projectId}
                  onChange={(event) =>
                    onDraftChange({ projectId: event.target.value })
                  }
                  placeholder="papercusp-prod"
                  aria-label="Google Cloud project ID"
                  aria-describedby={hintId}
                />
              )}
            </Field>
            <Field
              label="Runtime service account email"
              hint="This identity is attached to the host VM; no key material is stored."
            >
              {(hintId) => (
                <TextInput
                  value={draft.serviceAccountEmail}
                  onChange={(event) =>
                    onDraftChange({ serviceAccountEmail: event.target.value })
                  }
                  placeholder="papercusp-host@papercusp-prod.iam.gserviceaccount.com"
                  aria-label="Runtime service account email"
                  aria-describedby={hintId}
                />
              )}
            </Field>

            <div className={styles.connectPanelActions}>
              <Button
                variant="ghost"
                type="button"
                onClick={() => onSelectTarget(null)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={
                  activeProvider.target !== "gcp" ||
                  !connectDraftComplete(draft) ||
                  busyKeys.has("connect")
                }
              >
                <ShieldCheck size={14} aria-hidden="true" /> Connect and
                validate
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </section>
  );
}
