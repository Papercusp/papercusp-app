//! Resolve the Server-owned Windows runtime for either installed bundle.
//! The thin GUI has no rootfs resources: absence there must not mean Ready.
use std::path::{Path, PathBuf};

pub fn resolve(
    bundle_root: &Path,
    local_app_data: Option<&Path>,
    installed_gui: bool,
    filename: &str,
) -> Result<PathBuf, String> {
    // Reuse launch_bundle's per-product LOCALAPPDATA installation contract.
    // Never prefer resources left in an older thick GUI installation.
    let root = if installed_gui {
        local_app_data
            .ok_or_else(|| "Cannot locate Papercusp Server: LOCALAPPDATA is unset".to_string())?
            .join("Papercusp Server")
    } else {
        bundle_root.to_path_buf()
    };
    for candidate in [root.join("resources").join(filename), root.join(filename)] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Papercusp Server runtime resource '{filename}' is missing from {}. \
         Install or repair Papercusp Server before configuring WSL.",
        root.display()
    ))
}

pub fn read_recipe(path: &Path) -> Result<String, String> {
    let recipe = std::fs::read_to_string(path)
        .map_err(|e| format!("Read WSL recipe {}: {e}", path.display()))?;
    let recipe = recipe.trim();
    if recipe.len() != 64 || !recipe.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "Invalid WSL recipe fingerprint in {}; repair Papercusp Server",
            path.display()
        ));
    }
    Ok(recipe.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "papercusp wsl resources {} {}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn file(&self, relative: &str, body: &str) -> PathBuf {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, body).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn thin_gui_uses_the_server_for_all_three_runtime_inputs() {
        let f = Fixture::new();
        let gui = f.0.join("Papercusp GUI");
        for name in [
            "papercup-rootfs-recipe",
            "papercup-bootstrap.sh",
            "papercup-runtime.tar.gz",
        ] {
            let server = f.file(
                &format!("Papercusp Server/resources/{name}"),
                &"a".repeat(64),
            );
            f.file(&format!("Papercusp GUI/resources/{name}"), "old");
            assert_eq!(resolve(&gui, Some(&f.0), true, name).unwrap(), server);
        }
        assert_eq!(
            read_recipe(&resolve(&gui, Some(&f.0), true, "papercup-rootfs-recipe").unwrap())
                .unwrap(),
            "a".repeat(64)
        );
    }

    #[test]
    fn absent_server_never_falls_back_to_old_gui_recipe() {
        let f = Fixture::new();
        f.file(
            "Papercusp GUI/resources/papercup-rootfs-recipe",
            &"a".repeat(64),
        );
        let error = resolve(
            &f.0.join("Papercusp GUI"),
            Some(&f.0),
            true,
            "papercup-rootfs-recipe",
        )
        .unwrap_err();
        assert!(error.contains("Install or repair Papercusp Server"));
        assert!(resolve(&f.0, None, true, "papercup-rootfs-recipe").is_err());
    }

    #[test]
    fn server_and_development_use_their_own_resource_root() {
        let f = Fixture::new();
        let nested = f.file("resources/papercup-rootfs-recipe", &"b".repeat(64));
        f.file("papercup-rootfs-recipe", &"c".repeat(64));
        assert_eq!(
            resolve(&f.0, None, false, "papercup-rootfs-recipe").unwrap(),
            nested
        );
        std::fs::remove_file(nested).unwrap();
        assert_eq!(
            resolve(&f.0, None, false, "papercup-rootfs-recipe").unwrap(),
            f.0.join("papercup-rootfs-recipe")
        );
    }

    #[test]
    fn directory_or_missing_input_is_not_a_resource() {
        let f = Fixture::new();
        std::fs::create_dir_all(f.0.join("resources/papercup-bootstrap.sh")).unwrap();
        assert!(resolve(&f.0, None, false, "papercup-bootstrap.sh").is_err());
        assert!(resolve(&f.0, None, false, "papercup-runtime.tar.gz").is_err());
    }

    #[test]
    fn unreadable_empty_or_invalid_recipe_cannot_be_ready() {
        let f = Fixture::new();
        assert!(read_recipe(&f.0.join("missing")).is_err());
        for body in ["", "\n ", "old recipe", &"z".repeat(64), &"a".repeat(63)] {
            assert!(read_recipe(&f.file("recipe", body)).is_err());
        }
        assert_eq!(
            read_recipe(&f.file("recipe", &format!("{}\r\n", "f".repeat(64)))).unwrap(),
            "f".repeat(64)
        );
    }
}
