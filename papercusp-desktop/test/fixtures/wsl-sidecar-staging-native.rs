//! Native Windows fixture for the exact production process/transport module.
//! It never publishes a runtime marker or starts/stops an application. Pass a
//! fresh, explicitly diagnostic Linux directory, not runtime-sidecars/<hash>.
#[path = "../../src-tauri/src/wsl_sidecar_staging.rs"]
mod staging;

use std::process::Command;
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if !(args.len() == 3 || (args.len() == 4 && args[3] == "--probe-only"))
        || !args[2].starts_with("/tmp/papercusp-staging-diagnostic-")
    {
        return Err("Expected source directory, /tmp/papercusp-staging-diagnostic-* target, optional --probe-only".into());
    }
    let source = std::path::Path::new(&args[1]);
    if !source.join("serve.mjs").is_file() || !source.join("sidecar-preload.js").is_file() {
        return Err("Source is not a sidecar".into());
    }
    let probe_start = Instant::now();
    let mut probe = staging::wsl_command();
    probe.args(["/usr/bin/test", "!", "-e", &args[2]]);
    if !staging::run_wsl_bounded(&mut probe, Duration::from_secs(10),
        staging::WSL_STARTUP_TIMEOUT + Duration::from_secs(10))?.success()
    {
        return Err("Diagnostic target already exists; inspect it instead of rerunning".into());
    }
    if args.len() == 4 {
        println!("NATIVE_READINESS_PASS elapsed_ms={} archive=false acceptance=false published=false",
            probe_start.elapsed().as_millis());
        return Ok(());
    }
    let mut producer = Command::new("tar.exe");
    producer.arg("-C").arg(source).args(staging::ARCHIVE_ARGS)
        .args(["-b", "2048", "-cf", "-", "."]);
    let mut consumer = staging::wsl_command();
    consumer.args(["/bin/bash", "-c"])
        .arg(staging::EXTRACT_SCRIPT).arg("diagnostic-extract").arg("-").arg(&args[2]);
    let start = Instant::now();
    staging::stage_archive(producer, consumer, Duration::from_secs(1_200))?;
    println!("NATIVE_ARCHIVE_PASS elapsed_ms={} acceptance=false published=false",
        start.elapsed().as_millis());
    Ok(())
}
