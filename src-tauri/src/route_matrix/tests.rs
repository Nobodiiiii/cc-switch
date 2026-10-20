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
    proxy.stop().await.unwrap();
    for task in upstreams {
        task.abort();
    }
}
