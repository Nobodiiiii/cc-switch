//! Route Matrix: isolated Codex routing, configuration and connection lifecycle.
//! Integration points deliberately use the upstream provider/forwarder interfaces.
mod connection;
#[cfg(test)]
mod tests;

use crate::{database::Database, provider::Provider, proxy::ProxyError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub use connection::*;
pub const CONFIG_KEY: &str = "route_matrix_v1";
pub const MARKER: &str = "x-cc-switch-route-matrix";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatrixConfig {
    pub version: u32,
    pub enabled: bool,
    pub primary: Route,
    pub secondary: Vec<Route>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Route {
    pub id: String,
    pub name: String,
    /// Empty only on the primary route. Namespace ownership is permanent.
    pub prefix: String,
    pub active_provider_id: String,
    pub failover: bool,
    pub policy: Policy,
    pub models: Vec<Model>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub max_retries: u32,
    pub first_byte_timeout: u32,
    pub idle_timeout: u32,
    pub request_timeout: u32,
    pub failure_threshold: u32,
    pub cooldown_seconds: u32,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            max_retries: 2,
            first_byte_timeout: 60,
            idle_timeout: 120,
            request_timeout: 120,
            failure_threshold: 3,
            cooldown_seconds: 60,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_provider_id: Option<String>,
    pub targets: Vec<Target>,
    /// Optional native Codex metadata overrides, never used for routing.
    #[serde(default)]
    pub catalog: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub provider_id: String,
    pub model: String,
}

fn invalid(message: impl Into<String>) -> ProxyError {
    ProxyError::ConfigError(message.into())
}

pub fn load(db: &Database) -> Result<MatrixConfig, ProxyError> {
    match db
        .get_setting(CONFIG_KEY)
        .map_err(|e| invalid(e.to_string()))?
    {
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|e| invalid(format!("路由矩阵配置无效: {e}")))
        }
        None => Ok(MatrixConfig {
            version: 1,
            primary: Route {
                id: "main".into(),
                name: "主路由".into(),
                ..Route::default()
            },
            ..MatrixConfig::default()
        }),
    }
}

impl MatrixConfig {
    pub fn validate(&self, providers: &indexmap::IndexMap<String, Provider>) -> Result<(), String> {
        if self.version != 1 {
            return Err("不支持的路由矩阵配置版本".into());
        }
        if !self.primary.prefix.is_empty() || self.primary.failover {
            return Err("主路由必须不带前缀，并使用手动切换".into());
        }
        if self.enabled && self.primary.models.is_empty() {
            return Err("请先添加主路由模型".into());
        }
        let mut ids = HashSet::new();
        let mut prefixes = HashSet::new();
        let mut published = HashSet::new();
        for (i, route) in std::iter::once(&self.primary)
            .chain(&self.secondary)
            .enumerate()
        {
            if !slug(&route.id) || !ids.insert(&route.id) {
                return Err("路由 ID 必须唯一，只含小写字母、数字和短横线".into());
            }
            if i > 0
                && (!slug(&route.prefix)
                    || route.prefix.starts_with("ccs-")
                    || !prefixes.insert(&route.prefix))
            {
                return Err(
                    "副路由前缀必须唯一，只含小写字母、数字和短横线，且不能以 ccs- 开头".into(),
                );
            }
            if route.policy.failure_threshold == 0
                || route.policy.max_retries > 20
                || route.policy.cooldown_seconds > 86400
                || [
                    route.policy.first_byte_timeout,
                    route.policy.idle_timeout,
                    route.policy.request_timeout,
                ]
                .iter()
                .any(|v| *v > 86400)
            {
                return Err("重试上限为 20，失败阈值至少为 1，超时和冷却上限为 86400 秒".into());
            }
            let mut model_ids = HashSet::new();
            for model in &route.models {
                if model.id.trim() != model.id
                    || model.id.is_empty()
                    || model.id.starts_with("ccs-")
                    || model.id.starts_with("rm-")
                    || !model_ids.insert(&model.id)
                {
                    return Err("模型 ID 不能为空、重复或使用保留的 ccs-/rm- 前缀".into());
                }
                if !published.insert(route.model_id(model)) {
                    return Err("发布的模型 ID 冲突".into());
                }
                let mut target_ids = HashSet::new();
                if model.targets.is_empty() {
                    return Err(format!("模型 {} 没有上游", model.id));
                }
                for target in &model.targets {
                    let provider = providers
                        .get(&target.provider_id)
                        .ok_or_else(|| format!("供应商不存在: {}", target.provider_id))?;
                    if target.model.trim().is_empty() || !target_ids.insert(&target.provider_id) {
                        return Err("上游模型不能为空，同一模型不能重复添加供应商".into());
                    }
                    if crate::proxy::providers::is_codex_official_provider(provider)
                        && provider
                            .meta
                            .as_ref()
                            .and_then(|m| m.managed_account_id_for("codex_oauth"))
                            .filter(|id| !id.trim().is_empty())
                            .is_none()
                    {
                        return Err(format!(
                            "官方供应商 {} 必须绑定 CC Switch 中的具体 ChatGPT 账号，才能热切换",
                            provider.name
                        ));
                    }
                }
                let active = model
                    .active_provider_id
                    .as_ref()
                    .unwrap_or(&route.active_provider_id);
                if !target_ids.contains(active) {
                    return Err(format!(
                        "模型 {} 未配置当前供应商 {} 的映射",
                        model.id, active
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn catalog(&self) -> Value {
        let template: Value = serde_json::from_str(include_str!(
            "../resources/codex_native_responses_template.json"
        ))
        .expect("bundled template");
        let mut rows = Vec::new();
        for route in std::iter::once(&self.primary).chain(&self.secondary) {
            for model in &route.models {
                let id = route.model_id(model);
                let mut row = template.clone();
                // Default to conservative capabilities; metadata can be explicitly supplied.
                row["input_modalities"] = json!(["text"]);
                for (key, value) in &model.catalog {
                    row[key] = value.clone();
                }
                row["slug"] = json!(id);
                row["display_name"] = json!(if route.prefix.is_empty() {
                    model.id.clone()
                } else {
                    format!("{} · {}", route.name, model.id)
                });
                row["description"] = json!(format!("Route Matrix / {}", route.name));
                rows.push(row);
            }
        }
        json!({"models": rows})
    }

    pub fn resolve(
        &self,
        model: &str,
        providers: &indexmap::IndexMap<String, Provider>,
        runtime: Arc<Runtime>,
    ) -> Result<Execution, ProxyError> {
        if !self.enabled {
            return Err(invalid("路由矩阵尚未启用"));
        }
        let (route, entry) = std::iter::once(&self.primary)
            .chain(&self.secondary)
            .find_map(|r| {
                r.models
                    .iter()
                    .find(|m| r.model_id(m) == model)
                    .map(|m| (r, m))
            })
            .ok_or_else(|| {
                ProxyError::InvalidRequest(format!("路由矩阵模型未配置或已移除: {model}"))
            })?;
        let selected = entry
            .targets
            .iter()
            .find(|t| {
                t.provider_id
                    == *entry
                        .active_provider_id
                        .as_ref()
                        .unwrap_or(&route.active_provider_id)
            })
            .ok_or_else(|| invalid("当前供应商没有此模型，拒绝跨路由回落"))?;
        let targets: Vec<_> = std::iter::once(selected)
            .chain(
                entry
                    .targets
                    .iter()
                    .filter(|t| route.failover && t.provider_id != selected.provider_id),
            )
            .cloned()
            .collect();
        // Deleted providers fail closed. Never silently select the next account.
        for target in &targets {
            if let Some(provider) = providers.get(&target.provider_id) {
                // Provider cards can be edited independently after matrix save.
                // Do not silently use the OAuth manager's default account.
                if crate::proxy::providers::is_codex_official_provider(provider)
                    && provider
                        .meta
                        .as_ref()
                        .and_then(|m| m.managed_account_id_for("codex_oauth"))
                        .filter(|id| !id.trim().is_empty())
                        .is_none()
                {
                    return Err(ProxyError::AuthError(format!(
                        "官方供应商 {} 的账号绑定已失效",
                        provider.name
                    )));
                }
            } else {
                return Err(invalid(format!(
                    "路由引用的供应商已删除: {}",
                    target.provider_id
                )));
            }
        }
        let scope = serde_json::to_string(route).map_err(|e| invalid(e.to_string()))?;
        let selected_providers = targets
            .iter()
            .filter_map(|t| providers.get(&t.provider_id).cloned())
            .collect();
        Ok(Execution {
            targets,
            selected_providers,
            policy: route.policy.clone(),
            failover: route.failover,
            scope,
            runtime,
        })
    }
}

fn slug(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Route {
    fn model_id(&self, model: &Model) -> String {
        if self.prefix.is_empty() {
            model.id.clone()
        } else {
            format!("rm-{}/{}", self.prefix, model.id)
        }
    }
}

#[derive(Default, Debug)]
pub struct Runtime {
    health: Mutex<HashMap<(String, String), Health>>,
}
#[derive(Default, Debug)]
struct Health {
    failures: u32,
    retry_at: Option<Instant>,
}

#[derive(Clone)]
pub struct Execution {
    pub targets: Vec<Target>,
    selected_providers: Vec<Provider>,
    pub policy: Policy,
    pub failover: bool,
    scope: String,
    runtime: Arc<Runtime>,
}

impl Execution {
    pub fn providers(&self) -> Vec<Provider> {
        self.selected_providers.clone()
    }
    pub fn upstream(&self, id: &str) -> Option<&str> {
        self.targets
            .iter()
            .find(|t| t.provider_id == id)
            .map(|t| t.model.as_str())
    }
    pub fn allow(&self, id: &str) -> bool {
        if !self.failover {
            return true;
        }
        let mut health = self
            .runtime
            .health
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let h = health.entry((self.scope.clone(), id.into())).or_default();
        // A failed provider becomes eligible again after its route's cooldown.
        h.retry_at.is_none_or(|at| at <= Instant::now())
    }
    pub fn record(&self, id: &str, success: bool) {
        if !self.failover {
            return;
        }
        let mut health = self
            .runtime
            .health
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Bound stale configuration generations without affecting active requests.
        if health.len() > 4096 {
            health.retain(|_, h| h.retry_at.is_some_and(|at| at > Instant::now()));
        }
        let h = health.entry((self.scope.clone(), id.into())).or_default();
        if success {
            *h = Health::default();
        } else {
            h.failures = h.failures.saturating_add(1);
            if h.failures >= self.policy.failure_threshold {
                h.retry_at =
                    Some(Instant::now() + Duration::from_secs(self.policy.cooldown_seconds.into()));
            }
        }
    }
}
