use super::*;
use indexmap::IndexMap;

fn provider(id: &str) -> Provider {
    Provider::with_id(
        id.into(),
        id.into(),
        json!({"base_url":"https://example.invalid/v1", "auth":{"OPENAI_API_KEY":"test"}}),
        None,
    )
}
fn fixture() -> (MatrixConfig, IndexMap<String, Provider>) {
    let all = [provider("a"), provider("b")]
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect();
    let targets = vec![
        Target {
            provider_id: "a".into(),
            model: "actual-a".into(),
        },
        Target {
            provider_id: "b".into(),
            model: "actual-b".into(),
        },
    ];
    let main = Route {
        id: "main".into(),
        name: "主路由".into(),
        active_provider_id: "a".into(),
        models: vec![Model {
            id: "gpt-test".into(),
            active_provider_id: None,
            targets,
            catalog: BTreeMap::new(),
        }],
        ..Route::default()
    };
    let secondary = Route {
        id: "backup".into(),
        prefix: "backup".into(),
        failover: true,
        policy: Policy {
            failure_threshold: 1,
            ..Policy::default()
        },
        ..main.clone()
    };
    (
        MatrixConfig {
            version: 1,
            enabled: true,
            primary: main,
            secondary: vec![secondary],
        },
        all,
    )
}

#[test]
fn manual_primary_and_prefixed_secondary_are_disjoint() {
    let (mut config, all) = fixture();
    config.validate(&all).unwrap();
    let runtime = Arc::new(Runtime::default());
    assert_eq!(
        config
            .resolve("gpt-test", &all, runtime.clone())
            .unwrap()
            .targets
            .len(),
        1
    );
    assert_eq!(
        config
            .resolve("rm-backup/gpt-test", &all, runtime.clone())
            .unwrap()
            .targets
            .len(),
        2
    );
    config.primary.active_provider_id = "b".into();
    assert_eq!(
        config
            .resolve("gpt-test", &all, runtime.clone())
            .unwrap()
            .upstream("b"),
        Some("actual-b")
    );
    assert_eq!(
        config
            .resolve("rm-backup/gpt-test", &all, runtime)
            .unwrap()
            .targets[0]
            .provider_id,
        "a"
    );
}

#[test]
fn removed_unknown_and_malformed_models_never_fall_back() {
    let (mut config, mut all) = fixture();
    let runtime = Arc::new(Runtime::default());
    for model in [
        "rm-missing/gpt-test",
        "rm-backup/",
        "unknown",
        "ccs-test/gpt-test",
    ] {
        assert!(config.resolve(model, &all, runtime.clone()).is_err());
    }
    all.shift_remove("a");
    assert!(config.resolve("gpt-test", &all, runtime.clone()).is_err());
    all.insert("a".into(), provider("a"));
    config.secondary.clear();
    assert!(config.resolve("rm-backup/gpt-test", &all, runtime).is_err());
}

#[test]
fn official_account_binding_is_required_at_save_and_at_request_time() {
    use crate::provider::{AuthBinding, AuthBindingSource, ProviderMeta};
    let (mut config, mut all) = fixture();
    let mut official = Provider::with_id(
        "official".into(),
        "Official".into(),
        json!({"auth":{}, "config":""}),
        None,
    );
    official.category = Some("official".into());
    config.primary.active_provider_id = "official".into();
    config.primary.models[0].targets = vec![Target {
        provider_id: "official".into(),
        model: "native-model".into(),
    }];
    all.insert("official".into(), official.clone());
    assert!(config.validate(&all).is_err());
    official.meta = Some(ProviderMeta {
        provider_type: Some("codex_oauth".into()),
        auth_binding: Some(AuthBinding {
            source: AuthBindingSource::ManagedAccount,
            auth_provider: Some("codex_oauth".into()),
            account_id: Some("account-a".into()),
        }),
        ..Default::default()
    });
    all.insert("official".into(), official.clone());
    config.validate(&all).unwrap();
    assert!(config.resolve("gpt-test", &all, Arc::default()).is_ok());
    official.meta.as_mut().unwrap().auth_binding = None;
    all.insert("official".into(), official);
    assert!(matches!(
        config.resolve("gpt-test", &all, Arc::default()),
        Err(ProxyError::AuthError(_))
    ));
}

#[test]
fn breakers_are_route_local_and_configuration_changes_take_effect() {
    let (mut config, all) = fixture();
    let runtime = Arc::new(Runtime::default());
    let old = config
        .resolve("rm-backup/gpt-test", &all, runtime.clone())
        .unwrap();
    old.record("a", false);
    assert!(!old.allow("a"));
    assert!(config
        .resolve("gpt-test", &all, runtime.clone())
        .unwrap()
        .allow("a"));
    let mut second = config.secondary[0].clone();
    second.id = "another".into();
    second.prefix = "another".into();
    config.secondary.push(second);
    assert!(config
        .resolve("rm-another/gpt-test", &all, runtime.clone())
        .unwrap()
        .allow("a"));
    config.secondary[0].policy.cooldown_seconds = 0;
    assert!(config
        .resolve("rm-backup/gpt-test", &all, runtime)
        .unwrap()
        .allow("a"));
    assert!(!old.allow("a")); // In-flight snapshots remain stable.
}

#[test]
fn multiple_official_members_are_selected_manually_and_validated_as_a_group() {
    use crate::provider::{AuthBinding, AuthBindingSource, ProviderMeta};
    let (mut config, mut all) = fixture();
    for id in ["official-a", "official-b"] {
        let mut row =
            Provider::with_id(id.into(), id.into(), json!({"auth":{}, "config":""}), None);
        row.category = Some("official".into());
        row.meta = Some(ProviderMeta {
            auth_binding: Some(AuthBinding {
                source: AuthBindingSource::ManagedAccount,
                auth_provider: Some("codex_oauth".into()),
                account_id: Some(format!("account-{id}")),
            }),
            ..Default::default()
        });
        all.insert(id.into(), row);
    }
    config.primary.provider_ids = vec!["official-a".into(), "official-b".into()];
    config.primary.active_provider_id = "official-a".into();
    config.primary.models[0].targets = config
        .primary
        .provider_ids
        .iter()
        .map(|id| Target {
            provider_id: id.clone(),
            model: "native-model".into(),
        })
        .collect();
    config.validate(&all).unwrap();
    let runtime = Arc::new(Runtime::default());
    let old = config.resolve("gpt-test", &all, runtime.clone()).unwrap();
    old.record("official-a", false);
    assert_eq!(old.targets.len(), 1, "main route never rotates accounts");
    config.primary.active_provider_id = "official-b".into();
    let new = config.resolve("gpt-test", &all, runtime).unwrap();
    assert_eq!(
        old.targets[0].provider_id, "official-a",
        "in-flight snapshot retained"
    );
    assert_eq!(new.targets[0].provider_id, "official-b");
    assert_eq!(config.secondary[0].active_provider_id, "a");
    config.primary.provider_ids.remove(0);
    assert!(
        config.validate(&all).is_err(),
        "mapping outside membership rejected"
    );
    config.primary.models.clear();
    config.enabled = false;
    all.get_mut("official-b").unwrap().meta = None;
    assert!(
        config.validate(&all).is_err(),
        "even unused members need a concrete account"
    );
}

#[test]
fn validation_rejects_ambiguous_or_unsafe_configuration() {
    let (config, all) = fixture();
    let mut bad = config.clone();
    bad.primary.failover = true;
    assert!(bad.validate(&all).is_err());
    let mut bad = config.clone();
    bad.secondary.push(bad.secondary[0].clone());
    assert!(bad.validate(&all).is_err());
    let mut bad = config.clone();
    bad.primary.models[0].targets.pop();
    bad.primary.active_provider_id = "b".into();
    assert!(bad.validate(&all).is_err());
    let mut bad = config.clone();
    bad.primary.models[0].id = "rm-backup/gpt-test".into();
    assert!(bad.validate(&all).is_err());
    let mut bad = config;
    bad.primary.models[0].targets[0].model = "".into();
    assert!(bad.validate(&all).is_err());
}

#[test]
fn prefix_validation_reports_the_specific_problem_and_preserves_the_saved_route() {
    let (config, all) = fixture();
    let db = Database::memory().unwrap();
    for provider in all.values() {
        db.save_provider("codex", provider).unwrap();
    }
    save(&db, &config).unwrap();
    for (prefix, error) in [
        ("", "不能为空"),
        ("Any", "只允许小写字母"),
        ("any/", "只允许小写字母"),
        ("ccs-any", "不能以保留的 ccs- 开头"),
        (&"a".repeat(49), "最多 48 个字符"),
    ] {
        let mut invalid = config.clone();
        invalid.secondary[0].prefix = prefix.into();
        assert!(save(&db, &invalid).unwrap_err().contains(error));
        assert_eq!(load(&db).unwrap().secondary[0].prefix, "backup");
    }
    let mut duplicate = config.clone();
    let mut other = duplicate.secondary[0].clone();
    other.id = "other".into();
    duplicate.secondary.push(other);
    assert!(save(&db, &duplicate)
        .unwrap_err()
        .contains("已被其他路由使用"));
    let mut valid = config;
    valid.secondary[0].prefix = "any-2".into();
    save(&db, &valid).unwrap();
    let mut reopened = load(&db).unwrap();
    assert_eq!(reopened.secondary[0].prefix, "any-2");
    reopened.secondary[0].policy.cooldown_seconds = 30;
    save(&db, &reopened).unwrap();
    assert_eq!(load(&db).unwrap().secondary[0].policy.cooldown_seconds, 30);
}

#[test]
fn empty_mappings_use_official_models_with_same_name_targets_and_isolated_namespaces() {
    let (mut config, all) = fixture();
    config.primary.models.clear();
    config.primary.provider_ids = vec!["a".into(), "b".into()];
    config.secondary[0].models.clear();
    config.secondary[0].provider_ids = vec!["b".into(), "a".into()];
    config.secondary[0].active_provider_id = "b".into();
    config.validate(&all).unwrap();
    let official = defaults::rows();
    assert!(!official.is_empty());
    let id = official[0]["slug"].as_str().unwrap();
    let catalog = config.catalog();
    let rows = catalog["models"].as_array().unwrap();
    assert_eq!(rows.len(), official.len() * 2);
    let main = rows.iter().find(|row| row["slug"] == id).unwrap();
    assert_eq!(*main, official[0], "official capabilities are preserved");
    let runtime = Arc::new(Runtime::default());
    let old = config.resolve(id, &all, runtime.clone()).unwrap();
    assert_eq!(old.targets.len(), 1, "main remains manual");
    assert_eq!(old.upstream("a"), Some(id));
    let secondary = config
        .resolve(&format!("rm-backup/{id}"), &all, runtime.clone())
        .unwrap();
    assert_eq!(secondary.targets.len(), 2);
    assert_eq!(secondary.upstream("b"), Some(id));
    secondary.record("b", false);
    assert!(!secondary.allow("b"));
    config.primary.active_provider_id = "b".into();
    let switched = config.resolve(id, &all, runtime.clone()).unwrap();
    assert_eq!(switched.upstream("b"), Some(id));
    assert!(switched.allow("b"));
    assert_eq!(old.upstream("a"), Some(id), "in-flight snapshot retained");
    for unknown in [
        format!("rm-missing/{id}"),
        "rm-backup/".into(),
        "ccs-any/model".into(),
        "unknown-model".into(),
    ] {
        assert!(config.resolve(&unknown, &all, runtime.clone()).is_err());
    }
    config.secondary.clear();
    assert!(config
        .resolve(&format!("rm-backup/{id}"), &all, runtime)
        .is_err());
}

#[test]
fn empty_mappings_are_optional_but_still_require_a_valid_provider_and_account() {
    let (mut config, mut all) = fixture();
    config.primary.models.clear();
    config.primary.provider_ids.clear();
    // Legacy configurations still have a selected provider without providerIds.
    config.validate(&all).unwrap();
    assert!(!config.catalog()["models"].as_array().unwrap().is_empty());
    let model = defaults::initial_model(&config, "model = 'no-longer-published'").unwrap();
    assert_eq!(
        defaults::initial_model(&config, &format!("model = '{model}'")).unwrap(),
        model
    );
    assert!(config.resolve(&model, &all, Arc::default()).is_ok());
    all.get_mut("a").unwrap().category = Some("official".into());
    assert!(config.validate(&all).unwrap_err().contains("必须绑定"));
    all.get_mut("a").unwrap().category = None;
    config.primary.active_provider_id.clear();
    assert!(config.validate(&all).unwrap_err().contains("选择供应商"));
    config.enabled = false;
    config.validate(&all).unwrap();
    assert!(
        config.primary.models.is_empty(),
        "defaults are never persisted as explicit mappings"
    );
}

#[test]
fn explicit_mappings_override_defaults_and_can_hot_reload_back_to_official_models() {
    let (mut config, all) = fixture();
    let id = defaults::rows()[0]["slug"].as_str().unwrap().to_owned();
    assert!(config.resolve(&id, &all, Arc::default()).is_err());
    config.primary.models[0].id = id.clone();
    assert_eq!(
        config
            .resolve(&id, &all, Arc::default())
            .unwrap()
            .upstream("a"),
        Some("actual-a")
    );
    config.primary.provider_ids = vec!["a".into(), "b".into()];
    config.primary.models.clear();
    assert_eq!(
        config
            .resolve(&id, &all, Arc::default())
            .unwrap()
            .upstream("a"),
        Some(id.as_str())
    );
    assert!(config.resolve("gpt-test", &all, Arc::default()).is_err());
}

#[test]
fn catalog_and_request_routing_share_the_same_ids() {
    let (config, all) = fixture();
    let catalog = config.catalog();
    let rows = catalog["models"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    for row in rows {
        assert!(config
            .resolve(row["slug"].as_str().unwrap(), &all, Arc::default())
            .is_ok());
    }
}

#[test]
fn connection_uses_dynamic_catalog_and_preserves_unrelated_config() {
    let original = "model_catalog_json = 'old.json'\nmodel_provider = 'old'\n[projects.'D:/work']\ntrust_level = 'trusted'\n";
    let text = client_config(
        original,
        "http://127.0.0.1:1234",
        "test-local-token",
        "gpt-test",
    )
    .unwrap();
    let doc: toml::Value = toml::from_str(&text).unwrap();
    assert!(doc.get("model_catalog_json").is_none());
    assert_eq!(
        doc["projects"]["D:/work"]["trust_level"].as_str(),
        Some("trusted")
    );
    assert_eq!(
        doc["model_providers"]["cc_switch_matrix"]["model_catalog_url"].as_str(),
        Some("http://127.0.0.1:1234/route-matrix/v1/models")
    );
    assert_eq!(
        doc["model_providers"]["cc_switch_matrix"]["requires_openai_auth"].as_bool(),
        Some(false)
    );
}

#[test]
fn individual_primary_models_can_select_different_suppliers_manually() {
    let (mut config, all) = fixture();
    let mut pinned = config.primary.models[0].clone();
    pinned.id = "other-model".into();
    pinned.active_provider_id = Some("b".into());
    config.primary.models.push(pinned);
    config.validate(&all).unwrap();
    assert_eq!(
        config
            .resolve("other-model", &all, Arc::default())
            .unwrap()
            .targets[0]
            .provider_id,
        "b"
    );
    assert_eq!(
        config
            .resolve("gpt-test", &all, Arc::default())
            .unwrap()
            .targets[0]
            .provider_id,
        "a"
    );
}

#[test]
fn disconnect_preserves_user_edits_and_another_selected_connection() {
    let before =
        "model = 'old-model'\nmodel_provider = 'old-provider'\nmodel_catalog_json = 'old.json'\n";
    let installed = client_config(before, "http://127.0.0.1:1234", "test", "new-model").unwrap();
    let edited = format!("{installed}\n[projects.'D:/new-project']\ntrust_level = 'trusted'\n");
    let restored = restore_client_config(&edited, before).unwrap();
    let doc: toml::Value = toml::from_str(&restored).unwrap();
    assert_eq!(doc["model_provider"].as_str(), Some("old-provider"));
    assert_eq!(doc["model_catalog_json"].as_str(), Some("old.json"));
    assert_eq!(
        doc["projects"]["D:/new-project"]["trust_level"].as_str(),
        Some("trusted")
    );
    assert_eq!(restore_client_config(before, &installed).unwrap(), before);
}

#[test]
fn removed_prefixes_cannot_be_reassigned_and_tokens_are_required() {
    let (mut config, all) = fixture();
    let db = Database::memory().unwrap();
    for provider in all.values() {
        db.save_provider("codex", provider).unwrap();
    }
    save(&db, &config).unwrap();
    config.secondary.clear();
    save(&db, &config).unwrap();
    let (mut reused, _) = fixture();
    reused.secondary[0].id = "different-owner".into();
    assert!(save(&db, &reused).is_err());
    db.set_setting("route_matrix_connection_token_v1", "local-test-token")
        .unwrap();
    assert!(authorize(&db, &http::HeaderMap::new()).is_err());
    let mut headers = http::HeaderMap::new();
    headers.insert(
        http::header::AUTHORIZATION,
        "Bearer local-test-token".parse().unwrap(),
    );
    assert!(authorize(&db, &headers).is_ok());
}

/// Real HTTP coverage: one running proxy, two fake upstreams, route-scoped
/// failover, compact, SSE, dynamic catalog and saves between requests.
#[tokio::test]
async fn running_proxy_hot_reloads_and_fails_over_without_crossing_routes() {
    use crate::proxy::{server::ProxyServer, ProxyConfig};
    use axum::{
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };
    let seen = Arc::new(Mutex::new(Vec::<(String, String, String)>::new()));
    let mut upstreams = Vec::new();
    let (mut config, mut all) = fixture();
    for id in ["a", "b"] {
        let seen = seen.clone();
        let router = Router::new().route("/v1/responses", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let seen = seen.clone();
            async move {
                assert!(!headers.contains_key(MARKER));
                let auth = headers.get("authorization").unwrap().to_str().unwrap().to_string();
                seen.lock().unwrap().push((id.into(), body["model"].as_str().unwrap().into(), auth));
                if id == "a" && body["model"] == "fail-a" {
                    return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":{"message":"try next"}}))).into_response();
                }
                let response = json!({"id":"resp_test", "object":"response", "status":"completed", "model":body["model"], "output":[], "usage":{"input_tokens":1,"output_tokens":1}});
                if body["stream"] == true {
                    return ([("content-type", "text/event-stream")], format!("event: response.completed\ndata: {}\n\n", json!({"type":"response.completed","response":response}))).into_response();
                }
                Json(response).into_response()
            }
        })).route("/v1/responses/compact", post(|Json(body): Json<Value>| async move { Json(json!({"object":"response.compaction", "model":body["model"], "output":[]})) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        all.get_mut(id).unwrap().settings_config["base_url"] = json!(format!("http://{addr}/v1"));
        all.get_mut(id).unwrap().settings_config["auth"]["OPENAI_API_KEY"] =
            json!(format!("upstream-{id}"));
        upstreams.push(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }));
    }
    config.secondary[0].models[0].targets[0].model = "fail-a".into();
    let db = Arc::new(Database::memory().unwrap());
    for provider in all.values() {
        db.save_provider("codex", provider).unwrap();
    }
    db.set_setting("route_matrix_connection_token_v1", "local-test-token")
        .unwrap();
    save(&db, &config).unwrap();
    let proxy = ProxyServer::new(
        ProxyConfig {
            listen_port: 0,
            ..ProxyConfig::default()
        },
        db.clone(),
        None,
    );
    let info = proxy.start().await.unwrap();
    let origin = format!("http://127.0.0.1:{}/route-matrix/v1", info.port);
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    assert_eq!(
        client
            .get(format!("{origin}/models"))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let catalog: Value = client
        .get(format!("{origin}/models"))
        .bearer_auth("local-test-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(catalog["models"].as_array().unwrap().len(), 2);
    let body: Value = client
        .post(format!("{origin}/responses"))
        .bearer_auth("local-test-token")
        .json(&json!({"model":"rm-backup/gpt-test", "input":[], "stream":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["model"], "actual-b", "{body}");
    // A failure in the secondary route must not trip the primary route's a.
    let body: Value = client
        .post(format!("{origin}/responses"))
        .bearer_auth("local-test-token")
        .json(&json!({"model":"gpt-test", "input":[], "stream":false}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["model"], "actual-a", "{body}");
    config.primary.active_provider_id = "b".into();
    config.primary.models[0].id = "renamed".into();
    save(&db, &config).unwrap();
    let text = client
        .post(format!("{origin}/responses"))
        .bearer_auth("local-test-token")
        .json(&json!({"model":"renamed", "input":[], "stream":true}))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        text.contains("response.completed") && text.contains("actual-b"),
        "{text}"
    );
    let compact: Value = client
        .post(format!("{origin}/responses/compact"))
        .bearer_auth("local-test-token")
        .json(&json!({"model":"renamed", "input":[]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(compact["model"], "actual-b", "{compact}");
    let count = seen.lock().unwrap().len();
    let unknown = client
        .post(format!("{origin}/responses"))
        .bearer_auth("local-test-token")
        .json(&json!({"model":"rm-removed/gpt-test", "input":[]}))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::BAD_REQUEST);
    assert_eq!(seen.lock().unwrap().len(), count);
    assert_eq!(
        seen.lock().unwrap()[0],
        ("a".into(), "fail-a".into(), "Bearer upstream-a".into())
    );
    assert_eq!(
        seen.lock().unwrap()[1],
        ("b".into(), "actual-b".into(), "Bearer upstream-b".into())
    );
    assert_eq!(proxy.get_status().await.total_requests, 0); // Original route state is untouched.

    // Empty model lists are real runtime defaults, not just relaxed validation.
    config.primary.models.clear();
    config.primary.provider_ids = vec!["a".into(), "b".into()];
    config.secondary[0].models.clear();
    config.secondary[0].provider_ids = vec!["a".into(), "b".into()];
    config.secondary[0].prefix = "any".into();
    save(&db, &config).unwrap();
    let default_model = defaults::rows()[0]["slug"].as_str().unwrap().to_owned();
    for (model, auth) in [
        (default_model.clone(), "Bearer upstream-b"),
        (format!("rm-any/{default_model}"), "Bearer upstream-a"),
    ] {
        let response: Value = client
            .post(format!("{origin}/responses"))
            .bearer_auth("local-test-token")
            .json(&json!({"model":model, "input":[], "stream":false}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(response["model"], default_model);
        let captured = seen.lock().unwrap().last().cloned().unwrap();
        assert_eq!(captured.1, default_model);
        assert_eq!(captured.2, auth);
    }
    let catalog: Value = client
        .get(format!("{origin}/models"))
        .bearer_auth("local-test-token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rows = catalog["models"].as_array().unwrap();
    assert!(rows.iter().any(|row| row["slug"] == default_model));
    assert!(rows
        .iter()
        .any(|row| row["slug"] == format!("rm-any/{default_model}")));
    assert!(!rows
        .iter()
        .any(|row| row["slug"].as_str().unwrap().starts_with("rm-backup/")));
    proxy.stop().await.unwrap();
    for task in upstreams {
        task.abort();
    }
}
