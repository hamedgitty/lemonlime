//! LemonLime desktop shell: the window, native dialogs, and the local runner
//! processes that back local threads.

mod computer;
mod history;
mod paths;
mod plugins;
mod previews;
mod repo;
mod runner;
mod secrets;
mod skills;
mod system;

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
        .plugin(tauri_plugin_notification::init())
        .manage(runner::Runners::default())
        .manage(previews::Tunnels::default())
        .manage(system::Awake::default())
        .invoke_handler(tauri::generate_handler![
            runner::start_local_runner,
            runner::stop_local_runner,
            runner::local_runner_running,
            runner::list_local_runners,
            runner::remove_local_thread,
            repo::inspect_repo,
            secrets::secret_get,
            secrets::secret_set,
            computer::computer_read_file,
            computer::computer_list_dir,
            computer::computer_run_command,
            previews::start_preview_tunnel,
            previews::preview_tunnel_token,
            previews::stop_preview_tunnel,
            skills::list_skills,
            skills::add_skill,
            skills::remove_skill,
            skills::skills_folder,
            skills::read_skill,
            skills::fork_skill,
            skills::export_skills,
            system::detect_agents,
            system::install_agent,
            system::set_keep_awake,
            system::list_editors,
            system::open_in_editor,
            system::local_runner_statuses,
            system::save_text_file,
            history::scan_agent_history,
            history::import_agent_sessions,
            plugins::list_plugins,
            plugins::read_plugin,
            plugins::install_plugin_from_git,
            plugins::install_plugin_from_folder,
            plugins::set_plugin_enabled,
            plugins::update_plugin,
            plugins::remove_plugin,
            plugins::check_plugin_updates,
            plugins::plugins_folder,
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
                app.state::<system::Awake>().release();
            }
            _ => {}
        });
}
