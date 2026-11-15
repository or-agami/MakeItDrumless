#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct WorkerJobs(Mutex<HashMap<String, CommandChild>>);

fn publish_worker_line(app: &AppHandle, job_id: &str, line: &[u8]) -> (Option<Value>, Option<String>) {
    let text = String::from_utf8_lossy(line);
    let Ok(event) = serde_json::from_str::<Value>(text.trim()) else {
        return (None, None);
    };

    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    let worker_error = if event_type == "error" {
        event.get("message").and_then(Value::as_str).map(str::to_owned)
    } else {
        None
    };
    let result = if event_type == "result" {
        event.get("result").cloned()
    } else {
        None
    };
    let _ = app.emit(
        "makeitdrumless-worker",
        json!({ "job_id": job_id, "event": event }),
    );
    (result, worker_error)
}

#[tauri::command]
async fn run_worker(
    app: AppHandle,
    jobs: State<'_, WorkerJobs>,
    job_id: String,
    request: Value,
) -> Result<Value, String> {
    let command = app
        .shell()
        .sidecar("makeitdrumless-worker")
        .map_err(|error| format!("Could not locate the MakeItDrumless worker: {error}"))?;
    let (mut receiver, mut child) = command
        .spawn()
        .map_err(|error| format!("Could not start MakeItDrumless: {error}"))?;

    let mut request_line = serde_json::to_vec(&request).map_err(|error| error.to_string())?;
    request_line.push(b'\n');
    child
        .write(&request_line)
        .map_err(|error| format!("Could not send the request to MakeItDrumless: {error}"))?;

    {
        let mut active = jobs.0.lock().map_err(|_| "Worker state is unavailable".to_string())?;
        if active.contains_key(&job_id) {
            let _ = child.kill();
            return Err("A job with this ID is already running".to_string());
        }
        active.insert(job_id.clone(), child);
    }

    let mut result: Option<Value> = None;
    let mut buffer = Vec::<u8>::new();
    let mut process_error: Option<String> = None;
    let mut worker_error: Option<String> = None;

    while let Some(event) = receiver.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                buffer.extend_from_slice(&bytes);
                while let Some(index) = buffer.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=index).collect();
                    let (value, error) = publish_worker_line(&app, &job_id, &line);
                    if value.is_some() { result = value; }
                    if error.is_some() { worker_error = error; }
                }
            }
            CommandEvent::Stderr(bytes) => {
                let message = String::from_utf8_lossy(&bytes).trim().to_string();
                if !message.is_empty() {
                    process_error = Some(message);
                }
            }
            CommandEvent::Error(error) => process_error = Some(error),
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }

    if !buffer.is_empty() {
        let (value, error) = publish_worker_line(&app, &job_id, &buffer);
        if value.is_some() { result = value; }
        if error.is_some() { worker_error = error; }
    }

    if let Ok(mut active) = jobs.0.lock() {
        active.remove(&job_id);
    }

    if let Some(result) = result {
        Ok(result)
    } else {
        Err(worker_error.or(process_error).unwrap_or_else(|| "The MakeItDrumless worker exited without a result.".to_string()))
    }
}

#[tauri::command]
fn cancel_worker(jobs: State<'_, WorkerJobs>, job_id: String) -> Result<(), String> {
    let mut active = jobs.0.lock().map_err(|_| "Worker state is unavailable".to_string())?;
    let Some(child) = active.get_mut(&job_id) else {
        return Ok(());
    };
    child
        .write(b"{\"operation\":\"cancel\"}\n")
        .map_err(|error| format!("Could not cancel the active job: {error}"))
}

#[tauri::command]
fn set_library_root(app: AppHandle, path: String) -> Result<(), String> {
    let root = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| format!("Could not open the selected library folder: {error}"))?;
    if !root.is_dir() {
        return Err("The selected library path is not a folder.".to_string());
    }
    app.asset_protocol_scope()
        .allow_directory(&root, true)
        .map_err(|error| format!("Could not grant playback access to this folder: {error}"))
}

fn main() {
    tauri::Builder::default()
        .manage(WorkerJobs::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .setup(|app| {
            let library_root = app.path().audio_dir()?.join("MakeItDrumless");
            fs::create_dir_all(&library_root)?;
            app.asset_protocol_scope().allow_directory(library_root, true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![run_worker, cancel_worker, set_library_root])
        .run(tauri::generate_context!())
        .expect("error while running MakeItDrumless Desktop");
}
