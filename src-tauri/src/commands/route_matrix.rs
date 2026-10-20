use crate::{
    route_matrix::{self, MatrixConfig},
    store::AppState,
};

#[tauri::command]
pub fn get_route_matrix(state: tauri::State<'_, AppState>) -> Result<MatrixConfig, String> {
    route_matrix::load(&state.db).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_route_matrix(
    state: tauri::State<'_, AppState>,
    mut config: MatrixConfig,
) -> Result<(), String> {
    let _guard = route_matrix::WRITE_LOCK.lock().await;
    // Connection lifecycle alone controls enabled; editing cannot bypass setup.
    config.enabled = route_matrix::load(&state.db)
        .map_err(|e| e.to_string())?
        .enabled;
    route_matrix::save(&state.db, &config)
}

#[tauri::command]
pub async fn connect_route_matrix(
    state: tauri::State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let _guard = route_matrix::WRITE_LOCK.lock().await;
    route_matrix::connect(state.inner(), enabled).await
}
