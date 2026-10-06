#!/usr/bin/env bash
# vm-boot-extra-drives.selftest.sh — argv contract for linux-test-vm boot-vm.sh's
# BOOT_DATA_DISK (extra qcow2 data disk) and BOOT_SHARE_RO (read-only virtio-9p
# host directory) knobs, added for the Portable Papercusp P-052 restore rehearsal
# (WI-10006429: restore ~195 GB of DB dumps inside the clean-room VM).
#
# WHAT IT GUARDS:
#   - unset knobs add NOTHING to the qemu argv (default boots are unchanged);
#   - BOOT_DATA_DISK attaches as virtio-blk with serial=pcdata, so the guest path
#     /dev/disk/by-id/virtio-pcdata is stable whatever /dev/vdX it lands on;
#   - BOOT_SHARE_RO is exported with readonly=on (a restore rehearsal must never be
#     able to write into the host dump tree, whose inodes are hardlink-shared with
#     the live backups);
#   - a missing disk or a malformed share spec refuses BEFORE qemu is launched.
#
# WHAT IT RUNS: the REAL boot-vm.sh + common.sh against a throwaway
# PAPERCUSP_TESTVM_HOME. systemd-run is replaced through the existing
# PAPERCUSP_TESTVM_SYSTEMD_RUN seam by a stub that records argv and exits 0, so there
# is no qemu, no KVM and no network. Ports use high bases (43100+).
#
#   bash bin/lib/vm-boot-extra-drives.selftest.sh   # exit 0 = PASS, 1 = FAIL
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOT="${VM_BOOT_SELFTEST_SCRIPT:-$DIR/../../scripts/linux-test-vm/boot-vm.sh}"
[ -f "$BOOT" ] || { echo "  ✗ boot-vm.sh not found at $BOOT"; exit 1; }

FAILS=0
ok()  { echo "  ✓ $*"; }
bad() { echo "  ✗ $*"; FAILS=$((FAILS + 1)); }

TMP="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/home" "$TMP/share"
: > "$TMP/root.qcow2"
: > "$TMP/data.qcow2"
ARGV="$TMP/argv"
cat > "$TMP/fake-systemd-run" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$ARGV"
exit 0
EOF
chmod +x "$TMP/fake-systemd-run"

boot() {  # boot [VAR=value ...] — runs the real boot-vm.sh with the stubbed scope runner
  rm -f "$ARGV"
  env PAPERCUSP_TESTVM_HOME="$TMP/home" PAPERCUSP_TESTVM_SYSTEMD_RUN="$TMP/fake-systemd-run" \
      VM_SSH_BASE=43100 VM_SPICE_BASE=43200 VM_OP_BASE=43300 \
      BOOT_DISK="$TMP/root.qcow2" "$@" bash "$BOOT" clean >"$TMP/out" 2>&1
}
has() { [ -f "$ARGV" ] && grep -qxF -- "$1" "$ARGV"; }
mentions() { [ -f "$ARGV" ] && grep -qF -- "$1" "$ARGV"; }

echo "linux-test-vm boot-vm.sh extra drives (WI-10006429)"

# 1. Default boot: neither knob set → no data disk, no 9p export.
boot
if [ -f "$ARGV" ] && mentions "file=$TMP/root.qcow2"; then
  ok "default boot reaches qemu with the root disk"
else
  bad "default boot did not reach the stubbed qemu launch: $(tail -n 3 "$TMP/out")"
fi
if mentions "pcdata" || mentions "pcroot" || mentions "-virtfs"; then
  bad "default boot added an extra drive, a root bootindex or a 9p export"
else
  ok "default boot adds no extra drive and no 9p export"
fi
if has "if=virtio,format=qcow2,file=$TMP/root.qcow2,cache=writeback,discard=unmap"; then
  ok "default boot keeps the legacy if=virtio root drive"
else
  bad "default boot changed the root drive argv"
fi

# 2. BOOT_DATA_DISK → virtio-blk with a stable serial, and the ROOT disk pinned as the
#    boot device. qemu realizes `-drive if=virtio` after every explicit -device, so an
#    unpinned root lands behind the blank data disk and SeaBIOS halts at "No bootable
#    device" (the guest never boots; measured 2026-10-06).
boot BOOT_DATA_DISK="$TMP/data.qcow2"
if has "if=none,id=pcdata,format=qcow2,file=$TMP/data.qcow2,cache=writeback,discard=unmap" \
   && has "virtio-blk-pci,drive=pcdata,serial=pcdata"; then
  ok "BOOT_DATA_DISK attaches as virtio-blk serial=pcdata"
else
  bad "BOOT_DATA_DISK argv wrong: $(grep -F pcdata "$ARGV" 2>/dev/null | tr '\n' ' ')"
fi
if has "if=none,id=pcroot,format=qcow2,file=$TMP/root.qcow2,cache=writeback,discard=unmap" \
   && has "virtio-blk-pci,drive=pcroot,bootindex=0" \
   && ! mentions "if=virtio,format=qcow2,file=$TMP/root.qcow2"; then
  ok "with a data disk, the root disk is the explicit boot device (bootindex=0)"
else
  bad "with a data disk, the root disk is not pinned as the boot device"
fi
if mentions "drive=pcdata" && grep -F "drive=pcdata" "$ARGV" | grep -qF bootindex; then
  bad "the data disk carries a bootindex (SeaBIOS would prefer it)"
else
  ok "the data disk carries no bootindex"
fi

# 3. BOOT_SHARE_RO → read-only 9p export.
boot BOOT_SHARE_RO="$TMP/share:dumps"
if has "local,path=$TMP/share,mount_tag=dumps,security_model=none,readonly=on"; then
  ok "BOOT_SHARE_RO exports the host dir read-only under its tag"
else
  bad "BOOT_SHARE_RO argv wrong: $(grep -F virtfs -A1 "$ARGV" 2>/dev/null | tr '\n' ' ')"
fi

# 4. Refusals happen before qemu launches.
boot BOOT_DATA_DISK="$TMP/missing.qcow2"
if [ ! -f "$ARGV" ] && grep -qF "BOOT_DATA_DISK not found" "$TMP/out"; then
  ok "a missing BOOT_DATA_DISK refuses before launch"
else
  bad "a missing BOOT_DATA_DISK did not refuse before launch"
fi
for spec in "$TMP/share" "$TMP/nope:dumps" "$TMP/share:"; do
  boot BOOT_SHARE_RO="$spec"
  if [ ! -f "$ARGV" ] && grep -qF "BOOT_SHARE_RO must be" "$TMP/out"; then
    ok "malformed BOOT_SHARE_RO '${spec#"$TMP"/}' refuses before launch"
  else
    bad "malformed BOOT_SHARE_RO '${spec#"$TMP"/}' was not refused"
  fi
done

if [ "$FAILS" -eq 0 ]; then echo "PASS"; exit 0; fi
echo "FAIL ($FAILS)"; exit 1
