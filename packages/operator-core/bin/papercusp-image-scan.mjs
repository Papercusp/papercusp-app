#!/usr/bin/env node
/**
 * papercusp-image-scan — real SBOM + vulnerability + secret scan of a GCP workspace-host
 * candidate image, emitting evidence bound to the exact release identity.
 *
 * Invoked by CommandGcpImageFamilyScanRunner as:
 *     papercusp-image-scan --json-stdin        (payload on stdin)
 *
 * INPUT  { projectId, subnetwork, imageId, buildManifestIdentity, releaseSha256 }
 * OUTPUT { imageId, buildManifestIdentity, releaseSha256, trusted, sbomSha256,
 *          vulnerabilityFindings, secretFindings, evidenceRef }
 *
 * The consuming adapter (scanEvidence, gcp-image-family-adapter.ts) hard-requires
 * trusted===true, vulnerabilityFindings===0 and secretFindings===0, and requires the
 * three identity fields to equal the request exactly. That check is the release gate;
 * this tool's job is to produce an HONEST measurement, never a passing one.
 *
 * WHY AN OFFLINE DISK SCAN, NOT A BOOTED IMAGE: the candidate is attached as a secondary
 * read-only disk to a controlled scanner VM built from a pinned base image. Scanning the
 * filesystem offline (a) does not depend on the candidate being bootable or networked,
 * (b) cannot be influenced by anything the candidate would run at boot, and (c) keeps the
 * scanner's own toolchain outside the artifact under test. Booting the candidate and
 * scanning from inside it would let the subject of the measurement affect the measurement.
 *
 * TRUST RULE: `trusted` is emitted true only when every stage actually produced a parsed
 * result AND the image's own provenance document binds it to the requested manifest and
 * release digest. Any gap throws instead of degrading the verdict.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ResourceLedger,
  describeImage,
  ephemeralSuffix,
  fail,
  gcloudJson,
  main,
  parseImmutableImageId,
  parseJsonObject,
  requireDigest,
  requireText,
  run,
  runOrThrow,
} from './gcp-ephemeral.mjs';
import { assertCleanRoomIapReachable } from './gcp-private-vm-session.mjs';
import { buildImageScannerInstanceCreateArgs } from './gcp-image-scan-args.mjs';

const CONTRACT_VERSION = 'papercusp-gcp-image-family-release-v1';
const SCAN_ZONE = process.env.PAPERCUSP_SCAN_ZONE?.trim() || 'us-central1-a';
const SCANNER_BASE_IMAGE_FAMILY = process.env.PAPERCUSP_SCAN_BASE_FAMILY?.trim() || 'debian-12';
const SCANNER_BASE_IMAGE_PROJECT = process.env.PAPERCUSP_SCAN_BASE_PROJECT?.trim() || 'debian-cloud';
const SCANNER_MACHINE_TYPE = process.env.PAPERCUSP_SCAN_MACHINE_TYPE?.trim() || 'e2-standard-2';
const RESULT_PATH = '/var/log/papercusp-image-scan.json';
const DONE_PATH = '/var/log/papercusp-image-scan.done';

/**
 * Where the papercusp release bundle is installed on the workspace-host image.
 *
 * This is the SUBJECT BOUNDARY for scope attribution: everything under this path is content
 * papercusp authored or vendored, and can therefore fix; everything else on the mounted image
 * is the inherited Ubuntu base (kernel, distro userland, cloud guest agents), which papercusp
 * neither ships nor can patch. D-201 proved the distinction is load-bearing: linux-kernel alone
 * carries 1054 findings at or above high, so a gate measuring the whole mount can never be
 * greened by any change to the release.
 *
 * Matched as a SUBSTRING with both delimiters, rather than as a prefix, deliberately: syft and
 * gitleaks do not agree on how they render a path under a dir: source. gitleaks emits the
 * absolute guest path (/mnt/candidate/sda1/opt/papercusp/...) — confirmed by the secretsByArea
 * projection below, whose split("/") | .[4] yields top-level names like usr — while syft
 * commonly reports a path relative to the scan root (/sda1/opt/papercusp/...). A prefix test
 * would silently match one convention and not the other, and "silently matched nothing" is the
 * exact failure the attribution-coverage proof below exists to catch. The bounding slashes stop
 * it matching a sibling such as /opt/papercusp-old.
 */
const PAPERCUSP_BUNDLE_PATH = '/opt/papercusp';

/**
 * Safety rail on `secretBundledSample`, NOT a sampling rate.
 *
 * The bundled population is bounded by construction: the release gate requires it to reach
 * zero, so a shippable image carries few of these and a green one carries none. The cap only
 * stops a mis-built image — one that baked a whole credential store under the bundle path —
 * from returning a multi-megabyte array. Whether it bound is REPORTED alongside the array
 * (`secretBundledSampleComplete`), because a truncated list that cannot say it was truncated
 * is indistinguishable from a complete one, and reading a capped list as the whole population
 * is exactly how a real finding gets triaged away.
 */
const SECRET_BUNDLED_SAMPLE_CAP = 500;

/**
 * gitleaks, pinned by version AND digest.
 *
 * Unlike syft and grype, gitleaks publishes NO install script — it distributes release
 * tarballs only. The previous code piped `gitleaks/gitleaks/master/scripts/install.sh`,
 * a path that has never existed: it 404s (confirmed against a syft install.sh control,
 * which returns 200). Because that line ended in `|| true`, the 404 was swallowed and the
 * run continued for another eight minutes before dying as `gitleaks-missing` — a symptom
 * eight steps removed from its cause.
 *
 * The digest is verified before the binary is trusted. This tool decides whether the
 * release contains secrets, so an unverified download would let a compromised or truncated
 * artifact silently report zero findings — which the adapter accepts as a passing gate.
 * The digest below equals the published gitleaks_8.30.1_checksums.txt entry.
 */
const GITLEAKS_VERSION = process.env.PAPERCUSP_SCAN_GITLEAKS_VERSION?.trim() || '8.30.1';
const GITLEAKS_SHA256 =
  process.env.PAPERCUSP_SCAN_GITLEAKS_SHA256?.trim() ||
  '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

/**
 * Startup script for the scanner VM. Mounts every filesystem on the attached candidate
 * disk read-only, then runs syft (SBOM), grype (vulnerabilities) and gitleaks (secrets)
 * against the mounted tree, writing one JSON document.
 *
 * It writes DONE_PATH last and always, with a status, so the poller can distinguish
 * "still running" from "finished, and here is what happened" — a scanner that dies
 * silently must not look like a scanner that found nothing.
 */
function startupScript() {
  return `#!/bin/bash
set -uo pipefail
exec >>/var/log/papercusp-scan-setup.log 2>&1
echo "[papercusp] scan starting $(date -Is)"

status="error"
detail="unknown"

finish() {
  echo "{\\"status\\":\\"\${status}\\",\\"detail\\":\\"\${detail}\\"}" > ${DONE_PATH}
  echo "[papercusp] scan finished status=\${status} detail=\${detail} $(date -Is)"
}
trap finish EXIT

export DEBIAN_FRONTEND=noninteractive
apt-get update -y || { detail="apt-update-failed"; exit 1; }
apt-get install -y curl ca-certificates jq >/dev/null || { detail="apt-install-failed"; exit 1; }

# Pinned installers, checked into the release path rather than 'latest'.
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin || { detail="syft-install-failed"; exit 1; }
curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin || { detail="grype-install-failed"; exit 1; }
# gitleaks has no installer script (see GITLEAKS_VERSION above): fetch the pinned release
# tarball and VERIFY it before trusting the binary. Every step reports its OWN failure —
# the previous '|| true' here is exactly why this surfaced as 'gitleaks-missing' instead of
# naming the 404 that caused it.
curl -sSfL -o /tmp/gitleaks.tgz \\
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \\
  || { detail="gitleaks-download-failed"; exit 1; }
echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tgz" | sha256sum -c - >/dev/null 2>&1 \\
  || { detail="gitleaks-digest-mismatch"; exit 1; }
tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks || { detail="gitleaks-extract-failed"; exit 1; }
chmod +x /usr/local/bin/gitleaks || { detail="gitleaks-chmod-failed"; exit 1; }

# Locate the attached candidate disk (device name 'candidate') and mount every
# filesystem it carries, read-only. A candidate with no mountable filesystem is a
# hard failure, not an empty scan.
dev="/dev/disk/by-id/google-candidate"
if [ ! -e "\$dev" ]; then detail="candidate-disk-absent"; exit 1; fi
real=\$(readlink -f "\$dev")
mkdir -p /mnt/candidate
mounted=0
for part in \$(lsblk -nrpo NAME,FSTYPE "\$real" | awk '\$2!="" {print \$1}'); do
  target="/mnt/candidate/\$(basename "\$part")"
  mkdir -p "\$target"
  if mount -o ro,noexec,nosuid,nodev "\$part" "\$target" 2>/dev/null; then
    mounted=\$((mounted+1))
  fi
done
if [ "\$mounted" -eq 0 ]; then detail="no-filesystem-mounted"; exit 1; fi
echo "[papercusp] mounted \$mounted filesystem(s)"

# COVERAGE PROOF — prove we mounted the OPERATING SYSTEM, not merely something.
#
# A count cannot express what the gate depends on, and is unusable as a guard anyway: the
# lsblk filter above admits ANY non-empty FSTYPE, so swap / LVM2_member / crypto_LUKS
# partitions are attempted and legitimately fail to mount. "mounted == attempted" would
# therefore red every honest run. The checkable property is narrower: did the userland we
# claim to have scanned actually get read?
#
# Without this, a root filesystem that fails to mount while any OTHER partition succeeds
# (an EFI vfat partition, say) leaves mounted>=1, so the loop above swallows the failure
# via 2>/dev/null, syft/grype/gitleaks run across a few hundred MB of boot partition
# instead of the 32GB userland, and the run returns a near-zero measurement. A near-zero
# measurement is exactly what the release policy ACCEPTS — so the failure mode is a
# GREEN gate and trusted:true on an image that was never scanned (WI-1092039).
candidate_root=""
for probe in \$(find /mnt/candidate -maxdepth 3 -path '*/etc/*' -name os-release 2>/dev/null); do
  candidate_root="\$probe"
  break
done
if [ -z "\$candidate_root" ]; then detail="candidate-root-not-mounted"; exit 1; fi
echo "[papercusp] candidate root proven at \$candidate_root"

# --select-catalogers +javascript-package-cataloger is LOAD-BEARING, not a tuning knob.
#
# ⚠ Do NOT put backticks in these comments. This whole script is a JS template literal, so a
# backtick terminates it and the file stops parsing. Caught twice now by 'node --check'.
#
# syft picks its cataloger set from the SOURCE TYPE. On a dir: source it enables
# javascript-lock-cataloger (tagged 'directory') but NOT javascript-package-cataloger
# (tagged 'image, installed' — no 'directory'). The lock cataloger's only input is a lock
# file, and the shipped release bundle contains none. So without this flag NEITHER JavaScript
# cataloger produces a package, grype has nothing to match, and the gate reports npm:0 for a
# population it never looked at.
#
# That is not hypothetical: it is what this scanner did until 2026-08-30, measured against the
# real shipped bundle (syft 1.51.1). The bundle carries 276 REAL npm packages (name+version
# both present; a further 15 are sub-path stubs). A default dir: scan cataloged
# binary 5 / go-module 284 / opam 1 = 290, npm 0. Adding this one flag yields 579 — the same
# 290 PLUS npm 289. Note that '--select-catalogers javascript' does NOT work: tag selection is
# intersected with the source-type default set, so it also returns 0. The leading '+' is what
# makes the selection ADDITIVE rather than a replacement, which is what keeps the OS
# catalogers (and therefore the entire distro measurement) intact.
#
# What the blindness was hiding, measured the same day: 26 findings at or above HIGH in our
# OWN dependencies, every one with an upstream fix available — a Critical in form-data 4.0.0,
# 13 High in axios 1.7.7, plus brace-expansion, minimatch, sharp and adm-zip. The gate was
# blocked on 1813 inherited findings it can do nothing about while silently passing over
# these, which are ours to fix by bumping a version.
#
# The comment ~45 lines below has said "~291 npm packages under /opt/papercusp" since
# WI-1088331, while the field it introduces reported npm:0. Nothing reconciled the two.
# Recorded as D-200 / WI-1117135.
syft scan dir:/mnt/candidate --select-catalogers +javascript-package-cataloger \\
  -o syft-json=/tmp/sbom.json >/dev/null 2>&1 || { detail="syft-failed"; exit 1; }

# ECOSYSTEM COVERAGE PROOF — the SBOM must contain the ecosystems the image demonstrably ships.
#
# The mount coverage proof above answers "did we read the userland?". It cannot answer "did the
# CATALOGER read what the userland contains", and those fail identically: both end in a
# confident low number that the release policy ACCEPTS. A cataloger that silently produces no
# packages for a whole ecosystem is the same fail-open shape as the dead gitleaks (whose
# install URL never existed) and the unmounted root — the scan succeeds, every parse check
# passes, and trusted:true is returned for something that was never measured.
#
# So assert the property directly and fail CLOSED: if the mounted image contains node_modules
# package manifests, the SBOM must contain at least one npm package. The find is bounded
# because only existence matters, not the count.
npm_manifests=\$(find /mnt/candidate -path '*/node_modules/*' -name package.json 2>/dev/null | head -1 | wc -l)
npm_cataloged=\$(jq '[.artifacts[]? | select(.type == "npm")] | length' /tmp/sbom.json 2>/dev/null || echo "null")
if [ "\$npm_cataloged" = "null" ]; then detail="sbom-npm-parse-failed"; exit 1; fi
if [ "\$npm_manifests" -gt 0 ] && [ "\$npm_cataloged" -eq 0 ]; then
  detail="sbom-npm-coverage-zero"; exit 1
fi

grype sbom:/tmp/sbom.json -o json > /tmp/vuln.json 2>/dev/null || { detail="grype-failed"; exit 1; }

secret_count=0
if command -v gitleaks >/dev/null 2>&1; then
  # --exit-code 0 makes gitleaks return 0 even WHEN IT FINDS SECRETS, so a non-zero exit here
  # is a genuine tool failure and must fail the scan. The previous '|| true' meant a crashed
  # scanner left no report, secret_count stayed 0, and the adapter's secretFindings===0 gate
  # PASSED — a secret scanner that dies was indistinguishable from a clean image. The
  # vulnerability path above already fails closed on a parse error; secrets did not.
  gitleaks dir /mnt/candidate --report-format json --report-path /tmp/secrets.json --no-banner --exit-code 0 >/dev/null 2>&1 \\
    || { detail="gitleaks-failed"; exit 1; }
  # gitleaks always writes the report, using [] for a clean scan (verified against 8.30.1), so
  # an absent or unparseable report means the measurement did not happen — never "zero secrets".
  if [ ! -f /tmp/secrets.json ]; then detail="gitleaks-no-report"; exit 1; fi
  secret_count=\$(jq 'if type=="array" then length else empty end' /tmp/secrets.json 2>/dev/null)
  if [ -z "\$secret_count" ]; then detail="secret-parse-failed"; exit 1; fi
else
  detail="gitleaks-missing"; exit 1
fi

vuln_count=\$(jq '[.matches[]?] | length' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_count" = "null" ]; then detail="vuln-parse-failed"; exit 1; fi

# A bare total is not actionable: it cannot distinguish 3922 negligible unfixed CVEs in
# the distro base from one Critical with a patch already available. The gate consumes the
# counts; a HUMAN triaging a red consumes these breakdowns. Both fail closed on a parse
# error, for the same reason the counts above do.
vuln_by_severity=\$(jq -c '[.matches[]?.vulnerability.severity] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_by_severity" = "null" ]; then detail="vuln-severity-parse-failed"; exit 1; fi
vuln_fixable=\$(jq '[.matches[]? | select(.vulnerability.fix.state == "fixed")] | length' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_fixable" = "null" ]; then detail="vuln-fix-parse-failed"; exit 1; fi
# Fixable AND severity, crossed. The two breakdowns above cannot be combined after the fact:
# a total of 3829 fixable beside 247 Critical cannot answer "how many of the Critical ones can
# we actually act on", and that is precisely the number that decides whether a red gate means
# "patch the image" or "the threshold is unsatisfiable against this distro". Measured on the
# 0.0.18 candidate, where the answer had to be guessed for want of this field (D-171).
vuln_fixable_by_severity=\$(jq -c '[.matches[]? | select(.vulnerability.fix.state == "fixed") | .vulnerability.severity] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_fixable_by_severity" = "null" ]; then detail="vuln-fix-severity-parse-failed"; exit 1; fi
# WHICH ECOSYSTEM the findings live in — the field that says whether a remediation can even
# reach them. The 0.0.18 candidate carries a whole Ubuntu userland AND ~291 npm packages
# under /opt/papercusp AND python dist-packages, so "apt-get dist-upgrade" is capable of
# patching only one of the three. Without this split, a dist-upgrade that moved the count by
# ~1 finding is indistinguishable from a dist-upgrade that never ran, and the only way to
# tell was to guess (WI-1088331). Grype already labels every match with its package type.
vuln_by_ecosystem=\$(jq -c '[.matches[]?.artifact.type] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_by_ecosystem" = "null" ]; then detail="vuln-ecosystem-parse-failed"; exit 1; fi
vuln_fixable_by_ecosystem=\$(jq -c '[.matches[]? | select(.vulnerability.fix.state == "fixed") | .artifact.type] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_fixable_by_ecosystem" = "null" ]; then detail="vuln-fix-ecosystem-parse-failed"; exit 1; fi
# SEVERITY x ECOSYSTEM, crossed — the field that says whether a red gate is reachable AT ALL.
# The two marginals above carry exactly the defect the fixable/severity pair was added to fix,
# one axis over: 1566 High beside linux-kernel 2389 cannot answer "how many of the DENIED
# findings are kernel", and that is the number separating "remove the vendored Go binaries and
# pass" from "no userland change can ever pass, so the scan must be SCOPED instead". The
# threshold is not the lever — D-172/174/175 forbid moving it — so an unreachable population
# has to be PROVEN, and until this field existed it could only be assumed (WI-1182614).
vuln_by_severity_ecosystem=\$(jq -c '[.matches[]? | (.vulnerability.severity + " @ " + .artifact.type)] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_by_severity_ecosystem" = "null" ]; then detail="vuln-severity-ecosystem-parse-failed"; exit 1; fi
# WHICH ARTIFACTS carry the mass. A Go binary embeds its entire vendored dependency tree, so
# every vulnerable module is reported individually and keeps being reported until the VENDOR
# rebuilds the binary. Note "fixable" means an upstream fixed version EXISTS — never that any
# apt action delivers it — so a fixable count is an upstream-existence census, not a remediation
# plan. Ranked top-N: the distinct-artifact count is unbounded in principle.
vuln_by_artifact=\$(jq -c '[.matches[]? | (.artifact.name + " " + (.artifact.version // "?"))] | group_by(.) | map({name:.[0], count:length}) | sort_by(-.count) | .[0:25] | map({key:.name, value:.count}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_by_artifact" = "null" ]; then detail="vuln-artifact-parse-failed"; exit 1; fi
# The DENOMINATOR for the capped list above, emitted BESIDE it so a top-25 floor can never be
# read as the whole population. A bounded measurement has to declare its boundedness on the
# aggregate itself; a caveat that lives only in a comment is one the reader never sees.
vuln_distinct_artifacts=\$(jq '[.matches[]? | (.artifact.name + " " + (.artifact.version // "?"))] | unique | length' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_distinct_artifacts" = "null" ]; then detail="vuln-artifact-census-parse-failed"; exit 1; fi
# WHICH ARTIFACTS CARRY THE **DENIED** FINDINGS — the field that makes a remediation targetable.
#
# The two fields above cannot answer this between them, and the way they fail is the reason this
# one exists. vuln_by_artifact ranks by TOTAL findings, so it is dominated by the inherited mass:
# on the 0.0.18 candidate its top-25 is kernel and Go stdlib, and the npm packages that are OURS
# to fix sit at 30/6/3/2 findings with part of the population past the cap entirely. Crossing
# severity with ECOSYSTEM proves the denied set is 1054 kernel + 665 go + 26 npm, but "ecosystem
# npm" is not something anyone can go and bump — a VERSION is. So the actionable question, "which
# packages carry the 26 findings we can actually fix", had no instrument, and the package names
# had to be taken from a comment rather than measured (D-202).
#
# Restricted to Critical|High because that is the population the ratified policy DENIES; it is
# not a threshold decision (D-172/174/175 forbid moving one) but a filter matching the bar that
# already exists. The name says what it MEASURES rather than what the policy calls it, so it stays
# true if the bar ever moves and a consumer can recombine it against whatever threshold applies.
#
# Severity is lowercased before comparison and defaulted, so a null severity is EXCLUDED rather
# than crashing the projection — and the cap is paired with its own denominator below, for the
# same reason the ranked list above is: a bounded measurement must declare its bound ON the
# aggregate, never in a comment.
vuln_crit_high_by_artifact=\$(jq -c '[.matches[]? | select((.vulnerability.severity // "" | ascii_downcase) == "critical" or (.vulnerability.severity // "" | ascii_downcase) == "high") | (.artifact.name + " " + (.artifact.version // "?"))] | group_by(.) | map({name:.[0], count:length}) | sort_by(-.count) | .[0:100] | map({key:.name, value:.count}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_crit_high_by_artifact" = "null" ]; then detail="vuln-crit-high-artifact-parse-failed"; exit 1; fi
vuln_crit_high_distinct_artifacts=\$(jq '[.matches[]? | select((.vulnerability.severity // "" | ascii_downcase) == "critical" or (.vulnerability.severity // "" | ascii_downcase) == "high") | (.artifact.name + " " + (.artifact.version // "?"))] | unique | length' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_crit_high_distinct_artifacts" = "null" ]; then detail="vuln-crit-high-artifact-census-parse-failed"; exit 1; fi

# SCOPE — is this finding OURS, or INHERITED? The mechanism D-201 deliberately left open.
#
# Every breakdown above answers "what KIND of finding is this". None answers "can papercusp do
# anything about it", and that is the question a release gate actually needs. The scan runs over
# the whole mounted image because that is what proves it mounted an OS and cataloged what the OS
# contains — but the RELEASE it reports on is only the content under ${PAPERCUSP_BUNDLE_PATH}.
# D-201: linux-kernel alone is 1054 at/above high, so no change to the release can ever green a
# gate that measures the whole mount. D-202: the 26 npm findings under the bundle are ours and
# 100% carry an upstream fix. Two populations, opposite remediations, and until this field they
# were indistinguishable in the result document.
#
# EVIDENCE ONLY — nothing here rejects anything, and the policy still consumes the unscoped
# counts. That is deliberate on two grounds: D-202 section 4 sequences the npm remediation BEFORE
# the gate changes what it accepts, and D-196 set the precedent that a carry half is inert while
# an enforcement half is not, so they do not land in the same wake.
vuln_by_scope=\$(jq -c '[.matches[]? | (if ([.artifact.locations[]?.path // empty] | any(contains("${PAPERCUSP_BUNDLE_PATH}/"))) then "papercusp-bundled" else "inherited-base-image" end)] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_by_scope" = "null" ]; then detail="vuln-scope-parse-failed"; exit 1; fi
# Crossed with the DENIED band, because that is the number any remediation is judged by. The
# marginal above cannot answer "how many of the findings we can act on are actually blocking",
# for exactly the reason severity and fixability could not be combined after the fact (D-171).
vuln_crit_high_by_scope=\$(jq -c '[.matches[]? | select((.vulnerability.severity // "" | ascii_downcase) == "critical" or (.vulnerability.severity // "" | ascii_downcase) == "high") | (if ([.artifact.locations[]?.path // empty] | any(contains("${PAPERCUSP_BUNDLE_PATH}/"))) then "papercusp-bundled" else "inherited-base-image" end)] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/vuln.json 2>/dev/null || echo "null")
if [ "\$vuln_crit_high_by_scope" = "null" ]; then detail="vuln-crit-high-scope-parse-failed"; exit 1; fi

# ATTRIBUTION COVERAGE PROOF — fail CLOSED when the scope matcher matched nothing.
#
# Third instance of one hazard, so it gets the treatment the first two got. The mount proof asks
# "did we read the userland?"; the cataloger proof asks "did syft read what the userland
# contains?"; this asks "did the scope split actually locate the bundle?". All three fail
# identically — a confident low number the release policy ACCEPTS — and this one fails the most
# quietly of the three, because a matcher that matches nothing attributes EVERY finding to the
# inherited base, which reads exactly like a spotless release rather than like a broken
# instrument. Compare the dead gitleaks installer, the unmounted root (WI-1092039) and the
# npm-blind cataloger (WI-1117135 / D-200): the scan succeeded, every parse check passed, and
# the gate was handed a number nobody had measured.
#
# Asserted over CATALOGED PACKAGES, never over findings — this is the part that is easy to get
# backwards. A bundle with zero vulnerabilities is the SUCCESS state this whole effort is driving
# toward (D-202: the 26 npm findings are ours and every one is fixable), so a guard on a zero
# FINDING count would red the gate at precisely the moment the remediation finally worked, and
# would train the next reader to disable it. Cataloged packages cannot legitimately fall to zero
# while the bundle exists: the SBOM carries ~291 npm packages under this path (D-200 measurement).
# Both checks below are UNCONDITIONAL, and that is the whole point. The tempting shape is
#   if bundle_present > 0 AND bundle_cataloged == 0 then fail
# which looks careful and is nearly useless: the find and the SBOM matcher read the SAME constant,
# so a WRONG constant fails both together — bundle_present lands at 0, the guard never fires, and
# every finding is attributed to the inherited base. That is the exact silent zero-attribution
# this proof exists to prevent, reintroduced by the guard meant to catch it. A detector that
# shares its subject's single point of failure cannot detect that failure.
#
# So the absence of the bundle is itself a hard error. This is a papercusp workspace-host image
# by construction: if ${PAPERCUSP_BUNDLE_PATH} is not on it, either the image is mis-built or this
# constant is wrong, and BOTH are answers the release must be told rather than allowed to average
# away. Same judgement the mount step already makes one screen up — "a candidate with no mountable
# filesystem is a hard failure, not an empty scan".
bundle_present=\$(find /mnt/candidate -maxdepth 4 -path "*${PAPERCUSP_BUNDLE_PATH}" -type d 2>/dev/null | head -1 | wc -l)
if [ "\$bundle_present" -eq 0 ]; then detail="bundle-path-not-found"; exit 1; fi
bundle_cataloged=\$(jq '[.artifacts[]? | select([.locations[]?.path // empty] | any(contains("${PAPERCUSP_BUNDLE_PATH}/")))] | length' /tmp/sbom.json 2>/dev/null || echo "null")
if [ "\$bundle_cataloged" = "null" ]; then detail="sbom-scope-parse-failed"; exit 1; fi
if [ "\$bundle_cataloged" -eq 0 ]; then detail="scope-attribution-zero"; exit 1; fi

# Secret DETAIL is rule + file + line ONLY. The matched value is deliberately NEVER
# emitted: this document is read back over SSH and lands in release logs and work-item
# evidence, so echoing the secret would convert a detection into a disclosure. Anyone
# extending this must keep .Match and .Secret out of the projection.
secrets_by_rule=\$(jq -c '[.[]?.RuleID] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_by_rule" = "null" ]; then detail="secret-rule-parse-failed"; exit 1; fi
secrets_sample=\$(jq -c '[.[]? | {rule:.RuleID, file:.File, line:.StartLine}] | .[0:50]' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_sample" = "null" ]; then detail="secret-sample-parse-failed"; exit 1; fi
# A CENSUS, because the sample above is capped at 50 and a real image produces hundreds.
# Triaging the 0.0.18 candidate's 275 findings from a 50-row sample left 225 of them —
# every one of the 50 'private-key' hits included — unclassifiable, so "are any of these a
# real baked-in credential?" could not be answered without a second billable scan. Grouping
# rule x top-level directory classifies EVERY finding while staying bounded: the number of
# distinct (rule, /dir) pairs is small no matter how many findings there are. Still rule and
# location only — no value, same rule as the sample above.
secrets_by_area=\$(jq -c '[.[]? | (.RuleID + " @ /" + ((.File | split("/") | .[4]) // "?"))] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_by_area" = "null" ]; then detail="secret-area-parse-failed"; exit 1; fi
# The same split for the secrets leg, because D-201 established the two legs are ONE defect.
# image-scan-policy already concedes this in code — gitleaks reads the entire mounted userland,
# so its count "says nothing about papercusp-authored content" — but conceding it in a comment
# left no way to tell which findings, if any, ARE ours. This is that field. Location only, no
# value, under the same non-disclosure rule as the sample and area projections above.
secrets_by_scope=\$(jq -c '[.[]? | (if ((.File // "") | contains("${PAPERCUSP_BUNDLE_PATH}/")) then "papercusp-bundled" else "inherited-base-image" end)] | group_by(.) | map({key:.[0], value:length}) | from_entries' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_by_scope" = "null" ]; then detail="secret-scope-parse-failed"; exit 1; fi
# EVERY papercusp-bundled secret finding, enumerated BY FILE — the field that makes the bundled
# population triageable at all.
#
# secretSample above is '.[0:50]' over the UNSCOPED set, in gitleaks' own emission order. On the
# 0.0.18 candidate that carried 2 of the 31 bundled findings; the other 29 could not be resolved
# to a file from any emitted field, so deciding whether they were real credentials needed a
# second billable scan. secretsByArea does not close that gap either: it answers "how many, under
# which top-level directory", and triage needs "which file", because the only way to judge a
# finding is to open the file it is in. (The two that WERE resolvable turned out to be an upstream
# @excalidraw public Firebase client key, vendored under our bundle path — a verdict reachable
# only because the sample happened to name the file.)
#
# Unlike the unscoped sample this does not need to sample, because the bundled set is small by
# construction (see SECRET_BUNDLED_SAMPLE_CAP). Location only, never a matched value — the same
# non-disclosure rule as secretSample, secretsByArea and secretsByScope.
secrets_bundled_sample=\$(jq -c --argjson cap ${SECRET_BUNDLED_SAMPLE_CAP} '[.[]? | select((.File // "") | contains("${PAPERCUSP_BUNDLE_PATH}/")) | {rule:.RuleID, file:.File, line:.StartLine}] | .[0:\$cap]' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_bundled_sample" = "null" ]; then detail="secret-bundled-sample-parse-failed"; exit 1; fi
# Whether the array above holds the WHOLE bundled population or was cut by the cap. Emitted as its
# own boolean rather than left to a length comparison, so a reader never has to reconstruct the
# cap to know what they are holding.
secrets_bundled_complete=\$(jq -c --argjson cap ${SECRET_BUNDLED_SAMPLE_CAP} '([.[]? | select((.File // "") | contains("${PAPERCUSP_BUNDLE_PATH}/"))] | length) <= \$cap' /tmp/secrets.json 2>/dev/null || echo "null")
if [ "\$secrets_bundled_complete" = "null" ]; then detail="secret-bundled-complete-parse-failed"; exit 1; fi

sbom_sha=\$(sha256sum /tmp/sbom.json | cut -d' ' -f1)

jq -n \\
  --arg sbomSha256 "\$sbom_sha" \\
  --arg candidateRootProof "\$candidate_root" \\
  --argjson vulnerabilityFindings "\$vuln_count" \\
  --argjson secretFindings "\$secret_count" \\
  --argjson mountedFilesystems "\$mounted" \\
  --argjson vulnerabilityBySeverity "\$vuln_by_severity" \\
  --argjson vulnerabilityFixable "\$vuln_fixable" \\
  --argjson vulnerabilityFixableBySeverity "\$vuln_fixable_by_severity" \\
  --argjson vulnerabilityByEcosystem "\$vuln_by_ecosystem" \\
  --argjson vulnerabilityFixableByEcosystem "\$vuln_fixable_by_ecosystem" \\
  --argjson vulnerabilityBySeverityAndEcosystem "\$vuln_by_severity_ecosystem" \\
  --argjson vulnerabilityByArtifact "\$vuln_by_artifact" \\
  --argjson vulnerabilityDistinctArtifacts "\$vuln_distinct_artifacts" \\
  --argjson vulnerabilityCriticalHighByArtifact "\$vuln_crit_high_by_artifact" \\
  --argjson vulnerabilityCriticalHighDistinctArtifacts "\$vuln_crit_high_distinct_artifacts" \\
  --argjson vulnerabilityByScope "\$vuln_by_scope" \\
  --argjson vulnerabilityCriticalHighByScope "\$vuln_crit_high_by_scope" \\
  --argjson bundleCatalogedArtifacts "\$bundle_cataloged" \\
  --argjson secretsByArea "\$secrets_by_area" \\
  --argjson secretsByRule "\$secrets_by_rule" \\
  --argjson secretsByScope "\$secrets_by_scope" \\
  --argjson secretSample "\$secrets_sample" \\
  --argjson secretBundledSample "\$secrets_bundled_sample" \\
  --argjson secretBundledSampleComplete "\$secrets_bundled_complete" \\
  '{sbomSha256:\$sbomSha256, candidateRootProof:\$candidateRootProof, vulnerabilityFindings:\$vulnerabilityFindings, secretFindings:\$secretFindings, mountedFilesystems:\$mountedFilesystems, vulnerabilityBySeverity:\$vulnerabilityBySeverity, vulnerabilityFixable:\$vulnerabilityFixable, vulnerabilityFixableBySeverity:\$vulnerabilityFixableBySeverity, vulnerabilityByEcosystem:\$vulnerabilityByEcosystem, vulnerabilityFixableByEcosystem:\$vulnerabilityFixableByEcosystem, vulnerabilityBySeverityAndEcosystem:\$vulnerabilityBySeverityAndEcosystem, vulnerabilityByArtifact:\$vulnerabilityByArtifact, vulnerabilityDistinctArtifacts:\$vulnerabilityDistinctArtifacts, vulnerabilityCriticalHighByArtifact:\$vulnerabilityCriticalHighByArtifact, vulnerabilityCriticalHighDistinctArtifacts:\$vulnerabilityCriticalHighDistinctArtifacts, vulnerabilityByScope:\$vulnerabilityByScope, vulnerabilityCriticalHighByScope:\$vulnerabilityCriticalHighByScope, bundleCatalogedArtifacts:\$bundleCatalogedArtifacts, secretsByArea:\$secretsByArea, secretsByRule:\$secretsByRule, secretsByScope:\$secretsByScope, secretSample:\$secretSample, secretBundledSample:\$secretBundledSample, secretBundledSampleComplete:\$secretBundledSampleComplete}' \\
  > ${RESULT_PATH} || { detail="result-write-failed"; exit 1; }

status="ok"
detail="complete"
exit 0
`;
}

/**
 * Verify the image's own provenance document binds it to the requested release.
 * This is the anti-substitution check: it proves the thing we scanned is the thing the
 * release asked us to scan, not merely an image that happens to exist.
 */
function assertProvenanceBinding(image, expected) {
  const description = typeof image.description === 'string' ? image.description : '';
  if (!description.trim()) {
    fail('candidate image carries no release provenance document in its description');
  }
  const provenance = parseJsonObject(description, 'candidate image provenance');
  if (provenance.contractVersion !== CONTRACT_VERSION) {
    fail(`candidate image provenance contract must be ${CONTRACT_VERSION}`);
  }
  if (provenance.buildManifestIdentity !== expected.buildManifestIdentity) {
    fail('candidate image provenance buildManifestIdentity does not match the scan request');
  }
  if (requireDigest(provenance.releaseSha256, 'provenance.releaseSha256') !== expected.releaseSha256) {
    fail('candidate image provenance releaseSha256 does not match the scan request');
  }
  return provenance;
}

/** Poll the scanner VM over IAP until it writes its done-marker, or the budget expires. */
async function awaitScanCompletion(projectId, instance, zone, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const sshArgs = (command) => [
    'compute',
    'ssh',
    instance,
    `--project=${projectId}`,
    `--zone=${zone}`,
    '--tunnel-through-iap',
    '--quiet',
    '--command',
    command,
  ];

  let lastError = 'not-started';
  while (Date.now() < deadline) {
    const done = await run('gcloud', sshArgs(`cat ${DONE_PATH} 2>/dev/null || true`), {
      timeoutMs: 2 * 60 * 1000,
    }).catch((error) => ({ exitCode: -1, stdout: '', stderr: String(error?.message ?? error) }));

    const marker = done.stdout.trim();
    if (done.exitCode === 0 && marker !== '') {
      const parsed = parseJsonObject(marker, 'scanner done-marker');
      if (parsed.status !== 'ok') {
        fail(`scanner VM finished unsuccessfully: ${String(parsed.detail ?? 'no detail')}`);
      }
      const result = await runOrThrow('gcloud', sshArgs(`cat ${RESULT_PATH}`), { timeoutMs: 2 * 60 * 1000 });
      return parseJsonObject(result.trim(), 'scanner result');
    }
    if (done.exitCode !== 0) lastError = done.stderr.slice(-300);
    await new Promise((r) => setTimeout(r, 20_000));
  }
  fail(`scanner VM did not report completion within ${budgetMs}ms`, { lastError });
}

async function scan(input) {
  const requested = parseImmutableImageId(input.imageId, 'imageId');
  const projectId = requireText(input.projectId, 'projectId');
  const subnetwork = requireText(input.subnetwork, 'subnetwork');
  if (projectId !== requested.projectId) {
    fail('projectId does not match the project embedded in imageId');
  }
  const buildManifestIdentity = requireText(input.buildManifestIdentity, 'buildManifestIdentity');
  const releaseSha256 = requireDigest(input.releaseSha256, 'releaseSha256');

  // 1. The image must exist, be READY, and prove it is the requested release.
  const image = await describeImage(projectId, requested.imageName);
  assertProvenanceBinding(image, { buildManifestIdentity, releaseSha256 });

  const ledger = new ResourceLedger(projectId);
  const suffix = ephemeralSuffix();
  const diskName = `pc-scan-disk-${suffix}`;
  const instanceName = `pc-scan-vm-${suffix}`;
  let residualResourceIds = [];
  let measurement;
  let startupScriptPath;

  try {
    // The scanner reaches the guest only through IAP. Refuse before creating even the
    // temporary disk when the supplied subnet has no matching IAP SSH firewall rule.
    await assertCleanRoomIapReachable(projectId, subnetwork, SCAN_ZONE);

    // 2. Materialise the candidate as a disk we can read offline.
    await runOrThrow('gcloud', [
      'compute',
      'disks',
      'create',
      diskName,
      `--project=${projectId}`,
      `--zone=${SCAN_ZONE}`,
      `--image=${requested.imageName}`,
      `--image-project=${projectId}`,
      '--quiet',
    ]);
    ledger.track('disk', diskName, SCAN_ZONE);

    // 3. Stand up a controlled scanner from a pinned base image, candidate attached RO.
    //    The startup script goes via a temp file: `--metadata-from-file=/dev/stdin` is
    //    not reliable across gcloud versions, and a file keeps the payload inspectable
    //    if a run has to be debugged after the fact.
    startupScriptPath = join(await mkdtemp(join(tmpdir(), 'pc-image-scan-')), 'startup.sh');
    await writeFile(startupScriptPath, startupScript(), { mode: 0o600 });

    await runOrThrow(
      'gcloud',
      buildImageScannerInstanceCreateArgs({
        instanceName,
        projectId,
        zone: SCAN_ZONE,
        machineType: SCANNER_MACHINE_TYPE,
        imageFamily: SCANNER_BASE_IMAGE_FAMILY,
        imageProject: SCANNER_BASE_IMAGE_PROJECT,
        subnetwork,
        diskName,
        startupScriptPath,
      }),
      { timeoutMs: 8 * 60 * 1000 },
    );
    ledger.track('instance', instanceName, SCAN_ZONE);

    // 4. Wait for a real measurement.
    measurement = await awaitScanCompletion(projectId, instanceName, SCAN_ZONE, 25 * 60 * 1000);
  } finally {
    // Teardown runs even when the scan threw: a failed scan must not leak billable VMs.
    residualResourceIds = await ledger.destroyAll();
    if (startupScriptPath) {
      await rm(dirname(startupScriptPath), { recursive: true, force: true }).catch(() => {});
    }
  }

  // 5. Convert the measurement into evidence — refusing anything unparseable.
  const sbomSha256 = requireDigest(measurement.sbomSha256, 'scan.sbomSha256');
  const vulnerabilityFindings = measurement.vulnerabilityFindings;
  const secretFindings = measurement.secretFindings;
  if (!Number.isSafeInteger(vulnerabilityFindings) || vulnerabilityFindings < 0) {
    fail('scanner returned a non-integer vulnerability count');
  }
  if (!Number.isSafeInteger(secretFindings) || secretFindings < 0) {
    fail('scanner returned a non-integer secret count');
  }
  // COVERAGE IS PART OF THE MEASUREMENT, not a footnote. A scan that read the wrong
  // filesystem yields a small, clean-LOOKING result, and small-and-clean is exactly what
  // the release policy accepts — so coverage has to be checked here or not at all.
  // `mountedFilesystems` was emitted by the guest from the beginning and read by nothing
  // (two references tree-wide, both inside the guest's own jq call), which is what made
  // the fail-open reachable. Both fields are REQUIRED rather than optional: a guest too
  // old to emit them must fail closed, never read as covered by default (WI-1092039).
  const mountedFilesystems = measurement.mountedFilesystems;
  if (!Number.isSafeInteger(mountedFilesystems) || mountedFilesystems < 1) {
    fail('scanner did not report how many candidate filesystems it mounted');
  }
  const candidateRootProof = requireText(measurement.candidateRootProof, 'scan.candidateRootProof');
  if (residualResourceIds.length > 0) {
    // Leaked billable resources invalidate the run's hygiene claim; surface, do not hide.
    fail('scanner could not destroy every ephemeral resource', { residualResourceIds });
  }

  const evidenceRef = `gcp-image-scan:${requested.imageName}:${createHash('sha256')
    .update(`${requested.imageId}|${buildManifestIdentity}|${releaseSha256}|${sbomSha256}`)
    .digest('hex')
    .slice(0, 32)}`;

  // Diagnostics travel WITH the counts. Without them a non-zero result is a dead end:
  // the gate says "3922" and the image is gone by the time anyone asks which 3922.
  // These never gate anything — they exist so a red is triageable without a re-scan.
  const isPlainObject = (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const findings = {
    ...(isPlainObject(measurement.vulnerabilityBySeverity)
      ? { vulnerabilityBySeverity: measurement.vulnerabilityBySeverity }
      : {}),
    ...(Number.isSafeInteger(measurement.vulnerabilityFixable)
      ? { vulnerabilityFixable: measurement.vulnerabilityFixable }
      : {}),
    // The guest has computed this since the field was introduced, and until 2026-08-30
    // nothing read it: it was measured, fail-closed validated, serialised over SSH, and
    // dropped HERE, because this projection omitted it. `grep -rn vulnerabilityFixableBySeverity`
    // returned two hits, both inside the guest script itself. That made it exactly the
    // guess the comment above says it exists to prevent — "how many of the Critical ones
    // can we actually act on" had to be guessed on the 0.0.18 candidate a second time,
    // while the answer was being computed and discarded on every run (WI-1088331).
    ...(isPlainObject(measurement.vulnerabilityFixableBySeverity)
      ? { vulnerabilityFixableBySeverity: measurement.vulnerabilityFixableBySeverity }
      : {}),
    // WHICH ECOSYSTEM, i.e. whether a given remediation can even reach these findings.
    // This candidate carries an Ubuntu userland AND ~291 npm packages under /opt/papercusp
    // AND python dist-packages, so apt can patch only one of the three; without the split,
    // a dist-upgrade that moved the count by ~1 is indistinguishable from one that never ran.
    ...(isPlainObject(measurement.vulnerabilityByEcosystem)
      ? { vulnerabilityByEcosystem: measurement.vulnerabilityByEcosystem }
      : {}),
    ...(isPlainObject(measurement.vulnerabilityFixableByEcosystem)
      ? { vulnerabilityFixableByEcosystem: measurement.vulnerabilityFixableByEcosystem }
      : {}),
    // SEVERITY x ECOSYSTEM. The two marginals above are independent, so neither answers the
    // question that actually decides the gate: of the findings at/above the denied severity,
    // how many are linux-kernel and therefore unreachable by ANY userland remediation? If the
    // kernel alone clears the deny threshold, every plan to strip vendored Go binaries is
    // wasted work, and the honest move is to SCOPE the scan rather than chase the count.
    ...(isPlainObject(measurement.vulnerabilityBySeverityAndEcosystem)
      ? {
          vulnerabilityBySeverityAndEcosystem:
            measurement.vulnerabilityBySeverityAndEcosystem,
        }
      : {}),
    // WHICH artifacts carry the mass — a ranked top-25, paired ALWAYS with the distinct-artifact
    // total below. The pair is the point: a capped list read as a whole population is how a
    // floor becomes a confident wrong total, so the denominator ships beside the list, not in
    // a comment the reader never sees.
    ...(isPlainObject(measurement.vulnerabilityByArtifact)
      ? { vulnerabilityByArtifact: measurement.vulnerabilityByArtifact }
      : {}),
    ...(Number.isSafeInteger(measurement.vulnerabilityDistinctArtifacts)
      ? {
          vulnerabilityDistinctArtifacts:
            measurement.vulnerabilityDistinctArtifacts,
        }
      : {}),
    // WHICH artifacts carry the DENIED findings. The ranked list above is ordered by TOTAL, so
    // the inherited mass (kernel, Go stdlib) crowds out the handful of packages that are ours to
    // bump — the 0.0.18 candidate put all 26 of our npm findings below its top-25 cut or into its
    // tail. This pair answers "what do we actually go and fix", and ships with its own denominator
    // for the same reason as the pair above.
    ...(isPlainObject(measurement.vulnerabilityCriticalHighByArtifact)
      ? {
          vulnerabilityCriticalHighByArtifact:
            measurement.vulnerabilityCriticalHighByArtifact,
        }
      : {}),
    ...(Number.isSafeInteger(measurement.vulnerabilityCriticalHighDistinctArtifacts)
      ? {
          vulnerabilityCriticalHighDistinctArtifacts:
            measurement.vulnerabilityCriticalHighDistinctArtifacts,
        }
      : {}),
    // SCOPE — papercusp-bundled versus inherited base image. The split D-201 left open, carried
    // as evidence only: it changes nothing about what this document asserts, it makes the one
    // distinction the gate's consumers cannot otherwise draw. bundleCatalogedArtifacts travels
    // WITH the split on purpose — it is the denominator that says the matcher found the bundle
    // at all, so a reader can tell "no findings are ours" (good) from "the matcher matched
    // nothing" (an instrument fault). The guest already fails closed on the latter; carrying the
    // number means a human reading the document can check the same thing without rerunning it.
    ...(isPlainObject(measurement.vulnerabilityByScope)
      ? { vulnerabilityByScope: measurement.vulnerabilityByScope }
      : {}),
    ...(isPlainObject(measurement.vulnerabilityCriticalHighByScope)
      ? {
          vulnerabilityCriticalHighByScope:
            measurement.vulnerabilityCriticalHighByScope,
        }
      : {}),
    ...(Number.isSafeInteger(measurement.bundleCatalogedArtifacts)
      ? { bundleCatalogedArtifacts: measurement.bundleCatalogedArtifacts }
      : {}),
    ...(isPlainObject(measurement.secretsByRule)
      ? { secretsByRule: measurement.secretsByRule }
      : {}),
    // The secrets leg of the same split. D-201: both legs are ONE defect, so both get the field.
    ...(isPlainObject(measurement.secretsByScope)
      ? { secretsByScope: measurement.secretsByScope }
      : {}),
    // A CENSUS of every secret finding by rule x top-level directory, because secretSample
    // below is capped at 50 and classifies only a fraction of a real image's findings.
    // Bounded by distinct (rule, /dir) pairs, so it stays small however many findings there
    // are. Location only, never a value — same rule as the sample.
    ...(isPlainObject(measurement.secretsByArea)
      ? { secretsByArea: measurement.secretsByArea }
      : {}),
    // rule/file/line only — the scanner never emits the matched value, and neither do we.
    ...(Array.isArray(measurement.secretSample)
      ? { secretSample: measurement.secretSample }
      : {}),
    // Every papercusp-bundled finding by file. secretSample is capped at 50 across the UNSCOPED
    // set, so it resolved only 2 of the 0.0.18 candidate's 31 bundled findings to a file; this
    // is the field that makes the population triageable without a second billable scan.
    ...(Array.isArray(measurement.secretBundledSample)
      ? { secretBundledSample: measurement.secretBundledSample }
      : {}),
    // Carried BESIDE the array so a capped list can never be read as the whole population.
    ...(typeof measurement.secretBundledSampleComplete === 'boolean'
      ? { secretBundledSampleComplete: measurement.secretBundledSampleComplete }
      : {}),
  };

  return {
    imageId: requested.imageId,
    buildManifestIdentity,
    releaseSha256,
    // Every stage produced a parsed result and provenance bound the subject: trusted.
    // The zero-finding requirement is the ADAPTER's gate, deliberately not ours — we
    // report what we measured and let the release fail honestly if it is non-zero.
    trusted: true,
    sbomSha256,
    // What the scan actually covered, carried as evidence rather than discarded.
    mountedFilesystems,
    candidateRootProof,
    vulnerabilityFindings,
    secretFindings,
    ...findings,
    evidenceRef,
  };
}

await main('papercusp-image-scan', scan);
