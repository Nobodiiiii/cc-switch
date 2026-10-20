use super::*;
use crate::proxy::server::ProxyState;
use crate::store::AppState;
use axum::{
    extract::{Request, State},
    middleware::Next,
    response::{IntoResponse, Response},
};
use toml_edit::{value, DocumentMut, Item, Table};

const TOKEN_KEY: &str = "route_matrix_connection_token_v1";
const BACKUP_KEY: &str = "route_matrix_client_backup_v1";
const INSTALLED_KEY: &str = "route_matrix_client_installed_v1";
const PREFIX_KEY: &str = "route_matrix_prefix_owners_v1";
pub static WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn save(db: &Database, config: &MatrixConfig) -> Result<(), String> {
    let providers = db.get_all_providers("codex").map_err(|e| e.to_string())?;
    config.validate(&providers)?;
    // Keep removed namespaces reserved: old conversations must never change owner.
    let mut owners: BTreeMap<String, String> = db
        .get_setting(PREFIX_KEY)
        .map_err(|e| e.to_string())?
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(|e| format!("前缀登记簿损坏: {e}"))?
        .unwrap_or_default();
    for route in &config.secondary {
        if owners
            .get(&route.prefix)
            .is_some_and(|owner| owner != &route.id)
        {
            return Err(format!(
                "前缀 {} 曾属于其他路由，不能重新分配",
                route.prefix
            ));
        }
        owners.insert(route.prefix.clone(), route.id.clone());
    }
    // Reserving a prefix before saving the config is intentionally fail safe.
    db.set_setting(
        PREFIX_KEY,
        &serde_json::to_string(&owners).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    db.set_setting(
        CONFIG_KEY,
        &serde_json::to_string(config).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn authorize(db: &Database, headers: &http::HeaderMap) -> Result<(), ProxyError> {
    let token = db
        .get_setting(TOKEN_KEY)
        .map_err(|e| invalid(e.to_string()))?
        .ok_or_else(|| ProxyError::AuthError("路由矩阵连接尚未建立".into()))?;
    if headers
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        != Some(format!("Bearer {token}").as_str())
    {
        return Err(ProxyError::AuthError("路由矩阵连接令牌无效".into()));
    }
    if !load(db)?.enabled {
        return Err(invalid("路由矩阵已停用"));
    }
    Ok(())
}

/// Namespace middleware marks only authenticated matrix requests. The regular
/// upstream route/stack paths and their state remain independent.
pub async fn middleware(
    State(state): State<ProxyState>,
    mut request: Request,
    next: Next,
) -> Response {
    if let Err(error) = authorize(&state.db, request.headers()) {
        return error.into_response();
    }
    request
        .headers_mut()
        .insert(MARKER, http::HeaderValue::from_static("1"));
    next.run(request).await
}

pub fn client_config(
    original: &str,
    origin: &str,
    token: &str,
    model: &str,
) -> Result<String, String> {
    let mut doc = original
        .parse::<DocumentMut>()
        .map_err(|e| format!("Codex 配置无效: {e}"))?;
    doc["model_provider"] = value("cc_switch_matrix");
    doc["model"] = value(model);
    doc.remove("model_catalog_json"); // Static catalogs disable runtime discovery.
    if doc.get("model_providers").is_none() {
        doc["model_providers"] = Item::Table(Table::new());
    }
    let mut provider = Table::new();
    provider["name"] = value("CC Switch · Route Matrix");
    provider["base_url"] = value(format!("{origin}/route-matrix/v1"));
    provider["wire_api"] = value("responses");
    provider["requires_openai_auth"] = value(false);
    provider["experimental_bearer_token"] = value(token);
    provider["model_catalog_url"] = value(format!("{origin}/route-matrix/v1/models"));
    provider["supports_websockets"] = value(false);
    doc["model_providers"]["cc_switch_matrix"] = Item::Table(provider);
    Ok(doc.to_string())
}

/// Restore only our connection fields. User edits to projects, tools, MCP and
/// other providers survive disconnect. If the user already chose a different
/// connection, leave that choice intact.
pub fn restore_client_config(current: &str, backup: &str) -> Result<String, String> {
    let mut doc = current.parse::<DocumentMut>().map_err(|e| e.to_string())?;
    if doc.get("model_provider").and_then(Item::as_str) != Some("cc_switch_matrix") {
        return Ok(current.into());
    }
    let before = backup.parse::<DocumentMut>().map_err(|e| e.to_string())?;
    for key in ["model", "model_provider", "model_catalog_json"] {
        if let Some(item) = before.get(key) {
            doc[key] = item.clone();
        } else {
            doc.remove(key);
        }
    }
    if let Some(providers) = doc
        .get_mut("model_providers")
        .and_then(Item::as_table_like_mut)
    {
        if let Some(item) = before
            .get("model_providers")
            .and_then(|p| p.get("cc_switch_matrix"))
        {
            providers.insert("cc_switch_matrix", item.clone());
        } else {
            providers.remove("cc_switch_matrix");
        }
    }
    Ok(doc.to_string())
}

pub async fn connect(state: &AppState, enabled: bool) -> Result<(), String> {
    let mut config = load(&state.db).map_err(|e| e.to_string())?;
    let path = crate::codex_config::get_codex_config_path();
    if !enabled {
        let backup = state
            .db
            .get_setting(BACKUP_KEY)
            .map_err(|e| e.to_string())?;
        let current = crate::codex_config::read_codex_config_text().map_err(|e| e.to_string())?;
        if let Some(backup) = backup {
            let restored = restore_client_config(&current, &backup)?;
            crate::config::write_text_file_private(&path, &restored).map_err(|e| e.to_string())?;
        }
        config.enabled = false;
        // Disconnect must still work if a referenced provider was deleted.
        return state
            .db
            .set_setting(
                CONFIG_KEY,
                &serde_json::to_string(&config).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string());
    }
    config.enabled = true;
    config.validate(
        &state
            .db
            .get_all_providers("codex")
            .map_err(|e| e.to_string())?,
    )?;
    // Let upstream restore its managed connection before installing ours.
    if state.proxy_service.get_takeover_status().await?.codex {
        crate::mode::controller::exit(state, &crate::app_config::AppType::Codex).await?;
    }
    let info = state.proxy_service.start().await?;
    let token = state
        .db
        .get_setting(TOKEN_KEY)
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let original = crate::codex_config::read_codex_config_text().map_err(|e| e.to_string())?;
    let is_matrix = original
        .parse::<DocumentMut>()
        .map_err(|e| e.to_string())?
        .get("model_provider")
        .and_then(Item::as_str)
        == Some("cc_switch_matrix");
    if !is_matrix
        || state
            .db
            .get_setting(BACKUP_KEY)
            .map_err(|e| e.to_string())?
            .is_none()
    {
        state
            .db
            .set_setting(BACKUP_KEY, &original)
            .map_err(|e| e.to_string())?;
    }
    let origin = crate::services::proxy::proxy_origin(&info.address, info.port);
    let next = client_config(&original, &origin, &token, &config.primary.models[0].id)?;
    state
        .db
        .set_setting(TOKEN_KEY, &token)
        .map_err(|e| e.to_string())?;
    // Config is valid before any client file is changed. Runtime saves are one
    // settings-row replacement; in-flight requests retain their own snapshot.
    save(&state.db, &config)?;
    state
        .db
        .set_setting(INSTALLED_KEY, &next)
        .map_err(|e| e.to_string())?;
    if let Err(error) = crate::config::write_text_file_private(&path, &next) {
        config.enabled = false;
        let _ = save(&state.db, &config);
        return Err(error.to_string());
    }
    state
        .db
        .set_setting(INSTALLED_KEY, &next)
        .map_err(|e| e.to_string())
}

pub async fn startup(state: &AppState) {
    if load(&state.db).is_ok_and(|c| c.enabled) {
        if let Err(error) = state.proxy_service.start().await {
            log::error!("[Route Matrix] 无法恢复代理服务: {error}");
        }
    }
}
