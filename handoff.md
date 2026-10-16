## **Development Handoff: Colima & Tauri Container Management App**

**Project Goal:** Build a lightweight, developer-friendly macOS database controller (similar to DBngin) using a **Tauri** desktop GUI wrapper over an embedded **Colima/Docker** virtualization backend.

## ---

**1\. Current Architectural Status**

> * **Frontend:** Designed to run via **Tauri** (HTML/JS/TS layer rendering via native macOS WebKit).  
> * **Backend:** Powered by **Rust (Tauri v2)** orchestrating background system processes headlessly.  
> * **Core Engine:** **Colima** is utilized to spawn a minimalist, low-overhead Linux VM layer to host the containers, meaning the end-user avoids heavy Docker Desktop licensing fees.  
> * **Data Layer:** Container filesystems are mapped natively back to host paths (e.g., \~/Library/Application Support/) via Docker volume bindings to mirror true DBngin state persistence.

## ---

**2\. Core Implementation Strategy**

To spin up and control database services natively without terminal interaction, the app must translate frontend UI clicks into headless, non-blocking Rust system tasks using tauri-plugin-shell.

The core commands implemented or drafted are:

> 1. initialize\_backend: Boots the Colima engine headlessly if not already running.  
> 2. start\_service: Provisions specific container configurations dynamically based on port mappings and volume targets.  
> 3. stop\_service: Stops and purges the runtime containers while preserving local data directories.

## ---

**3\. Implementation Codebase**

## **Backend: src-tauri/src/lib.rs**

`use tauri_plugin_shell::ShellExt;`  
`use tauri::AppHandle;`

`fn run_command(app: &AppHandle, program: &str, args: Vec<&str>) -> Result<String, String> {`  
    `let shell = app.shell();`  
    `let output = shell`  
        `.command(program)`  
        `.args(args)`  
        `.output();`

    `match output {`  
        `Ok(out) => {`  
            `if out.status.success() {`  
                `Ok(String::from_utf8_lossy(&out.stdout).to_string())`  
            `} else {`  
                `Err(String::from_utf8_lossy(&out.stderr).to_string())`  
            `}`  
        `}`  
        `Err(e) => Err(e.to_string()),`  
    `}`  
`}`

`#[tauri::command]`  
`async fn initialize_backend(app: AppHandle) -> Result<String, String> {`  
    `let status = run_command(&app, "colima", vec!["status"]);`  
    `if status.is_ok() && status.unwrap().contains("running") {`  
        `return Ok("Colima is already active.".to_string());`  
    `}`  
    `run_command(&app, "colima", vec!["start", "--headless", "--cpu", "2", "--memory", "2"])`  
        `.map(|_| "Colima started successfully.".to_string())`  
`}`

`#[tauri::command]`  
`async fn start_service(`  
    `app: AppHandle,`   
    `service_type: String, // "postgres", "redis", "rabbitmq"`  
    `instance_name: String,`   
    `port: String,`          
    `data_dir: String`       
`) -> Result<String, String> {`  
    `let volume_mapping = format!("{}:/var/lib/{}/data", data_dir, service_type);`  
    `let container_name = format!("dbngin-clone-{}-{}", service_type, port);`  
    `let port_mapping = format!("{}:{}", port, match service_type.as_str() {`  
        `"postgres" => "5432",`  
        `"redis" => "6379",`  
        `"rabbitmq" => "5672",`  
        `_ => return Err("Unsupported service type".to_string())`  
    `});`

    `let args = vec![`  
        `"run", "-d",`  
        `"--name", &container_name,`  
        `"-p", &port_mapping,`  
        `"-v", &volume_mapping,`  
        `"-e", "POSTGRES_PASSWORD=postgres",`   
        `&service_type`   
    `];`

    `run_command(&app, "docker", args).map(|_| format!("{} is online on port {}", instance_name, port))`  
`}`

`#[tauri::command]`  
`async fn stop_service(app: AppHandle, service_type: String, port: String) -> Result<String, String> {`  
    `let container_name = format!("dbngin-clone-{}-{}", service_type, port);`  
    `let _ = run_command(&app, "docker", vec!["stop", &container_name]);`  
    `let _ = run_command(&app, "docker", vec!["rm", &container_name]);`  
    `Ok("Service stopped successfully.".to_string())`  
`}`

`pub fn run() {`  
    `tauri::Builder::default()`  
        `.plugin(tauri_plugin_shell::init())`  
        `.invoke_handler(tauri::generate_handler![initialize_backend, start_service, stop_service])`  
        `.run(tauri::generate_context!())`  
        `.expect("error while running tauri application");`  
`}`

## ---

**4\. Immediate Development Backlog**

> * **Implement Container Auto-Discovery:** Write a Rust command parsing docker ps \-a \--filter "name=dbngin-clone-" \--format "{{.Names}}|{{.Status}}" so that when the app restarts, the UI syncs correctly with background tasks.  
> * **Auto-Provisioning System:** Write a setup wrapper that runs on initial startup to check if colima and docker are installed on the user's Mac, prompting a download or embedding binaries natively if absent.  
> * **Disable Application Sandboxing:** Verify entitlements configure correctly in tauri.conf.json to guarantee shell executions have sufficient path access on local Darwin profiles.

## ---

**5\. Suggested Prompt for Next Agent**

`"I am building a macOS DBngin alternative using Tauri v2 and Colima as the backend. Review the provided handoff document. Let's start by writing the Rust command for Container Auto-Discovery to pull container name and status strings, along with the TypeScript types required to render them in the UI."`

Would you like me to generate a fully fleshed out **tauri.conf.json** specification or sample **TypeScript state store** matching this layout before you hand off to your next Agent CLI?