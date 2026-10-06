#!/usr/bin/env node
/**
 * papercusp-aws-ami-scan — real SBOM + vulnerability + secret scan of an AWS workspace-host
 * candidate AMI, emitting evidence bound to the exact release identity (WI-10005587).
 *
 * Invoked by SdkAwsAmiReleaseAdapter.scanImage (aws-ami-production.ts) with NO arguments and
 * the payload on stdin (`--json-stdin` is accepted for parity with the GCP tools):
 *
 * INPUT  { region, imageId, buildManifestIdentity, releaseSha256 }
 * OUTPUT AwsAmiScanEvidence (aws-ami-release.ts) plus evidence-only extras
 *        (per-severity/ecosystem/scope breakdowns, guestPackages, snapshotId, tool versions).
 *
 * Credentials and region arrive in the environment (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
 * AWS_SESSION_TOKEN / AWS_REGION), exactly as the adapter's childEnv provides them.
 *
 * METHOD — OFFLINE SNAPSHOT SCAN, the same principle as the GCP scanner without a scanner VM:
 *   1. DescribeImages; bind Description + tags to the requested release BEFORE any download.
 *   2. `coldsnap download` the AMI's single root snapshot through the EBS direct APIs. The
 *      bytes scanned are the candidate's own snapshot, decrypted with the publisher's KMS
 *      grant — not the local bake file, which could differ from what was registered.
 *   3. Attach the file as a READ-ONLY loop device, mount every filesystem read-only
 *      (noexec,nosuid,nodev; xfs norecovery, ext4 noload so nothing replays a journal).
 *   4. Prove the OS root was mounted (os-release inside an ostree deployment or a partition
 *      root), then syft over that root, grype over the SBOM, gitleaks over every mount.
 *   5. Unmount, detach and delete — teardown failure is a hard error, never residue left on
 *      the release host.
 * Nothing on the candidate ever executes, so it cannot influence its own measurement, and
 * no EC2 instance, subnet or instance profile is needed in the publisher account.
 *
 * Host requirements: Linux with `sudo -n` for losetup/mount/blkid/find/syft/gitleaks, plus
 * coldsnap, syft, grype and gitleaks on PATH (each overridable, see TOOL_ENV below).
 */
import { mkdir, mkdtemp, readFile, rm, statfs, writeFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { DescribeImagesCommand, EC2Client } from '@aws-sdk/client-ec2';

import {
  AWS_AMI_SCAN_TOOL,
  assertAwsAmiProvenance,
  buildAwsAmiScanEvidence,
  measureAwsAmiScan,
  parseAwsAmiScanInput,
  selectCandidateRoot,
} from './aws-ami-scan-measure.mjs';
import { ToolError, emit, fail, parseJsonObject, readStdin, run, runOrThrow } from './gcp-ephemeral.mjs';

const TOOL_ENV = {
  coldsnap: 'PAPERCUSP_AWS_AMI_SCAN_COLDSNAP',
  syft: 'PAPERCUSP_AWS_AMI_SCAN_SYFT',
  grype: 'PAPERCUSP_AWS_AMI_SCAN_GRYPE',
  gitleaks: 'PAPERCUSP_AWS_AMI_SCAN_GITLEAKS',
};
const WORK_ROOT = process.env.PAPERCUSP_AWS_AMI_SCAN_WORKDIR?.trim() || tmpdir();
const EVIDENCE_ROOT =
  process.env.PAPERCUSP_AWS_AMI_SCAN_EVIDENCE_DIR?.trim() || join(homedir(), '.papercusp', 'evidence', 'aws-ami-scan');
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;
const SCAN_TIMEOUT_MS = 45 * 60 * 1000;
const GIB = 1024 ** 3;
/** Filesystems that hold no scannable userland; attempted mounts of these are not failures. */
const NON_MOUNTABLE = new Set(['swap', 'LVM2_member', 'crypto_LUKS', 'linux_raid_member']);
/**
 * gitleaks config: the default rules, minus the ostree object store. Every object a bootc
 * deployment uses is hard-linked into the deployment tree, which IS scanned, so scanning the
 * store as well only re-reports the same bytes under hashed names.
 */
const GITLEAKS_CONFIG = `[extend]\nuseDefault = true\n\n[allowlist]\ndescription = "ostree object store duplicates the scanned deployment"\npaths = ['''/ostree/repo/objects/''']\n`;

async function resolveTool(role) {
  const wanted = process.env[TOOL_ENV[role]]?.trim() || role;
  const candidates = wanted.includes('/')
    ? [wanted]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, wanted));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  fail(`${role} executable '${wanted}' is not on PATH (override with ${TOOL_ENV[role]})`);
}

async function toolVersion(path, args) {
  const result = await run(path, args, { timeoutMs: 60_000 }).catch(() => null);
  const line = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.split('\n').map((text) => text.trim()).find(Boolean);
  return line ?? 'unknown';
}

function sudo(args, options = {}) {
  return runOrThrow('sudo', ['-n', ...args], { timeoutMs: 5 * 60 * 1000, ...options });
}

function mountOptions(fstype) {
  const base = 'ro,noexec,nosuid,nodev';
  if (fstype === 'xfs') return `${base},norecovery,nouuid`;
  if (fstype === 'ext4' || fstype === 'ext3') return `${base},noload`;
  return base;
}

function flattenDevices(nodes, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node && typeof node.name === 'string') out.push(node.name);
    flattenDevices(node?.children, out);
  }
  return out;
}

async function scan(rawInput) {
  const request = parseAwsAmiScanInput(rawInput);
  const tools = {
    coldsnap: await resolveTool('coldsnap'),
    syft: await resolveTool('syft'),
    grype: await resolveTool('grype'),
    gitleaks: await resolveTool('gitleaks'),
  };

  // 1. Provenance first: nothing is downloaded for an AMI that is not the requested release.
  const ec2 = new EC2Client({ region: request.region });
  const described = await ec2.send(new DescribeImagesCommand({ ImageIds: [request.imageId] }));
  const image = described.Images?.[0];
  const provenance = assertAwsAmiProvenance(image, request);
  const volumeGiB = Number(image.BlockDeviceMappings.find((m) => m.Ebs?.SnapshotId === provenance.snapshotId)?.Ebs?.VolumeSize ?? 0);

  await mkdir(WORK_ROOT, { recursive: true });
  const space = await statfs(WORK_ROOT);
  const freeBytes = Number(space.bavail) * Number(space.bsize);
  if (volumeGiB > 0 && freeBytes < (volumeGiB + 2) * GIB) {
    fail(`${WORK_ROOT} has ${(freeBytes / GIB).toFixed(1)} GiB free; the ${volumeGiB} GiB snapshot needs more (set PAPERCUSP_AWS_AMI_SCAN_WORKDIR)`);
  }

  const work = await mkdtemp(join(WORK_ROOT, 'pc-ami-scan-'));
  const mountRoot = join(work, 'candidate');
  const disk = join(work, 'disk.raw');
  const mounted = [];
  let loop = null;
  let outcome;
  let scanError;
  try {
    // 2. The candidate's own bytes, through the EBS direct APIs.
    await runOrThrow(tools.coldsnap, ['download', provenance.snapshotId, disk], { timeoutMs: DOWNLOAD_TIMEOUT_MS });

    // 3. Read-only loop device and read-only mounts.
    loop = (await sudo(['losetup', '--find', '--show', '--read-only', '--partscan', disk])).trim();
    if (!/^\/dev\/loop\d+$/.test(loop)) fail(`losetup returned an unexpected device '${loop}'`);
    await run('sudo', ['-n', 'udevadm', 'settle', '--timeout=30'], { timeoutMs: 60_000 }).catch(() => null);
    const tree = parseJsonObject(await runOrThrow('lsblk', ['-J', '-p', '-o', 'NAME', loop]), 'lsblk');
    await mkdir(mountRoot, { recursive: true });
    for (const device of flattenDevices(tree.blockdevices)) {
      const probe = await run('sudo', ['-n', 'blkid', '-p', '-o', 'value', '-s', 'TYPE', device], { timeoutMs: 60_000 });
      const fstype = probe.exitCode === 0 ? probe.stdout.trim() : '';
      if (!fstype || NON_MOUNTABLE.has(fstype)) continue;
      const target = join(mountRoot, device.split('/').pop());
      await mkdir(target, { recursive: true });
      const result = await run('sudo', ['-n', 'mount', '-t', fstype, '-o', mountOptions(fstype), device, target], { timeoutMs: 120_000 });
      if (result.exitCode === 0) mounted.push(target);
    }
    if (mounted.length === 0) fail('no-filesystem-mounted: the candidate snapshot carries no mountable filesystem');

    // 4a. Coverage proof: the operating system itself was mounted, not merely a boot partition.
    const found = await sudo(
      ['find', mountRoot, '-maxdepth', '9', '-path', '*/ostree/repo', '-prune', '-o',
        '(', '-path', '*/etc/os-release', '-o', '-path', '*/usr/lib/os-release', ')', '-print'],
      { timeoutMs: 10 * 60 * 1000 },
    );
    const root = selectCandidateRoot(found.split('\n').map((line) => line.trim()).filter(Boolean), mountRoot);
    if (!root) fail('candidate-root-not-mounted: no os-release under a partition root or ostree deployment');
    const npmProbe = await sudo(['find', root.osRoot, '-path', '*/node_modules/*', '-name', 'package.json', '-print', '-quit'], {
      timeoutMs: 10 * 60 * 1000,
    });

    // 4b. The three measurements. syft and gitleaks need root to read every file on the image;
    // grype only reads the SBOM, so it runs as the caller with the caller's vulnerability DB.
    const sbomPath = join(work, 'sbom.json');
    const vulnPath = join(work, 'vuln.json');
    const secretsPath = join(work, 'secrets.json');
    const gitleaksConfig = join(work, 'gitleaks.toml');
    await writeFile(gitleaksConfig, GITLEAKS_CONFIG, 'utf8');
    await sudo(
      [tools.syft, 'scan', `dir:${root.osRoot}`, '--select-catalogers', '+javascript-package-cataloger', '-q', '-o', `syft-json=${sbomPath}`],
      { timeoutMs: SCAN_TIMEOUT_MS },
    );
    await sudo(['chown', String(process.getuid()), sbomPath]);
    const vuln = await runOrThrow(tools.grype, [`sbom:${sbomPath}`, '-q', '-o', 'json'], { timeoutMs: SCAN_TIMEOUT_MS });
    await writeFile(vulnPath, vuln, 'utf8');
    await sudo(
      [tools.gitleaks, 'dir', mountRoot, '--config', gitleaksConfig, '--report-format', 'json', '--report-path', secretsPath,
        '--no-banner', '--exit-code', '0'],
      { timeoutMs: SCAN_TIMEOUT_MS },
    );
    await sudo(['chown', String(process.getuid()), secretsPath]);

    const sbomText = await readFile(sbomPath, 'utf8');
    const measurement = measureAwsAmiScan({
      sbomText,
      vulnText: vuln,
      secretsText: await readFile(secretsPath, 'utf8'),
      mountedFilesystems: mounted.length,
      candidateRootProof: root.proof,
      npmManifestsPresent: npmProbe.trim().length > 0,
    });
    const versions = {
      coldsnap: await toolVersion(tools.coldsnap, ['--version']),
      syft: await toolVersion(tools.syft, ['version']),
      grype: await toolVersion(tools.grype, ['version']),
      gitleaks: await toolVersion(tools.gitleaks, ['version']),
    };
    outcome = buildAwsAmiScanEvidence(request, provenance, measurement, versions);

    // Durable evidence: the SBOM and the grype report, never the raw secret matches (which hold
    // the secret itself). The redacted sample is already inside the emitted evidence.
    const evidenceDir = join(EVIDENCE_ROOT, `${request.imageId}-${Date.now()}`);
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    await writeFile(join(evidenceDir, 'sbom.syft.json'), sbomText, { mode: 0o600 });
    await writeFile(join(evidenceDir, 'grype.json'), vuln, { mode: 0o600 });
    await writeFile(join(evidenceDir, 'evidence.json'), `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 });
    outcome = { ...outcome, evidenceDir };
  } catch (error) {
    scanError = error;
  }

  // 5. Teardown is part of the result: a scan that leaves the candidate mounted is not done.
  const residue = [];
  for (const target of [...mounted].reverse()) {
    const result = await run('sudo', ['-n', 'umount', target], { timeoutMs: 120_000 }).catch(() => ({ exitCode: -1 }));
    if (result.exitCode !== 0) residue.push(`mount:${target}`);
  }
  if (loop) {
    const result = await run('sudo', ['-n', 'losetup', '-d', loop], { timeoutMs: 60_000 }).catch(() => ({ exitCode: -1 }));
    if (result.exitCode !== 0) residue.push(`loop:${loop}`);
  }
  if (residue.length === 0) await rm(work, { recursive: true, force: true }).catch(() => residue.push(`dir:${work}`));
  else residue.push(`dir:${work}`);

  if (scanError) {
    if (residue.length > 0 && scanError instanceof ToolError) {
      scanError.details = { ...(scanError.details ?? {}), localResidue: residue };
    }
    throw scanError;
  }
  if (residue.length > 0) fail('scan finished but local teardown left residue', { localResidue: residue });
  return outcome;
}

try {
  const input = parseJsonObject(await readStdin(), AWS_AMI_SCAN_TOOL);
  emit(await scan(input));
  process.exit(0);
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      tool: AWS_AMI_SCAN_TOOL,
      error: error instanceof Error ? error.message : String(error),
      ...(error && error.details ? { details: error.details } : {}),
    })}\n`,
  );
  process.exit(1);
}
