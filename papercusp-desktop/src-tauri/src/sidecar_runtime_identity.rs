//! Identity of the entire hot runtime, not just serve.mjs. Hash native NTFS
//! directly; enumerating it through WSL/DrvFs reinstates the staging bottleneck.
//! This is a cache key, NOT a substitute for release artifact acceptance.
//!
//! WI-10003673: walking the installed tree is ~17k files / ~5 GB and took ~9
//! minutes per Server boot on the Windows VM, BEFORE the marker probe. The
//! Windows packer therefore ships the key precomputed at build time
//! (`bin/lib/sidecar-runtime-generation.js`) in [`PRECOMPUTED_GENERATION_FILE`],
//! bound to the exact bytes of `.sidecar-build-stamp`. [`generation`] (the walk)
//! remains the fallback when that record is absent or does not match.

use sha2::{Digest, Sha256};
use std::fs;
use std::io::{self, Read};
use std::path::Path;

/// Written by the Windows packer beside `.sidecar-build-stamp`. It describes
/// the tree, so the walk excludes it (a record cannot hash itself).
pub const PRECOMPUTED_GENERATION_FILE: &str = ".sidecar-runtime-generation";
/// Schema tag the packer writes; anything else is ignored (walk fallback).
pub const PRECOMPUTED_GENERATION_SCHEMA: &str = "papercusp-sidecar-runtime-generation/v1";

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// The build-time generation for `root`, when one is shipped AND bound to the
/// installed stamp bytes. `Ok(None)` = no record (older producer): walk.
/// `Err` = a record exists but must not be trusted (malformed, unknown schema,
/// or written for a different stamp — e.g. left behind by another build): the
/// caller logs the reason and walks. Never returns a key the record did not
/// bind to THIS stamp, so a stale record can only cost a walk, never reuse an
/// obsolete snapshot.
pub fn precomputed_generation(root: &Path, stamp_bytes: &[u8]) -> io::Result<Option<String>> {
    let path = root.join(PRECOMPUTED_GENERATION_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let record: serde_json::Value = serde_json::from_str(&text)
        .map_err(|error| invalid(format!("{}: {error}", path.display())))?;
    let field = |name: &str| record.get(name).and_then(serde_json::Value::as_str);
    if field("schema") != Some(PRECOMPUTED_GENERATION_SCHEMA) {
        return Err(invalid(format!(
            "{}: schema is not {PRECOMPUTED_GENERATION_SCHEMA}",
            path.display()
        )));
    }
    let generation = field("generation")
        .filter(|value| is_hex64(value))
        .ok_or_else(|| invalid(format!("{}: no 64-hex generation", path.display())))?;
    let bound = field("stampSha256")
        .filter(|value| is_hex64(value))
        .ok_or_else(|| invalid(format!("{}: no 64-hex stampSha256", path.display())))?;
    let installed = format!("{:x}", Sha256::digest(stamp_bytes));
    if !bound.eq_ignore_ascii_case(&installed) {
        return Err(invalid(format!(
            "{} is bound to stamp {bound}, but the installed stamp hashes to {installed}",
            path.display()
        )));
    }
    Ok(Some(generation.to_ascii_lowercase()))
}

fn frame(hash: &mut Sha256, bytes: &[u8]) {
    hash.update((bytes.len() as u64).to_le_bytes());
    hash.update(bytes);
}

pub fn generation(root: &Path) -> io::Result<String> {
    let mut hash = Sha256::new();
    frame(&mut hash, b"papercusp-hot-runtime-v1");
    let mut buffer = vec![0u8; 1024 * 1024];
    walk(root, "", &mut hash, &mut buffer)?;
    Ok(format!("{:x}", hash.finalize()))
}

fn walk(root: &Path, relative: &str, hash: &mut Sha256, buffer: &mut [u8]) -> io::Result<()> {
    let mut names = fs::read_dir(root.join(relative))?
        .map(|entry| {
            entry?
                .file_name()
                .into_string()
                .map_err(|_| invalid("Non-Unicode runtime filename"))
        })
        .collect::<io::Result<Vec<_>>>()?;
    names.sort();
    for name in names {
        // Exactly the cold inputs excluded by the production tar invocation.
        // The completion marker is generated AFTER extraction, not payload.
        // The precomputed-generation record describes this tree (WI-10003673).
        if relative.is_empty()
            && matches!(
                name.as_str(),
                "source.tar.zst"
                    | "db-seed.dump"
                    | "db-seed.tar.gz"
                    | ".papercusp-runtime-complete"
                    | PRECOMPUTED_GENERATION_FILE
            )
        {
            continue;
        }
        let rel = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let file = root.join(&rel);
        let metadata = fs::symlink_metadata(&file)?;
        frame(hash, rel.as_bytes());
        if metadata.is_symlink() {
            frame(hash, b"link");
            let target = fs::read_link(&file)?;
            let target = target
                .to_str()
                .ok_or_else(|| invalid("Non-Unicode runtime symlink"))?;
            #[cfg(windows)]
            let target = target.replace('\\', "/");
            frame(hash, target.as_bytes());
        } else if metadata.is_dir() {
            frame(hash, b"directory");
            walk(root, &rel, hash, buffer)?;
        } else if metadata.is_file() {
            frame(hash, b"file");
            hash.update(metadata.len().to_le_bytes());
            let mut input = fs::File::open(&file)?;
            let before = input.metadata()?;
            if before.len() != metadata.len() || before.modified()? != metadata.modified()? {
                return Err(invalid(format!(
                    "Runtime file changed before hashing: {rel}"
                )));
            }
            let mut bytes = 0u64;
            let mut magic = Vec::with_capacity(4);
            loop {
                let n = input.read(buffer)?;
                if n == 0 {
                    break;
                }
                let remaining = 4 - magic.len();
                magic.extend_from_slice(&buffer[..n.min(remaining)]);
                hash.update(&buffer[..n]);
                bytes += n as u64;
            }
            let after = input.metadata()?;
            let path_after = fs::symlink_metadata(&file)?;
            if bytes != before.len()
                || after.len() != before.len()
                || after.modified()? != before.modified()?
                || !path_after.is_file()
                || path_after.len() != before.len()
                || path_after.modified()? != before.modified()?
            {
                return Err(invalid(format!(
                    "Runtime file changed while hashing: {rel}"
                )));
            }
            // EXTRACT_SCRIPT derives owner execute from these same magic bytes.
            // NTFS's synthesized Unix mode is deliberately not an identity input.
            hash.update([u8::from(magic.starts_with(b"#!") || magic == b"\x7fELF")]);
        } else {
            return Err(invalid(format!("Unsupported runtime entry: {rel}")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "pc-runtime-identity-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            fs::create_dir(&p).unwrap();
            fs::write(p.join("serve.mjs"), "same serve bytes").unwrap();
            fs::write(p.join(".sidecar-build-stamp"), "same stamp bytes").unwrap();
            Self(p)
        }
        fn key(&self) -> String {
            generation(&self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn non_serve_content_and_removals_change_the_cache_key() {
        let f = Fixture::new();
        let clean = f.key();
        assert_eq!(clean.len(), 64);
        fs::write(f.0.join("old-spa.js"), "old").unwrap();
        let dirty = f.key();
        assert_ne!(clean, dirty);
        fs::write(f.0.join("old-spa.js"), "new").unwrap();
        assert_ne!(dirty, f.key());
        fs::remove_file(f.0.join("old-spa.js")).unwrap();
        assert_eq!(clean, f.key());
        fs::create_dir(f.0.join("empty-directory")).unwrap();
        assert_ne!(clean, f.key());
    }

    #[test]
    fn framing_distinguishes_name_content_boundaries() {
        let f = Fixture::new();
        fs::write(f.0.join("ab"), "c").unwrap();
        let a = f.key();
        fs::remove_file(f.0.join("ab")).unwrap();
        fs::write(f.0.join("a"), "bc").unwrap();
        assert_ne!(a, f.key());
    }

    #[test]
    fn excludes_only_root_cold_inputs_and_generated_completion_marker() {
        let f = Fixture::new();
        let a = f.key();
        for name in [
            "source.tar.zst",
            "db-seed.dump",
            "db-seed.tar.gz",
            ".papercusp-runtime-complete",
            ".sidecar-runtime-generation",
        ] {
            fs::write(f.0.join(name), "not hot payload").unwrap();
        }
        assert_eq!(a, f.key());
        fs::create_dir(f.0.join("nested")).unwrap();
        let b = f.key();
        fs::write(f.0.join("nested/source.tar.zst"), "hot nested file").unwrap();
        assert_ne!(b, f.key());
    }

    fn record(generation: &str, stamp_sha: &str) -> String {
        format!(
            r#"{{"schema":"{PRECOMPUTED_GENERATION_SCHEMA}","generation":"{generation}","stampSha256":"{stamp_sha}"}}"#
        )
    }

    fn sha(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn precomputed_record_is_used_only_when_bound_to_the_installed_stamp() {
        let f = Fixture::new();
        let stamp = b"same stamp bytes";
        // Absent: the caller walks (older producers ship no record).
        assert_eq!(precomputed_generation(&f.0, stamp).unwrap(), None);

        let generation = "AB".repeat(32);
        fs::write(f.0.join(PRECOMPUTED_GENERATION_FILE), record(&generation, &sha(stamp))).unwrap();
        assert_eq!(
            precomputed_generation(&f.0, stamp).unwrap().as_deref(),
            Some("ab".repeat(32).as_str()),
            "a bound record is the key, normalized to lowercase like the walk's output"
        );
        // A different stamp (another build's record left behind) is refused.
        assert!(precomputed_generation(&f.0, b"another build's stamp").is_err());

        for bad in [
            record("not-hex", &sha(stamp)),
            record(&"ab".repeat(31), &sha(stamp)),
            record(&generation, "short"),
            record(&generation, &sha(stamp)).replace("/v1", "/v0"),
            "{not json".to_string(),
        ] {
            fs::write(f.0.join(PRECOMPUTED_GENERATION_FILE), &bad).unwrap();
            assert!(precomputed_generation(&f.0, stamp).is_err(), "must not trust {bad}");
        }
    }

    /// Cross-language contract: the exact bytes the Windows packer
    /// (bin/lib/sidecar-runtime-generation.js) writes for the fixture stamp.
    /// test/sidecar-runtime-generation.test.js pins the writer to the same file.
    #[test]
    fn reads_the_record_the_windows_packer_writes() {
        let f = Fixture::new();
        let stamp = include_bytes!("../../test/fixtures/sidecar-runtime-generation/stamp.json");
        let written = include_str!("../../test/fixtures/sidecar-runtime-generation/record.json");
        fs::write(f.0.join(PRECOMPUTED_GENERATION_FILE), written).unwrap();
        let expected: serde_json::Value = serde_json::from_str(written).unwrap();
        assert_eq!(
            precomputed_generation(&f.0, stamp).unwrap().as_deref(),
            expected["generation"].as_str()
        );
    }

    #[test]
    #[cfg(unix)]
    fn hashes_link_target_not_external_data() {
        let f = Fixture::new();
        std::os::unix::fs::symlink("missing-a", f.0.join("link")).unwrap();
        let a = f.key();
        fs::remove_file(f.0.join("link")).unwrap();
        std::os::unix::fs::symlink("missing-b", f.0.join("link")).unwrap();
        assert_ne!(a, f.key());
    }
}
