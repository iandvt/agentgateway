use std::path::PathBuf;

use ::http::HeaderValue;

use super::BackendAuthError;
use crate::http::Request;

const TOKEN_ENV_VARS: &[&str] = &["GH_COPILOT_TOKEN", "COPILOT_GITHUB_TOKEN"];
const DOMAIN: &str = "github.com";

pub(super) async fn insert_headers(req: &mut Request) -> anyhow::Result<()> {
	let token = load_token().await?;
	insert_token_headers(req, &token)
}

pub(super) fn insert_user_headers(req: &mut Request) -> Result<(), BackendAuthError> {
	let token = crate::http::copilot::request_token(req)
		.map_err(BackendAuthError::ClientCredential)?
		.to_owned();
	insert_token_headers(req, &token).map_err(BackendAuthError::local)
}

fn insert_token_headers(req: &mut Request, token: &str) -> anyhow::Result<()> {
	let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))?;
	auth.set_sensitive(true);

	req.headers_mut().insert(http::header::AUTHORIZATION, auth);
	req.headers_mut().insert(
		http::header::CONTENT_TYPE,
		HeaderValue::from_static("application/json"),
	);
	req.headers_mut().insert(
		"editor-version",
		HeaderValue::from_static(concat!("agentgateway/", env!("CARGO_PKG_VERSION"))),
	);
	req.headers_mut().insert(
		"x-github-api-version",
		HeaderValue::from_static("2025-10-01"),
	);
	req
		.headers_mut()
		.insert("x-initiator", HeaderValue::from_static("agent"));
	req.headers_mut().insert(
		"x-interaction-type",
		HeaderValue::from_static("conversation-agent"),
	);
	req.headers_mut().insert(
		"openai-intent",
		HeaderValue::from_static("conversation-agent"),
	);

	Ok(())
}

async fn load_token() -> anyhow::Result<String> {
	// Do not cache file-backed tokens here. GitHub/Copilot tooling may rotate them
	// independently, and direct-token auth should pick up those changes.
	for key in TOKEN_ENV_VARS {
		if let Ok(token) = std::env::var(key)
			&& let Some(token) = nonempty_trimmed(token.as_str())
		{
			return Ok(token.to_string());
		}
	}

	for path in copilot_config_paths() {
		if let Ok(contents) = tokio::fs::read_to_string(path).await
			&& let Some(token) = extract_json_oauth_token(&contents, DOMAIN)
		{
			return Ok(token);
		}
	}

	for path in gh_config_paths() {
		if let Ok(contents) = tokio::fs::read_to_string(path).await
			&& let Some(token) = extract_yaml_oauth_token(&contents, DOMAIN)
		{
			return Ok(token);
		}
	}

	anyhow::bail!(
		"Copilot token not found; set GH_COPILOT_TOKEN or authenticate with GitHub Copilot/GitHub CLI"
	)
}

fn copilot_config_paths() -> Vec<PathBuf> {
	config_dir()
		.map(|config| {
			let base = config.join("github-copilot");
			vec![base.join("hosts.json"), base.join("apps.json")]
		})
		.unwrap_or_default()
}

fn gh_config_paths() -> Vec<PathBuf> {
	config_dir()
		.map(|config| vec![config.join("gh").join("hosts.yml")])
		.unwrap_or_default()
}

fn config_dir() -> Option<PathBuf> {
	std::env::var_os("XDG_CONFIG_HOME")
		.map(PathBuf::from)
		.or_else(platform_config_dir)
		.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
}

#[cfg(windows)]
fn platform_config_dir() -> Option<PathBuf> {
	std::env::var_os("APPDATA").map(PathBuf::from)
}

#[cfg(not(windows))]
fn platform_config_dir() -> Option<PathBuf> {
	None
}

fn nonempty_trimmed(value: &str) -> Option<&str> {
	let value = value.trim();
	(!value.is_empty()).then_some(value)
}

fn extract_json_oauth_token(contents: &str, domain: &str) -> Option<String> {
	let value: serde_json::Value = serde_json::from_str(contents).ok()?;
	value.as_object()?.iter().find_map(|(key, value)| {
		if key.starts_with(domain) {
			value["oauth_token"]
				.as_str()
				.and_then(nonempty_trimmed)
				.map(ToOwned::to_owned)
		} else {
			None
		}
	})
}

fn extract_yaml_oauth_token(contents: &str, domain: &str) -> Option<String> {
	let value: serde_yaml::Value = serde_yaml::from_str(contents).ok()?;
	value.as_mapping()?.iter().find_map(|(key, value)| {
		if key.as_str().is_some_and(|key| key.starts_with(domain)) {
			value["oauth_token"]
				.as_str()
				.and_then(nonempty_trimmed)
				.map(ToOwned::to_owned)
		} else {
			None
		}
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[tokio::test]
	async fn copilot_expiry_between_authentication_and_dispatch_is_unauthorized() {
		use std::time::{Duration, SystemTime};

		use crate::http::auth::{self, BackendAuth, BackendAuthKind};
		use crate::http::copilot::{CopilotConfig, CopilotPolicy};
		use crate::proxy::ProxyResponseReason;
		use crate::types::agent::{BackendTarget, Target};

		let test = crate::test_helpers::proxymock::setup_proxy_test("{}").unwrap();
		let info = auth::BackendInfo {
			call_target: Target::Hostname("api.githubcopilot.com".into(), 443),
			target: BackendTarget::Backend {
				name: Default::default(),
				namespace: Default::default(),
				section: None,
			},
			inputs: test.inputs(),
		};
		let policy = CopilotPolicy::from_config(
			CopilotConfig {
				client_id: "synthetic-client".into(),
				audience: "synthetic-gateway".into(),
				allowed_user_ids: vec![1],
				credential_ttl: None,
				disable_expiry: Some(true),
				policy_id: "synthetic-policy".into(),
			},
			&[7; 32],
		)
		.unwrap();
		let issued_at = SystemTime::now();
		let expires_at = issued_at + Duration::from_secs(1);
		let credential = policy
			.test_credential(1, "synthetic-upstream-token", issued_at, Some(expires_at))
			.unwrap();
		let mut req = ::http::Request::builder()
			.uri("/v1/chat/completions")
			.header("authorization", format!("Bearer {credential}"))
			.body(crate::http::Body::empty())
			.unwrap();
		req
			.extensions_mut()
			.insert(crate::transport::stream::TLSConnectionInfo::default());
		assert!(
			policy
				.authenticate(&mut req)
				.await
				.direct_response
				.is_none()
		);
		let auth = BackendAuth::new(BackendAuthKind::CopilotUser { invalid: false });
		auth::apply_backend_auth(&info, &auth, &mut req)
			.await
			.unwrap();
		assert!(!req.headers().contains_key("authorization"));

		// Exercise expiration between policy authentication and actual dispatch.
		// Pure deadline boundary tests in http::copilot use a controlled clock.
		tokio::time::sleep(
			expires_at
				.duration_since(SystemTime::now())
				.unwrap_or_default(),
		)
		.await;
		for error in [
			auth::apply_backend_auth(&info, &auth, &mut req)
				.await
				.unwrap_err(),
			auth::insert_copilot_user_headers(&mut req).unwrap_err(),
		] {
			let reason = error.as_reason();
			assert_eq!(
				error.into_response_with_grpc(false).status(),
				::http::StatusCode::UNAUTHORIZED
			);
			assert_eq!(reason, ProxyResponseReason::Authorization);
			assert!(!req.headers().contains_key("authorization"));
		}
		let invalid = BackendAuth::new(BackendAuthKind::CopilotUser { invalid: true });
		let error = auth::apply_backend_auth(&info, &invalid, &mut req)
			.await
			.unwrap_err();
		assert_eq!(
			error.into_response_with_grpc(false).status(),
			::http::StatusCode::INTERNAL_SERVER_ERROR
		);
	}

	#[test]
	fn json_token_extraction() {
		let contents = r#"{
			"github.com": {
				"oauth_token": " copilot-token\n"
			},
			"enterprise.example.com": {
				"oauth_token": "wrong-token"
			}
		}"#;

		assert_eq!(
			extract_json_oauth_token(contents, "github.com").as_deref(),
			Some("copilot-token")
		);
	}

	#[test]
	fn yaml_token_extraction() {
		let contents = r#"
github.com:
  oauth_token: " copilot-token\n"
  user: octocat
enterprise.example.com:
  oauth_token: wrong-token
"#;

		assert_eq!(
			extract_yaml_oauth_token(contents, "github.com").as_deref(),
			Some("copilot-token")
		);
	}
}
