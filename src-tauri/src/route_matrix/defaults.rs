//! Empty mappings use the same official model definitions as upstream Codex
//! routing. Keep generated defaults out of the saved configuration so updates
//! to the official catalog take effect without rewriting user settings.
use super::*;

pub(super) fn rows() -> Vec<Value> {
    crate::codex_config::codex_official_models_for_routing()
        .into_iter()
        .filter(|row| {
            row.get("slug").and_then(Value::as_str).is_some_and(|id| {
                !id.is_empty()
                    && id.trim() == id
                    && !id.starts_with("rm-")
                    && !id.starts_with("ccs-")
            })
        })
        .collect()
}

pub(super) fn model(route: &Route, id: &str) -> Option<Model> {
    if !route.models.is_empty() || !rows().iter().any(|row| row["slug"].as_str() == Some(id)) {
        return None;
    }
    let members = route.member_ids();
    if members.is_empty() {
        return None;
    }
    Some(Model {
        id: id.into(),
        active_provider_id: None,
        targets: members
            .into_iter()
            .map(|provider_id| Target {
                provider_id,
                model: id.into(),
            })
            .collect(),
        catalog: BTreeMap::new(),
    })
}

pub(super) fn initial_model(config: &MatrixConfig, original: &str) -> Result<String, String> {
    if let Some(model) = config.primary.models.first() {
        return Ok(model.id.clone());
    }
    let rows = rows();
    let original_model = original.parse::<toml::Value>().ok().and_then(|doc| {
        doc.get("model")
            .and_then(toml::Value::as_str)
            .map(str::to_owned)
    });
    if let Some(model) = original_model {
        if rows
            .iter()
            .any(|row| row["slug"].as_str() == Some(model.as_str()))
        {
            return Ok(model);
        }
    }
    rows.iter()
        .find(|row| row["visibility"].as_str() == Some("list"))
        .or_else(|| rows.first())
        .and_then(|row| row["slug"].as_str())
        .map(str::to_owned)
        .ok_or_else(|| "官方默认模型目录为空，请更新 Codex 或手动配置模型映射".into())
}
