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
import { Select } from "@/app/harness/Select";
import { resolveBrowserApiTransport } from "../../lib/hosted-browser-api";
import {
  Field,
  StageHeader,
  StatusBadge,
  useFocusLifecycle,
} from "./stage-primitives";
import { PROVIDERS, type WorkspaceHostActionArgs } from "./workspace-host-actions";
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
  accountId: string;
  region: string;
  subnetId: string;
  imageId: string;
  kmsKeyArn: string;
  instanceProfileArn: string;
  vpcId: string;
  securityGroupIds: string;
  launchTemplateId: string;
  credentialMethod: "default-chain" | "shared-profile" | "assume-role";
  profile: string;
  roleArn: string;
  externalIdRef: string;
}

export const EMPTY_CONNECT_DRAFT: ConnectDraft = {
  label: "",
  credentialRef: "",
  projectId: "",
  serviceAccountEmail: "",
  accountId: "",
  region: "us-east-1",
  subnetId: "",
  imageId: "",
  kmsKeyArn: "",
  instanceProfileArn: "",
  vpcId: "",
  securityGroupIds: "",
  launchTemplateId: "",
  credentialMethod: "default-chain",
  profile: "",
  roleArn: "",
  externalIdRef: "",
};

/** Admission uses the selected provider's fields; secrets are never requested. */
export function connectDraftComplete(draft: ConnectDraft, target: ProviderTarget = "gcp"): boolean {
  if (!draft.label.trim() || !draft.credentialRef.trim()) return false;
  if (target === "gcp") return Boolean(draft.projectId.trim() && draft.serviceAccountEmail.trim());
  if (target !== "aws") return false;
  return /^\d{12}$/.test(draft.accountId.trim()) &&
    [draft.region, draft.subnetId, draft.imageId, draft.kmsKeyArn,
      draft.instanceProfileArn, draft.vpcId, draft.securityGroupIds, draft.launchTemplateId]
      .every((value) => Boolean(value.trim())) &&
    (draft.credentialMethod !== "shared-profile" || Boolean(draft.profile.trim())) &&
    (draft.credentialMethod !== "assume-role" || Boolean(draft.roleArn.trim()));
}

export function connectionActionFromDraft(target: ProviderTarget, draft: ConnectDraft):
  Extract<WorkspaceHostActionArgs, { action: "connect" }> | null {
  if (!connectDraftComplete(draft, target)) return null;
  const common = { action: "connect" as const, label: draft.label.trim(), credentialRef: draft.credentialRef.trim() };
  if (target === "gcp") return { ...common, target, projectId: draft.projectId.trim(), serviceAccountEmail: draft.serviceAccountEmail.trim() };
  if (target !== "aws") return null;
  const credentialSource = draft.credentialMethod === "shared-profile"
    ? { environment: "local" as const, method: "shared-profile" as const, profile: draft.profile.trim() }
    : draft.credentialMethod === "assume-role"
      ? { environment: "local" as const, method: "assume-role" as const, roleArn: draft.roleArn.trim(),
          ...(draft.profile.trim() ? { sourceProfile: draft.profile.trim() } : {}),
          ...(draft.externalIdRef.trim() ? { externalIdRef: draft.externalIdRef.trim() } : {}) }
      : { environment: "local" as const, method: "default-chain" as const };
  return { ...common, target, credentialSource,
    accountId: draft.accountId.trim(), region: draft.region.trim(), subnetId: draft.subnetId.trim(),
    imageId: draft.imageId.trim(), kmsKeyArn: draft.kmsKeyArn.trim(), instanceProfileArn: draft.instanceProfileArn.trim(),
    vpcId: draft.vpcId.trim(), launchTemplateId: draft.launchTemplateId.trim(),
    securityGroupIds: [...new Set(draft.securityGroupIds.split(",").map((id) => id.trim()).filter(Boolean))],
  };
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
  const setupTemplateReady = /^\d{12}$/.test(draft.accountId.trim()) &&
    /^(?!us-gov-|cn-)[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(draft.region.trim());
  const setupTemplateUrl = setupTemplateReady
    ? `/api/workspace-hosts/aws-setup-template?${new URLSearchParams({ accountId: draft.accountId.trim(), region: draft.region.trim() })}`
    : null;

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
      data-tutorial-target="cloud-connection"
      tabIndex={-1}
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
                !connectDraftComplete(draft, activeProvider.target) ||
                !activeProvider.supported ||
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
                placeholder={`production-${activeProvider.target}`}
                aria-label="Connection label"
              />
            </Field>
            <Field
              label="Injected credential reference"
              hint={activeProvider.target === "aws"
                ? "Use a reference to locally injected AWS credentials. Access keys never enter this form."
                : "Use adc://default or gcloud://active-user. Service-account key files are rejected."}
            >
              {(hintId) => (
                <TextInput
                  value={draft.credentialRef}
                  onChange={(event) =>
                    onDraftChange({ credentialRef: event.target.value })
                  }
                  placeholder={activeProvider.target === "aws" ? "resolver://aws/default" : "adc://default"}
                  aria-label="Injected credential reference"
                  aria-describedby={hintId}
                />
              )}
            </Field>
            {activeProvider.target === "gcp" ? <>
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

            <Field label="Runtime service account email" hint="This identity is attached to the host VM; no key material is stored.">
              {(hintId) => <TextInput value={draft.serviceAccountEmail}
                onChange={(event) => onDraftChange({ serviceAccountEmail: event.target.value })}
                placeholder="papercusp-host@papercusp-prod.iam.gserviceaccount.com"
                aria-label="Runtime service account email" aria-describedby={hintId} />}
            </Field>
            </> : activeProvider.target === "aws" ? <>
              {resolveBrowserApiTransport().mode === "local" ? <Field
                label="AWS setup template"
                hint="Enter your account ID and region to download the CloudFormation template. Create the stack in your AWS account, then copy its Outputs into the resource fields below. Use OperatorRoleArn with the Assume an IAM role credential source."
              >
                {setupTemplateUrl ? <Button asChild variant="ghost" aria-label="Download AWS setup template">
                  <a href={setupTemplateUrl} download>Download AWS setup template</a>
                </Button> : <Button variant="ghost" disabled aria-label="Download AWS setup template">Download AWS setup template</Button>}
              </Field> : null}
              <Field label="Credential source" hint="Credentials resolve on this machine using the AWS SDK.">
                {(hintId) => <Select value={draft.credentialMethod} ariaLabel="AWS credential source" describedBy={hintId}
                  options={[
                    { value: "default-chain", label: "Default credential chain" },
                    { value: "shared-profile", label: "Shared AWS profile" },
                    { value: "assume-role", label: "Assume an IAM role" },
                  ]}
                  onChange={(value) => onDraftChange({ credentialMethod: value as ConnectDraft["credentialMethod"] })} />}
              </Field>
              {draft.credentialMethod !== "default-chain" ? <Field label="AWS profile" hint={draft.credentialMethod === "assume-role" ? "Optional source profile; otherwise use the default chain." : "A named profile already configured on this machine."}>
                {(hintId) => <TextInput value={draft.profile} aria-label="AWS profile" aria-describedby={hintId}
                  onChange={(event) => onDraftChange({ profile: event.target.value })} />}
              </Field> : null}
              {draft.credentialMethod === "assume-role" ? <>
                <Field label="IAM role ARN"><TextInput value={draft.roleArn} aria-label="IAM role ARN" onChange={(event) => onDraftChange({ roleArn: event.target.value })} /></Field>
                <Field label="External ID reference" hint="Optional injected reference, never the external ID itself.">
                  {(hintId) => <TextInput value={draft.externalIdRef} aria-label="External ID reference" aria-describedby={hintId} onChange={(event) => onDraftChange({ externalIdRef: event.target.value })} />}
                </Field>
              </> : null}
              {([
                ["accountId", "AWS account ID", "123456789012"],
                ["region", "AWS region", "us-east-1"],
                ["vpcId", "VPC ID", "vpc-0123456789abcdef0"],
                ["subnetId", "Private subnet ID", "subnet-0123456789abcdef0"],
                ["securityGroupIds", "Security group IDs", "sg-0123456789abcdef0"],
                ["launchTemplateId", "Launch template ID", "lt-0123456789abcdef0"],
                ["imageId", "AMI ID", "ami-0123456789abcdef0"],
                ["instanceProfileArn", "Instance profile ARN", "arn:aws:iam::123456789012:instance-profile/papercusp-host"],
                ["kmsKeyArn", "KMS key ARN", "arn:aws:kms:us-east-1:123456789012:key/your-key-id"],
              ] as const).map(([key, label, placeholder]) => <Field key={key} label={label}
                hint={key === "securityGroupIds" ? "Comma-separated groups with no public inbound access." : key === "subnetId" ? "Use a private subnet with outbound access for the host." : undefined}>
                {(hintId) => <TextInput value={draft[key]} aria-label={label} aria-describedby={hintId} placeholder={placeholder}
                  onChange={(event) => onDraftChange({ [key]: event.target.value })} />}
              </Field>)}
            </> : null}
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
                  !activeProvider.supported ||
                  !connectDraftComplete(draft, activeProvider.target) ||
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
