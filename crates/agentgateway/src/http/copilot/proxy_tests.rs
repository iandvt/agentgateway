use std::time::{Duration, SystemTime};

use http::{HeaderMap, HeaderValue, Method};
use serde_json::{Value, json};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::{CopilotConfig, CopilotPolicy};
use crate::http::{Body, Response};
use crate::proxy::request_builder::RequestBuilder;
use crate::test_helpers::proxymock::{self, BIND_KEY, TestBind};
use crate::types::agent::{
	PolicyPhase, PolicyTarget, RouteName, Target, TargetedPolicy, TrafficPolicy,
};

fn policy() -> CopilotPolicy {
	CopilotPolicy::from_config(
		CopilotConfig {
			client_id: "synthetic-client".into(),
			audience: "http://localhost".into(),
			allowed_user_ids: vec![1, 2],
			credential_ttl: None,
			disable_expiry: Some(true),
			policy_id: "proxy-test/copilot".into(),
		},
		&[7; 32],
	)
	.unwrap()
}

async fn gateway(policy: CopilotPolicy, upstream: &MockServer) -> TestBind {
	gateway_with_provider(
		policy,
		json!({
			"name": "copilot",
			"provider": {"copilot": {"model": "gpt-4o-mini"}},
			"hostOverride": upstream.address().to_string(),
			"policies": {"backendAuth": "copilotUser"}
		}),
	)
	.await
}

async fn gateway_with_provider(policy: CopilotPolicy, provider: Value) -> TestBind {
	let mut gateway = proxymock::setup_proxy_test("{}")
		.unwrap()
		.with_bind(proxymock::simple_bind());
	gateway
		.attach_route(json!({
			"name": "normal",
			"matches": [{"path": {"exact": "/normal"}}],
			"policies": {"directResponse": {"status": 200, "body": "public"}}
		}))
		.await;
	gateway
		.attach_route(json!({
			"name": "copilot",
			"matches": [
				{"path": {"pathPrefix": "/login"}},
				{"path": {"pathPrefix": "/v1"}}
			],
			"backends": [{"ai": provider}]
		}))
		.await;
	gateway.with_policy(TargetedPolicy {
		key: "copilot-policy".into(),
		name: None,
		creation_timestamp: 0,
		target: PolicyTarget::Route(RouteName {
			name: "copilot".into(),
			namespace: "default".into(),
			rule_name: None,
			kind: None,
		}),
		inheritance: Default::default(),
		policy: (
			TrafficPolicy::Copilot(crate::store::RequestPolicy::single(policy)),
			PolicyPhase::Route,
		)
			.into(),
	});
	gateway
}

async fn native_gateway(policy: CopilotPolicy, upstream: &MockServer) -> TestBind {
	let gateway = gateway_with_provider(
		policy,
		json!({
			"name": "copilot",
			"provider": {"copilot": {"model": "gpt-4o-mini"}},
			"policies": {"backendAuth": "copilotUser"}
		}),
	)
	.await;
	// Only the physical connection is mocked. The native destination and TLS
	// policy checks run unchanged; this does not test a real TLS handshake.
	gateway.pi.upstream.mock_tls_transport(
		Target::Hostname("api.githubcopilot.com".into(), 443),
		*upstream.address(),
	);
	gateway
}

async fn upstream() -> MockServer {
	let upstream = MockServer::start().await;
	Mock::given(wiremock::matchers::any())
		.respond_with(ResponseTemplate::new(200).set_body_json(json!({
			"id": "chatcmpl-synthetic", "object": "chat.completion", "created": 0,
			"model": "gpt-4o-mini",
			"choices": [{"index": 0, "message": {"role": "assistant", "content": "unexpected upstream request"}, "finish_reason": "stop"}],
			"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
		})))
		.mount(&upstream)
		.await;
	upstream
}

async fn chat(gateway: &TestBind, headers: HeaderMap) -> Response {
	RequestBuilder::new(Method::POST, "http://localhost/v1/chat/completions")
		.headers(headers)
		.header("content-type", "application/json")
		.body(Body::from(
			json!({"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hello"}]})
				.to_string(),
		))
		.send(gateway.serve_http(BIND_KEY))
		.await
		.unwrap()
}

fn bearer(credential: &str) -> HeaderMap {
	HeaderMap::from_iter([(
		http::header::AUTHORIZATION,
		HeaderValue::from_str(&format!("Bearer {credential}")).unwrap(),
	)])
}

fn with_retry(gateway: &mut TestBind, backoff: Option<Duration>) {
	gateway.with_policy(TargetedPolicy {
		key: "copilot-retry".into(),
		name: None,
		creation_timestamp: 0,
		target: PolicyTarget::Route(RouteName {
			name: "copilot".into(),
			namespace: "default".into(),
			rule_name: None,
			kind: None,
		}),
		inheritance: Default::default(),
		policy: (
			TrafficPolicy::Retry(crate::http::retry::Policy {
				attempts: std::num::NonZeroU8::new(1).unwrap(),
				backoff,
				codes: Box::new([http::StatusCode::SERVICE_UNAVAILABLE]),
				precondition: None,
				condition: None,
			}),
			PolicyPhase::Route,
		)
			.into(),
	});
}

#[tokio::test]
async fn native_dispatch_and_retries_preserve_concurrent_user_identity() {
	let policy = policy();
	let alice = policy
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	let bob = policy
		.test_credential(2, "synthetic-bob", SystemTime::now(), None)
		.unwrap();
	let upstream = MockServer::start().await;
	Mock::given(wiremock::matchers::any())
		.respond_with(|req: &wiremock::Request| {
			let user = req.headers["x-proof-user"].to_str().unwrap();
			assert!(matches!(user, "alice" | "bob"));
			assert_eq!(req.headers["authorization"], format!("Bearer synthetic-{user}"));
			assert_eq!(req.headers["host"], "api.githubcopilot.com");
			assert_eq!(req.url.path(), "/chat/completions");
			assert_eq!(req.headers["x-initiator"], "agent");
			if !req.headers.contains_key("x-retry-attempt") {
				return ResponseTemplate::new(503);
			}
			assert_eq!(req.headers["x-retry-attempt"], "1");
			ResponseTemplate::new(200).set_body_json(json!({
				"id": "chatcmpl-synthetic", "object": "chat.completion", "created": 0,
				"model": "gpt-4o-mini",
				"choices": [{"index": 0, "message": {"role": "assistant", "content": user}, "finish_reason": "stop"}],
				"usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
			}))
		})
		.mount(&upstream)
		.await;
	let mut gateway = native_gateway(policy, &upstream).await;
	with_retry(&mut gateway, None);
	let mut alice_headers = bearer(&alice);
	alice_headers.insert("x-proof-user", HeaderValue::from_static("alice"));
	let mut bob_headers = bearer(&bob);
	bob_headers.insert("x-proof-user", HeaderValue::from_static("bob"));
	let (alice_response, bob_response) =
		tokio::join!(chat(&gateway, alice_headers), chat(&gateway, bob_headers));
	for (response, expected) in [(alice_response, "alice"), (bob_response, "bob")] {
		assert_eq!(response.status(), 200);
		let body: Value =
			serde_json::from_slice(&proxymock::read_body_raw(response.into_body()).await).unwrap();
		assert_eq!(body["choices"][0]["message"]["content"], expected);
	}
	let requests = upstream.received_requests().await.unwrap();
	assert_eq!(requests.len(), 4);
	for user in ["alice", "bob"] {
		let attempts: Vec<_> = requests
			.iter()
			.filter(|req| req.headers["x-proof-user"] == user)
			.collect();
		assert_eq!(attempts.len(), 2);
		assert!(!attempts[0].headers.contains_key("x-retry-attempt"));
		assert_eq!(attempts[1].headers["x-retry-attempt"], "1");
		assert_eq!(attempts[0].body, attempts[1].body);
	}
}

#[tokio::test]
async fn native_retry_rejects_expired_credentials_before_another_dispatch() {
	let policy = policy();
	let upstream = MockServer::start().await;
	Mock::given(wiremock::matchers::any())
		.respond_with(ResponseTemplate::new(503))
		.mount(&upstream)
		.await;
	let mut gateway = native_gateway(policy.clone(), &upstream).await;
	with_retry(&mut gateway, Some(Duration::from_secs(3)));
	let now = SystemTime::now();
	let credential = policy
		.test_credential(
			1,
			"synthetic-alice",
			now,
			Some(now + Duration::from_secs(2)),
		)
		.unwrap();
	let response = chat(&gateway, bearer(&credential)).await;
	assert_eq!(response.status(), 401);
	proxymock::read_body_raw(response.into_body()).await;
	let requests = upstream.received_requests().await.unwrap();
	assert_eq!(requests.len(), 1);
	assert_eq!(
		requests[0].headers["authorization"],
		"Bearer synthetic-alice"
	);
	assert!(!requests[0].headers.contains_key("x-retry-attempt"));
}

#[tokio::test]
async fn copilot_bearers_are_hidden_from_early_error_access_logs() {
	let mut gateway = proxymock::setup_proxy_test("{}")
		.unwrap()
		.with_bind(proxymock::simple_bind());
	gateway
		.attach_frontend_policy(json!({"accessLog": {"add": {
			"copilot_probe": "request.headers['x-copilot-probe']",
			"copilot_headers": "request.headers",
			"copilot_authorization": "request.headers['authorization']"
		}}}))
		.await;
	for credential in ["agw_cp1.synthetic-secret", "agw_cpl1.synthetic-transaction"] {
		let probe = uuid::Uuid::new_v4().to_string();
		let response = RequestBuilder::new(Method::GET, "http://localhost/no-route")
			.headers(bearer(credential))
			.header("x-copilot-probe", &probe)
			.send(gateway.serve_http(BIND_KEY))
			.await
			.unwrap();
		assert_eq!(response.status(), 404);
		proxymock::read_body_raw(response.into_body()).await;
		let log = agent_core::telemetry::testing::eventually_find(&[
			("scope", "request"),
			("copilot_probe", &probe),
		])
		.await
		.unwrap();
		assert!(
			!log.to_string().contains(credential),
			"credential leaked into access log"
		);
		assert!(log.get("copilot_authorization").is_none());
	}
}

#[tokio::test]
async fn gateway_transformations_cannot_copy_copilot_bearers() {
	let upstream = upstream().await;
	let mut gateway = gateway(policy(), &upstream).await;
	gateway
		.attach_gateway_policy(json!({"transformations": {"request": {
		"set": {"x-copied-auth": "request.headers['authorization']"}
	}, "response": {"set": {"x-copied-auth": "request.headers['x-copied-auth']"}}}}))
		.await;
	for credential in ["agw_cp1.synthetic-secret", "agw_cpl1.synthetic-transaction"] {
		let response = RequestBuilder::new(Method::GET, "http://localhost/normal")
			.headers(bearer(credential))
			.send(gateway.serve_http(BIND_KEY))
			.await
			.unwrap();
		assert_eq!(response.status(), 200);
		assert!(!response.headers().contains_key("x-copied-auth"));
		proxymock::read_body_raw(response.into_body()).await;
	}
}

#[tokio::test]
async fn unrelated_route_is_public_while_copilot_requires_authentication() {
	let upstream = upstream().await;
	let gateway = gateway(policy(), &upstream).await;
	let public = proxymock::send_request(
		gateway.serve_http(BIND_KEY),
		Method::GET,
		"http://localhost/normal",
	)
	.await;
	assert_eq!(public.status(), 200);
	assert_eq!(proxymock::read_body_raw(public.into_body()).await, "public");
	let protected = chat(&gateway, HeaderMap::new()).await;
	assert_eq!(protected.status(), 401);
	proxymock::read_body_raw(protected.into_body()).await;
	assert!(upstream.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn malformed_and_duplicate_credentials_make_zero_upstream_requests() {
	let policy = policy();
	let credential = policy
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	let upstream = upstream().await;
	let gateway = gateway(policy, &upstream).await;
	let mut duplicate = bearer(&credential);
	duplicate.append(
		http::header::AUTHORIZATION,
		"Bearer another".parse().unwrap(),
	);
	for headers in [bearer("plaintext-github-token"), duplicate] {
		let response = chat(&gateway, headers).await;
		assert_eq!(response.status(), 401);
		proxymock::read_body_raw(response.into_body()).await;
	}
	assert!(upstream.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn valid_user_credential_cannot_reach_an_overridden_copilot_endpoint() {
	let policy = policy();
	let credential = policy
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	let upstream = upstream().await;
	let gateway = gateway(policy, &upstream).await;
	let response = chat(&gateway, bearer(&credential)).await;
	assert_eq!(response.status(), 500);
	proxymock::read_body_raw(response.into_body()).await;
	assert!(upstream.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn invalid_attached_policy_keeps_the_route_closed() {
	let upstream = upstream().await;
	let gateway = gateway(
		CopilotPolicy::invalid("synthetic translation failure".into()),
		&upstream,
	)
	.await;
	let response = chat(&gateway, HeaderMap::new()).await;
	assert_eq!(response.status(), 500);
	proxymock::read_body_raw(response.into_body()).await;
	assert!(upstream.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn native_login_response_bypasses_gateway_response_transformations() {
	let upstream = upstream().await;
	let mut gateway = gateway(policy(), &upstream).await;
	gateway
		.attach_gateway_policy(json!({"transformations": {"response": {
			"set": {"x-copied-body": "string(response.body)"},
			"body": "'rewritten'"
		}}}))
		.await;
	let public = proxymock::send_request(
		gateway.serve_http(BIND_KEY),
		Method::GET,
		"http://localhost/normal",
	)
	.await;
	assert_eq!(public.status(), 200);
	assert_eq!(public.headers()["x-copied-body"], "public");
	assert_eq!(
		proxymock::read_body_raw(public.into_body()).await,
		"rewritten"
	);

	// Invalid methods are handled locally without contacting GitHub. They use the
	// same sensitive-response path as successful login issuance.
	let login = proxymock::send_request(
		gateway.serve_http(BIND_KEY),
		Method::GET,
		"http://localhost/login/start",
	)
	.await;
	assert_eq!(login.status(), 405);
	assert_eq!(login.headers()["cache-control"], "no-store");
	assert!(!login.headers().contains_key("x-copied-body"));
	let body: Value =
		serde_json::from_slice(&proxymock::read_body_raw(login.into_body()).await).unwrap();
	assert_eq!(body, json!({"error": "login_requires_post"}));
	assert!(upstream.received_requests().await.unwrap().is_empty());
}
