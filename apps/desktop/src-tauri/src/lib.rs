//! LemonLime desktop shell: the window, native dialogs, and the local runner
//! processes that back local threads.

mod paths;
mod previews;
mod repo;
mod runner;
mod secrets;
mod skills;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, RunEvent};

/// Set once the person has agreed to quit while agents were working.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// The window agreed (or nothing was working): quit for real.
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(runner::Runners::default())
        .manage(previews::Tunnels::default())
        .invoke_handler(tauri::generate_handler![
            runner::start_local_runner,
            runner::stop_local_runner,
            runner::local_runner_running,
            runner::list_local_runners,
            runner::remove_local_thread,
            repo::inspect_repo,
            secrets::secret_get,
            secrets::secret_set,
            previews::start_preview_tunnel,
            previews::preview_tunnel_token,
            previews::stop_preview_tunnel,
            skills::list_skills,
            skills::add_skill,
            skills::remove_skill,
            skills::skills_folder,
            confirm_quit,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start LemonLime")
        .run(|app, event| match event {
            // Quitting with runners alive: let the window decide (it asks if an agent is
            // mid-turn), unless it already said yes.
            RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() && !QUIT_CONFIRMED.load(Ordering::SeqCst) && app.state::<runner::Runners>().any_alive() {
                    api.prevent_exit();
                    let _ = app.emit("confirm-quit", ());
                }
            }
            // Never leave runner processes behind when the app quits.
            RunEvent::Exit => {
                app.state::<runner::Runners>().stop_all();
                app.state::<previews::Tunnels>().stop_all();
            }
            _ => {}
        });
}
