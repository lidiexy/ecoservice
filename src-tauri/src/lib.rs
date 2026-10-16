use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

const PREFIX: &str = "dbngin-clone-";
const LABEL: &str = "ecoservices.name";

async fn run_command(app: &AppHandle, program: &str, args: Vec<&str>) -> Result<String, String> {
    let out = app
        .shell()
        .command(program)
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).to_string())
    }
}

// Pulls `image` if missing, emitting each `docker pull` output line as a "pull-progress" event.
async fn pull_image(app: &AppHandle, image: &str) -> Result<(), String> {
    if run_command(app, "docker", vec!["image", "inspect", image]).await.is_ok() {
        return Ok(());
    }
    let (mut rx, _child) = app
        .shell()
        .command("docker")
        .args(["pull", image])
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(line) => {
                let _ = app.emit("pull-progress", String::from_utf8_lossy(&line).trim_end());
            }
            CommandEvent::Stderr(line) => stderr.push_str(&String::from_utf8_lossy(&line)),
            CommandEvent::Terminated(p) if p.code != Some(0) => return Err(stderr),
            _ => {}
        }
    }
    Ok(())
}

fn ensure_ours(name: &str) -> Result<(), String> {
    name.starts_with(PREFIX)
        .then_some(())
        .ok_or_else(|| "Not an ecoservices container".to_string())
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Service {
    name: String,
    service_type: String,
    port: String,
    status: String,
    running: bool,
    image: String,
    label: String, // optional custom name, "" if none
}

// Parses `docker ps --format "{{.Names}}|{{.Status}}|{{.Image}}|{{.Label ...}}"`; names are dbngin-clone-{type}-{port}.
fn parse_services(stdout: &str) -> Vec<Service> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '|');
            let (name, status, image) = (parts.next()?, parts.next()?, parts.next()?);
            let label = parts.next().unwrap_or("");
            let (service_type, port) = name.strip_prefix(PREFIX)?.rsplit_once('-')?;
            Some(Service {
                name: name.into(),
                service_type: service_type.into(),
                port: port.into(),
                running: status.starts_with("Up"),
                status: status.into(),
                image: image.into(),
                label: label.into(),
            })
        })
        .collect()
}

#[tauri::command]
async fn list_services(app: AppHandle) -> Result<Vec<Service>, String> {
    let filter = format!("name={PREFIX}");
    let format = format!("{{{{.Names}}}}|{{{{.Status}}}}|{{{{.Image}}}}|{{{{.Label \"{LABEL}\"}}}}");
    run_command(&app, "docker", vec!["ps", "-a", "--filter", &filter, "--format", &format])
        .await
        .map(|out| parse_services(&out))
}

#[derive(Serialize, Debug, PartialEq)]
struct Stats {
    cpu: String,
    mem: String,
}

// Parses `docker stats --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}"`; mem keeps only the used part.
fn parse_stats(stdout: &str) -> HashMap<String, Stats> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut p = line.splitn(3, '|');
            let (name, cpu, mem) = (p.next()?, p.next()?, p.next()?);
            name.starts_with(PREFIX).then(|| {
                let used = mem.split(" / ").next().unwrap_or(mem);
                (name.into(), Stats { cpu: cpu.into(), mem: used.into() })
            })
        })
        .collect()
}

// CPU/memory for running containers, keyed by container name. Takes ~1-2s (docker samples once).
#[tauri::command]
async fn service_stats(app: AppHandle) -> Result<HashMap<String, Stats>, String> {
    let format = "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}";
    run_command(&app, "docker", vec!["stats", "--no-stream", "--format", format])
        .await
        .map(|out| parse_stats(&out))
}

#[tauri::command]
async fn container_action(app: AppHandle, name: String, action: String) -> Result<String, String> {
    ensure_ours(&name)?;
    let done = match action.as_str() {
        "start" => "started",
        "stop" => "stopped",
        "restart" => "restarted",
        "rm" => "deleted (data folder kept)",
        _ => return Err(format!("Unsupported action: {action}")),
    };
    run_command(&app, "docker", vec![action.as_str(), name.as_str()])
        .await
        .map(|_| format!("{name} {done}"))
}

// Merges stdout/stderr lines by their docker timestamp prefix and keeps the newest `tail`.
fn merge_logs(stdout: &str, stderr: &str, tail: usize) -> String {
    let mut lines: Vec<&str> = stdout.lines().chain(stderr.lines()).collect();
    lines.sort(); // RFC3339 fixed-width timestamps sort lexicographically
    lines[lines.len().saturating_sub(tail)..].join("\n")
}

#[tauri::command]
async fn container_logs(app: AppHandle, name: String) -> Result<String, String> {
    ensure_ours(&name)?;
    let out = app
        .shell()
        .command("docker")
        .args(["logs", "--timestamps", "--tail", "300", &name])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if !out.status.success() {
        return Err(stderr.to_string());
    }
    Ok(merge_logs(&stdout, &stderr, 300))
}

// True if something on the host already accepts connections on `port` (Colima forwards land here too).
#[tauri::command]
async fn port_in_use(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        std::time::Duration::from_millis(300),
    )
    .is_ok()
}

#[tauri::command]
async fn initialize_backend(app: AppHandle) -> Result<String, String> {
    if let Ok(status) = run_command(&app, "colima", vec!["status"]).await {
        if status.contains("running") {
            return Ok("Colima is already active.".to_string());
        }
    }
    run_command(&app, "colima", vec!["start", "--cpu", "2", "--memory", "2"])
        .await
        .map(|_| "Colima started successfully.".to_string())
}

#[tauri::command]
async fn start_service(
    app: AppHandle,
    service_type: String, // "postgres", "redis", "rabbitmq", "mongodb"
    port: String,
    image: Option<String>,
    name: Option<String>,
    persist: Option<bool>, // default true; false = no volume, container removed on stop
) -> Result<String, String> {
    let port_num = port.parse::<u16>().map_err(|_| "Invalid port".to_string())?;
    let (default_image, internal_port) = match service_type.as_str() {
        "postgres" => ("postgres", "5432"),
        "redis" => ("redis", "6379"),
        "rabbitmq" => ("rabbitmq:management", "5672"),
        "mongodb" => ("mongo", "27017"),
        _ => return Err("Unsupported service type".to_string()),
    };
    let image = image.as_deref().map(str::trim).filter(|i| !i.is_empty()).unwrap_or(default_image);
    if !valid_image(image) {
        return Err(format!("Invalid Docker image: {image}"));
    }
    let name = name.as_deref().map(str::trim).unwrap_or("");
    if name.chars().count() > 64 {
        return Err("Custom name must be 64 characters or fewer".to_string());
    }
    let persist = persist.unwrap_or(true);
    let mount = match service_type.as_str() {
        "postgres" => postgres_mount(image),
        "redis" => "/data",
        "mongodb" => "/data/db",
        _ => "/var/lib/rabbitmq",
    };
    // RabbitMQ dashboard on AMQP port + 10000 (5672 -> 15672), only for *management images.
    let dashboard_port = match service_type.as_str() {
        "rabbitmq" if image.contains("management") => Some(
            port_num
                .checked_add(10000)
                .ok_or("RabbitMQ port must be <= 55535 (dashboard uses port + 10000)")?,
        ),
        _ => None,
    };
    // ~/Library/Application Support/<identifier>/<type>-<port>, survives stop/delete.
    // ponytail: keyed by type+port only; switching major versions on the same port reuses incompatible data.
    let volume_mapping = if persist {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join(format!("{service_type}-{port}"));
        std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
        Some(format!("{}:{mount}", data_dir.display()))
    } else {
        None
    };
    pull_image(&app, image).await?;
    let container_name = format!("{PREFIX}{service_type}-{port}");
    let port_mapping = format!("{port}:{internal_port}");
    let dashboard_mapping = dashboard_port.map(|p| format!("{p}:15672"));
    let label = format!("{LABEL}={name}");

    let mut args = vec![
        "run", "-d",
        "--name", container_name.as_str(),
        "-p", port_mapping.as_str(),
        "-e", "POSTGRES_PASSWORD=postgres",
        "--label", label.as_str(),
    ];
    match &volume_mapping {
        Some(v) => args.extend(["-v", v.as_str()]),
        None => args.push("--rm"), // ephemeral: docker deletes it (and anonymous volumes) on stop
    }
    if let Some(m) = &dashboard_mapping {
        args.extend(["-p", m.as_str()]);
    }
    args.push(image);
    let display = if name.is_empty() { service_type.as_str() } else { name };
    let mut msg = format!("{display} is online on port {port}");
    if !persist {
        msg += " (ephemeral)";
    }
    if let Some(p) = dashboard_port {
        msg += &format!(" (dashboard: http://localhost:{p}, guest/guest)");
    }
    run_command(&app, "docker", args).await.map(|_| msg)
}

// Image refs like "postgres", "postgres:15-alpine", "ghcr.io/org/img@sha256:...". Rejects flag-like input.
fn valid_image(image: &str) -> bool {
    !image.is_empty()
        && image.len() <= 255
        && !image.starts_with('-')
        && image.chars().all(|c| c.is_ascii_alphanumeric() || "._/:@-".contains(c))
}

// Postgres < 18 images keep data in /var/lib/postgresql/data (a VOLUME); 18+ use /var/lib/postgresql.
fn postgres_mount(image: &str) -> &'static str {
    let last = image.split('@').next().unwrap_or("").rsplit('/').next().unwrap_or("");
    let tag = last.split_once(':').map_or("", |(_, t)| t);
    let major: String = tag.chars().take_while(char::is_ascii_digit).collect();
    match major.parse::<u32>() {
        Ok(v) if v < 18 => "/var/lib/postgresql/data",
        _ => "/var/lib/postgresql",
    }
}

pub fn run() {
    // Finder-launched apps get PATH=/usr/bin:/bin:..., which lacks Homebrew's docker/colima.
    let path = std::env::var("PATH").unwrap_or_default();
    // SAFETY: runs before Tauri spawns any threads.
    unsafe { std::env::set_var("PATH", format!("/opt/homebrew/bin:/usr/local/bin:{path}")) };

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            initialize_backend,
            start_service,
            list_services,
            service_stats,
            container_action,
            container_logs,
            port_in_use
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_ps() {
        let out = "dbngin-clone-postgres-5432|Up 3 minutes|postgres:latest|\n\
                   dbngin-clone-redis-6380|Exited (0) 2 hours ago|redis:7-alpine|My Cache|x\n\
                   unrelated|Up 1 second|busybox|\n\
                   garbage line\n";
        let s = parse_services(out);
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].service_type.as_str(), s[0].port.as_str(), s[0].running), ("postgres", "5432", true));
        assert_eq!((s[1].service_type.as_str(), s[1].port.as_str(), s[1].running), ("redis", "6380", false));
        assert_eq!((s[1].image.as_str(), s[0].label.as_str(), s[1].label.as_str()), ("redis:7-alpine", "", "My Cache|x"));
    }

    #[test]
    fn parses_docker_stats() {
        let out = "dbngin-clone-redis-6379|0.80%|12.3MiB / 1.93GiB\nother|5%|1GiB / 2GiB\n";
        let s = parse_stats(out);
        assert_eq!(s.len(), 1);
        assert_eq!(s["dbngin-clone-redis-6379"], Stats { cpu: "0.80%".into(), mem: "12.3MiB".into() });
    }

    #[test]
    fn merges_logs_by_timestamp() {
        let out = "2026-10-15T10:00:01.000000000Z a\n2026-10-15T10:00:03.000000000Z c\n";
        let err = "2026-10-15T10:00:02.000000000Z b\n";
        assert_eq!(merge_logs(out, err, 2), "2026-10-15T10:00:02.000000000Z b\n2026-10-15T10:00:03.000000000Z c");
    }

    #[test]
    fn postgres_mount_by_version() {
        assert_eq!(postgres_mount("postgres"), "/var/lib/postgresql");
        assert_eq!(postgres_mount("postgres:18"), "/var/lib/postgresql");
        assert_eq!(postgres_mount("postgres:15-alpine"), "/var/lib/postgresql/data");
        assert_eq!(postgres_mount("localhost:5000/postgres:16.4"), "/var/lib/postgresql/data");
        assert_eq!(postgres_mount("postgres:alpine"), "/var/lib/postgresql");
    }

    #[test]
    fn image_validation() {
        assert!(valid_image("postgres:15-alpine"));
        assert!(valid_image("ghcr.io/org/img@sha256:abc123"));
        assert!(!valid_image("--privileged"));
        assert!(!valid_image("postgres; rm -rf /"));
        assert!(!valid_image(""));
    }
}
