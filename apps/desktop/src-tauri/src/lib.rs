//! LemonLime desktop shell: the window, native dialogs, and the local runner
//! processes that back local threads.

mod paths;
mod repo;
mod runner;
mod secrets;

use tauri::{Manager, RunEvent};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(runner::Runners::default())
        .invoke_handler(tauri::generate_handler![
            runner::start_local_runner,
            runner::stop_local_runner,
            runner::local_runner_running,
            runner::list_local_runners,
            runner::remove_local_thread,
            repo::inspect_repo,
            secrets::secret_get,
            secrets::secret_set,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start LemonLime")
        .run(|app, event| {
            // Never leave runner processes behind when the app quits.
            if let RunEvent::Exit = event {
                app.state::<runner::Runners>().stop_all();
            }
        });
}
