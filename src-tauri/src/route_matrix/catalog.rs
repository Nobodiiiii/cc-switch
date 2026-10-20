//! Codex bounds JSON model-catalog responses to 1 MiB. Normalized official
//! rows contain both legacy base_instructions and the equivalent modern
//! model_messages.instructions_template. Only remove that proven duplicate;
//! retain the complete modern instructions and all capability/policy metadata.
use super::*;

pub(super) const MAX_BYTES: usize = 1024 * 1024;

fn byte_len(catalog: &Value) -> usize {
    serde_json::to_vec(catalog).map_or(usize::MAX, |bytes| bytes.len())
}

pub(super) fn compact(catalog: &mut Value) {
    if byte_len(catalog) <= MAX_BYTES {
        return;
    }
    if let Some(rows) = catalog.get_mut("models").and_then(Value::as_array_mut) {
        for row in rows {
            let duplicate = row
                .get("base_instructions")
                .and_then(Value::as_str)
                .zip(
                    row.get("model_messages")
                        .and_then(|messages| messages.get("instructions_template"))
                        .and_then(Value::as_str),
                )
                .is_some_and(|(legacy, modern)| legacy == modern);
            if duplicate {
                row.as_object_mut()
                    .expect("model object")
                    .remove("base_instructions");
            }
        }
    }
}

pub(super) fn ensure_size(catalog: &Value) -> Result<(), String> {
    let size = byte_len(catalog);
    if size > MAX_BYTES {
        return Err(format!(
            "模型目录精简后仍有 {size} 字节，超过 Codex 的 1 MiB 上限。请为部分副路由配置所需模型映射，减少发布的模型；原配置未更改。"
        ));
    }
    Ok(())
}
