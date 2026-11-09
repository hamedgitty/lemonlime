//! LemonLime desktop shell: the window, native dialogs, and the local runner
//! processes that back local threads.

mod accounts;
mod computer;
mod history;
mod host_terminal;
mod paths;
mod plugins;
mod previews;
mod repo;
mod runner;
mod secrets;
mod skills;
mod ssh;
mod system;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, RunEvent, RESTART_EXIT_CODE};

/// Set once the person has agreed to quit (or restart) while agents were working.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

/// What the window is asked to confirm: quitting, or restarting into an update.
#[derive(Clone, serde::Serialize)]
struct QuitRequest {
    restart: bool,
}

/// The window agreed (or nothing was working): quit, or restart, for real.
#[tauri::command]
fn confirm_quit(app: AppHandle, restart: Option<bool>) {
    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
    if restart.unwrap_or(false) {
        app.request_restart();
    } else {
        app.exit(0);
    }
}

/// Restart into an installed update. A restart can't be held back once it has begun, so
/// with runners alive the window is asked first, the same way a quit is.
#[tauri::command]
fn request_restart(app: AppHandle) {
    if !QUIT_CONFIRMED.load(Ordering::SeqCst) && app.state::<runner::Runners>().any_alive() {
        let _ = app.emit("confirm-quit", QuitRequest { restart: true });
    } else {
        app.request_restart();
    }
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
        .manage(host_terminal::HostTerminals::default())
        .manage(computer::ComputerAccess::default())
        .manage(accounts::AccountLogin::default())
        .invoke_handler(tauri::generate_handler![
            runner::start_local_runner,
            runner::stop_local_runner,
            runner::local_runner_running,
            runner::list_local_runners,
            runner::remove_local_thread,
            ssh::check_ssh_machine,
            ssh::start_ssh_runner,
            ssh::remove_ssh_thread,
            repo::inspect_repo,
            secrets::secret_get,
            secrets::secret_set,
            computer::computer_access_levels,
            computer::computer_set_access,
            computer::computer_read_file,
            computer::computer_list_dir,
            computer::computer_run_command,
            previews::start_preview_tunnel,
            previews::preview_tunnel_token,
            previews::stop_preview_tunnel,
            skills::list_skills,
            skills::add_skill,
            skills::add_skill_files,
            skills::remove_skill,
            skills::skills_folder,
            skills::read_skill,
            skills::fork_skill,
            skills::export_skills,
            system::detect_agents,
            system::install_agent,
            system::agent_models,
            system::sign_out_agent,
            system::set_keep_awake,
            system::list_editors,
            system::open_in_editor,
            system::local_runner_statuses,
            system::save_text_file,
            host_terminal::host_terminal_open,
            host_terminal::host_terminal_write,
            host_terminal::host_terminal_resize,
            host_terminal::host_terminal_close,
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
            accounts::agent_accounts,
            accounts::account_login_start,
            accounts::account_login_input,
            accounts::account_login_cancel,
            confirm_quit,
            request_restart,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start LemonLime")
        .run(|app, event| match event {
            // Quitting (any way but a restart, which request_restart has already asked
            // about) with runners alive: let the window decide (it asks if an agent is
            // mid-turn), unless it already said yes.
            RunEvent::ExitRequested { api, code, .. } => {
                if code != Some(RESTART_EXIT_CODE) && !QUIT_CONFIRMED.load(Ordering::SeqCst) && app.state::<runner::Runners>().any_alive() {
                    api.prevent_exit();
                    let _ = app.emit("confirm-quit", QuitRequest { restart: false });
                }
            }
            // Never leave runner processes behind when the app quits.
            RunEvent::Exit => {
                app.state::<runner::Runners>().stop_all();
                app.state::<previews::Tunnels>().stop_all();
                app.state::<system::Awake>().release();
                app.state::<host_terminal::HostTerminals>().close_all();
                app.state::<accounts::AccountLogin>().stop();
            }
            _ => {}
        });
}
