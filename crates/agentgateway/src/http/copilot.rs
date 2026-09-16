//! Route-scoped GitHub device login and encrypted Copilot user credentials.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, ensure};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use secrecy::{ExposeSecret, SecretSlice, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::crypto::aead::Aes256Gcm;
use crate::http::{PolicyResponse, Request, Response};
use crate::proxy::ProxyResponse;
use crate::proxy::httpproxy::PolicyClient;
use crate::resource_manager::{ResourceFetcher, ResourceRef};
use crate::serdes::FileOrInline;
use crate::store::RequestPolicyTrait;
use crate::telemetry::log::RequestLog;
use crate::transport::stream::{TCPConnectionInfo, TLSConnectionInfo};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const ENVELOPE_PREFIX: &str = "agw_cp1.";
const TRANSACTION_PREFIX: &str = "agw_cpl1.";
const ISSUER: &str = "agentgateway";
const PURPOSE: &str = "agentgateway-copilot-user";
const MAX_PENDING: usize = 8;
const MAX_LOGIN_SECONDS: u64 = 900;
const NANOS_PER_SECOND: u64 = 1_000_000_000;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct LocalCopilotConfig {
	pub client_id: String,
	pub audience: String,
	pub allowed_user_ids: Vec<u64>,
	#[serde(
		default,
		rename = "credentialTTL",
		with = "crate::serdes::serde_dur_option"
	)]
	#[cfg_attr(feature = "schema", schemars(with = "Option<String>"))]
	pub credential_ttl: Option<Duration>,
	#[serde(default)]
	pub disable_expiry: Option<bool>,
	/// A protected file containing exactly 32 raw bytes. Inline keys are rejected.
	pub encryption_key: FileOrInline,
}

impl fmt::Debug for LocalCopilotConfig {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("LocalCopilotConfig")
			.field("client_id", &self.client_id)
			.field("audience", &self.audience)
			.field("allowed_user_ids", &self.allowed_user_ids)
			.field("credential_ttl", &self.credential_ttl)
			.field("disable_expiry", &self.disable_expiry)
			.finish_non_exhaustive()
	}
}

impl LocalCopilotConfig {
	pub async fn compile(
		self,
		resources: &ResourceFetcher,
		policy_id: String,
	) -> anyhow::Result<CopilotPolicy> {
		let FileOrInline::File { file } = self.encryption_key else {
			anyhow::bail!("Copilot encryptionKey must reference a file");
		};
		// FileOrInline's string loader cannot load arbitrary raw key bytes. Use its
		// ResourceFetcher file path directly so the resource remains watched.
		let bytes = resources
			.fetch(ResourceRef::File(file))
			.await
			.map_err(|_| anyhow::anyhow!("failed to load Copilot encryption key"))?;
		let key = SecretSlice::from(bytes.to_vec());
		CopilotPolicy::from_config(
			CopilotConfig {
				client_id: self.client_id,
				audience: self.audience,
				allowed_user_ids: self.allowed_user_ids,
				credential_ttl: self.credential_ttl,
				disable_expiry: self.disable_expiry,
				policy_id,
			},
			key.expose_secret(),
		)
	}
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotConfig {
	pub client_id: String,
	pub audience: String,
	pub allowed_user_ids: Vec<u64>,
	#[serde(
		rename = "credentialTTL",
		with = "crate::serdes::serde_dur_option",
		skip_serializing_if = "Option::is_none"
	)]
	pub credential_ttl: Option<Duration>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub disable_expiry: Option<bool>,
	pub policy_id: String,
}

/// Compiled policies retain transaction state through route selection and inheritance.
#[derive(Clone)]
pub struct CopilotPolicy {
	state: Option<Arc<State>>,
}

impl fmt::Debug for CopilotPolicy {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("CopilotPolicy")
			.field("config", &self.state.as_ref().map(|state| &state.config))
			.finish_non_exhaustive()
	}
}

impl Serialize for CopilotPolicy {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match &self.state {
			Some(state) => state.config.serialize(serializer),
			None => json!({"translationError":"invalid Copilot authentication configuration"})
				.serialize(serializer),
		}
	}
}

struct State {
	config: CopilotConfig,
	ttl: Option<u64>,
	key: Aes256Gcm,
	client: reqwest::Client,
	pending: Mutex<HashMap<String, Pending>>,
	login_slots: Arc<Semaphore>,
}

struct Pending {
	device_code: SecretString,
	expires_at: u64,
	next_poll: u64,
	interval: u64,
	polling: bool,
	_permit: OwnedSemaphorePermit,
}

impl Pending {
	fn defer(&mut self, slow_down: bool, time: u64) -> anyhow::Result<u64> {
		if slow_down {
			self.interval = self
				.interval
				.checked_add(5)
				.context("invalid polling interval")?;
		}
		self.next_poll = deadline(time, self.interval)?;
		self.polling = false;
		Ok(self.interval)
	}
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
	version: u8,
	issuer: String,
	purpose: String,
	audience: String,
	policy_id: String,
	user_id: u64,
	// Nanoseconds retain the operator's exact positive Duration without rounding.
	issued_at: u64,
	gateway_expires_at: Option<u64>,
	upstream_expires_at: Option<u64>,
	#[serde(serialize_with = "serialize_token")]
	upstream_token: SecretString,
}

fn serialize_token<S: serde::Serializer>(
	token: &SecretString,
	serializer: S,
) -> Result<S::Ok, S::Error> {
	serializer.serialize_str(token.expose_secret())
}

impl Envelope {
	fn expiration(&self) -> Option<u64> {
		[self.gateway_expires_at, self.upstream_expires_at]
			.into_iter()
			.flatten()
			.min()
	}
}

#[derive(Clone)]
struct Verified {
	state: Arc<State>,
	envelope: Arc<Envelope>,
}

impl fmt::Debug for Verified {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("VerifiedCopilotUser")
			.finish_non_exhaustive()
	}
}

#[derive(Debug, thiserror::Error)]
#[error("Copilot user is not allowed")]
struct AdmissionDenied;

fn timestamp(time: SystemTime) -> anyhow::Result<u64> {
	u64::try_from(time.duration_since(UNIX_EPOCH)?.as_nanos()).context("unsupported clock value")
}

fn now() -> anyhow::Result<u64> {
	timestamp(SystemTime::now())
}

fn deadline(time: u64, seconds: u64) -> anyhow::Result<u64> {
	seconds
		.checked_mul(NANOS_PER_SECOND)
		.and_then(|n| time.checked_add(n))
		.context("invalid login lifetime")
}

fn validate_deadlines(
	issued_at: u64,
	gateway_expires_at: Option<u64>,
	upstream_expires_at: Option<u64>,
	ttl: Option<u64>,
	time: u64,
) -> anyhow::Result<()> {
	ensure!(issued_at <= time, "invalid credential issuance time");
	for deadline in [gateway_expires_at, upstream_expires_at]
		.into_iter()
		.flatten()
	{
		ensure!(
			deadline > issued_at && time < deadline,
			"expired credential"
		);
	}
	if let Some(ttl) = ttl {
		ensure!(
			gateway_expires_at
				.and_then(|deadline| deadline.checked_sub(issued_at))
				.is_some_and(|lifetime| lifetime <= ttl),
			"invalid credential lifetime"
		);
	}
	Ok(())
}

impl CopilotPolicy {
	pub fn from_config(config: CopilotConfig, encryption_key: &[u8]) -> anyhow::Result<Self> {
		for (value, maximum) in [
			(&config.client_id, 1024),
			(&config.audience, 2048),
			(&config.policy_id, 2048),
		] {
			ensure!(
				!value.trim().is_empty() && value.len() <= maximum,
				"invalid Copilot policy identity"
			);
		}
		ensure!(
			!config.allowed_user_ids.is_empty()
				&& config.allowed_user_ids.len() <= 4096
				&& config.allowed_user_ids.iter().all(|id| *id > 0),
			"invalid Copilot user allowlist"
		);
		let ttl = match (config.credential_ttl, config.disable_expiry) {
			(Some(ttl), None) if !ttl.is_zero() => {
				let ttl = u64::try_from(ttl.as_nanos()).context("unsupported Copilot credential TTL")?;
				now()?
					.checked_add(ttl)
					.context("unsupported Copilot credential TTL")?;
				Some(ttl)
			},
			(None, Some(true)) => None,
			_ => anyhow::bail!("Copilot requires positive credentialTTL or disableExpiry: true"),
		};
		ensure!(
			encryption_key.len() == 32,
			"Copilot encryption key must contain exactly 32 raw bytes"
		);
		let key = Aes256Gcm::new(encryption_key)?;
		let client = reqwest::Client::builder()
			.redirect(reqwest::redirect::Policy::none())
			.https_only(true)
			.timeout(Duration::from_secs(30))
			.user_agent("agentgateway-copilot")
			.build()?;
		Ok(Self {
			state: Some(Arc::new(State {
				config,
				ttl,
				key,
				client,
				pending: Mutex::new(HashMap::new()),
				login_slots: Arc::new(Semaphore::new(MAX_PENDING)),
			})),
		})
	}

	/// Preserve a denying policy on translation failure, without retaining resolver errors.
	pub fn invalid(_reason: String) -> Self {
		Self { state: None }
	}

	pub(crate) async fn authenticate(&self, req: &mut Request) -> PolicyResponse {
		// Clear any prior credential and remove the client bearer before another
		// policy, transformation, or backend can observe it.
		req.extensions_mut().remove::<Verified>();
		let captured = req.extensions_mut().remove::<IngressCredential>();
		let had_authorization = captured.is_some() || req.headers().contains_key("authorization");
		let credential = match captured {
			Some(captured) if !req.headers().contains_key("authorization") => {
				captured.0.context("invalid credential")
			},
			Some(_) => Err(anyhow::anyhow!("conflicting credential")),
			None => bearer(req).map(|value| SecretString::from(value.to_owned())),
		};
		req.headers_mut().remove("authorization");
		let Some(state) = &self.state else {
			return local_response(500, json!({"error":"invalid_copilot_configuration"}));
		};
		if !secure_transport(req) {
			return local_response(403, json!({"error":"secure_transport_required"}));
		}
		let path = req.uri().path();
		if path == "/login/start" || path == "/login/poll" {
			if req.method() != ::http::Method::POST {
				return local_response(405, json!({"error":"login_requires_post"}));
			}
			if req.headers().contains_key("origin") {
				return local_response(403, json!({"error":"login_helper_required"}));
			}
			let result = if path == "/login/start" {
				if had_authorization {
					return local_response(401, json!({"error":"unexpected_login_credential"}));
				}
				state.login_start().await
			} else {
				let Ok(handle) = credential else {
					return local_response(401, json!({"error":"invalid_login_transaction"}));
				};
				state.login_poll(handle.expose_secret()).await
			};
			return PolicyResponse::default().with_response(
				result.unwrap_or_else(|_| response(502, json!({"error":"login_or_issuance_failed"}))),
			);
		}
		let result = credential.and_then(|credential| state.open(credential.expose_secret(), now()?));
		match result {
			Ok(envelope) => {
				req.extensions_mut().insert(Verified {
					state: state.clone(),
					envelope: Arc::new(envelope),
				});
				PolicyResponse::default()
			},
			Err(error) if error.is::<AdmissionDenied>() => {
				local_response(403, json!({"error":"user_not_allowed"}))
			},
			Err(_) => local_response(
				401,
				json!({"error":"invalid_or_expired_gateway_credential"}),
			),
		}
	}

	#[cfg(test)]
	pub(crate) fn test_credential(
		&self,
		user_id: u64,
		token: &str,
		issued_at: SystemTime,
		upstream_expires_at: Option<SystemTime>,
	) -> anyhow::Result<String> {
		let state = self.state.as_ref().context("invalid test policy")?;
		state.seal(&state.envelope(
			user_id,
			token.into(),
			upstream_expires_at.map(timestamp).transpose()?,
			timestamp(issued_at)?,
		)?)
	}
}

impl RequestPolicyTrait for CopilotPolicy {
	async fn apply(
		&self,
		_client: &PolicyClient,
		_log: &mut RequestLog,
		req: &mut Request,
	) -> Result<PolicyResponse, ProxyResponse> {
		Ok(self.authenticate(req).await)
	}
}

impl State {
	fn validate(&self, envelope: &Envelope, time: u64) -> anyhow::Result<()> {
		ensure!(
			envelope.version == 1
				&& envelope.issuer == ISSUER
				&& envelope.purpose == PURPOSE
				&& envelope.audience == self.config.audience
				&& envelope.policy_id == self.config.policy_id,
			"invalid credential"
		);
		let token = envelope.upstream_token.expose_secret();
		ensure!(
			!token.is_empty() && token.len() <= 4096 && token.bytes().all(|c| c.is_ascii_graphic()),
			"invalid credential"
		);
		validate_deadlines(
			envelope.issued_at,
			envelope.gateway_expires_at,
			envelope.upstream_expires_at,
			self.ttl,
			time,
		)?;
		if !self.config.allowed_user_ids.contains(&envelope.user_id) {
			return Err(AdmissionDenied.into());
		}
		Ok(())
	}

	fn envelope(
		&self,
		user_id: u64,
		token: SecretString,
		upstream_expires_at: Option<u64>,
		time: u64,
	) -> anyhow::Result<Envelope> {
		let envelope = Envelope {
			version: 1,
			issuer: ISSUER.into(),
			purpose: PURPOSE.into(),
			audience: self.config.audience.clone(),
			policy_id: self.config.policy_id.clone(),
			user_id,
			issued_at: time,
			gateway_expires_at: self
				.ttl
				.map(|ttl| {
					time
						.checked_add(ttl)
						.context("credential lifetime overflow")
				})
				.transpose()?,
			upstream_expires_at,
			upstream_token: token,
		};
		self.validate(&envelope, time)?;
		Ok(envelope)
	}

	fn seal(&self, envelope: &Envelope) -> anyhow::Result<String> {
		let plaintext = SecretSlice::from(serde_json::to_vec(envelope)?);
		Ok(format!(
			"{ENVELOPE_PREFIX}{}",
			URL_SAFE_NO_PAD.encode(self.key.seal(plaintext.expose_secret())?)
		))
	}

	fn open(&self, credential: &str, time: u64) -> anyhow::Result<Envelope> {
		ensure!(credential.len() <= 16384, "invalid credential");
		let credential = credential
			.strip_prefix(ENVELOPE_PREFIX)
			.context("invalid credential")?;
		let plaintext = SecretSlice::from(self.key.open(&URL_SAFE_NO_PAD.decode(credential)?)?);
		// Do not propagate parser errors: malformed encrypted JSON may contain token text.
		let envelope = serde_json::from_slice(plaintext.expose_secret())
			.map_err(|_| anyhow::anyhow!("invalid credential"))?;
		self.validate(&envelope, time)?;
		Ok(envelope)
	}

	async fn github_form(
		&self,
		endpoint: &'static str,
		pairs: &[(&str, &str)],
	) -> anyhow::Result<Value> {
		let body = url::form_urlencoded::Serializer::new(String::new())
			.extend_pairs(pairs.iter().copied())
			.finish();
		let response = self
			.client
			.post(endpoint)
			.header("accept", "application/json")
			.header("content-type", "application/x-www-form-urlencoded")
			.body(body)
			.send()
			.await?
			.error_for_status()?;
		Ok(serde_json::from_slice(&response.bytes().await?)?)
	}

	async fn login_start(self: &Arc<Self>) -> anyhow::Result<Response> {
		{
			let mut pending = self.pending.lock().unwrap();
			pending.retain(|_, p| p.expires_at > now().unwrap_or(u64::MAX));
		}
		let Ok(permit) = self.login_slots.clone().try_acquire_owned() else {
			return Ok(response(429, json!({"error":"too_many_pending_logins"})));
		};
		let grant = self
			.github_form(
				"https://github.com/login/device/code",
				&[("client_id", &self.config.client_id), ("scope", "read:org")],
			)
			.await?;
		let interval = grant["interval"]
			.as_u64()
			.context("missing polling interval")?
			.max(5);
		ensure!(interval <= MAX_LOGIN_SECONDS, "invalid polling interval");
		let lifetime = grant["expires_in"]
			.as_u64()
			.context("missing login expiry")?
			.min(MAX_LOGIN_SECONDS);
		ensure!(lifetime > 0, "invalid login expiry");
		let device_code = grant["device_code"]
			.as_str()
			.filter(|s| !s.is_empty() && s.len() <= 4096)
			.context("missing device code")?;
		let user_code = grant["user_code"]
			.as_str()
			.filter(|s| !s.is_empty() && s.len() <= 128)
			.context("missing user code")?;
		ensure!(
			grant["verification_uri"].as_str() == Some("https://github.com/login/device"),
			"invalid verification URI"
		);
		let handle = format!(
			"{TRANSACTION_PREFIX}{}",
			URL_SAFE_NO_PAD.encode(crate::crypto::rand::bytes(32)?)
		);
		let time = now()?;
		let transaction = Pending {
			device_code: device_code.into(),
			expires_at: deadline(time, lifetime)?,
			next_poll: deadline(time, interval)?,
			interval,
			polling: false,
			_permit: permit,
		};
		{
			let mut pending = self.pending.lock().unwrap();
			pending.retain(|_, p| p.expires_at > time);
			pending.insert(handle.clone(), transaction);
		}
		let state = Arc::downgrade(self);
		let cleanup_handle = handle.clone();
		tokio::spawn(async move {
			tokio::time::sleep(Duration::from_secs(lifetime)).await;
			if let Some(state) = state.upgrade() {
				state.pending.lock().unwrap().remove(&cleanup_handle);
			}
		});
		Ok(response(
			200,
			json!({"verification_uri":"https://github.com/login/device", "user_code":user_code, "transaction":handle, "interval":interval, "expires_in":lifetime}),
		))
	}

	async fn login_poll(&self, handle: &str) -> anyhow::Result<Response> {
		let device_code = {
			let time = now()?;
			let mut transactions = self.pending.lock().unwrap();
			transactions.retain(|_, p| p.expires_at > time);
			let Some(pending) = transactions.get_mut(handle) else {
				return Ok(response(401, json!({"error":"invalid_login_transaction"})));
			};
			if pending.polling || time < pending.next_poll {
				let interval = pending
					.next_poll
					.saturating_sub(time)
					.div_ceil(NANOS_PER_SECOND)
					.max(1);
				return Ok(response(
					202,
					json!({"status":"pending", "interval":interval}),
				));
			}
			pending.polling = true;
			pending.device_code.clone()
		};
		let grant = self
			.github_form(
				"https://github.com/login/oauth/access_token",
				&[
					("client_id", &self.config.client_id),
					("device_code", device_code.expose_secret()),
					("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
				],
			)
			.await;
		let time = now()?;
		let pending = {
			let mut transactions = self.pending.lock().unwrap();
			let Some(pending) = transactions.get_mut(handle) else {
				return Ok(response(401, json!({"error":"login_expired"})));
			};
			if pending.expires_at <= time {
				transactions.remove(handle);
				return Ok(response(401, json!({"error":"login_expired"})));
			}
			if let Ok(grant) = &grant {
				if let Some(error @ ("authorization_pending" | "slow_down")) = grant["error"].as_str() {
					let interval = pending.defer(error == "slow_down", time)?;
					return Ok(response(
						202,
						json!({"status":"pending", "interval":interval}),
					));
				}
			}
			transactions.remove(handle).expect("transaction exists")
		};
		let grant = grant?;
		if grant["error"].is_string() {
			return Ok(response(
				401,
				json!({"error":"authorization_denied_or_expired"}),
			));
		}
		let token = SecretString::from(
			grant["access_token"]
				.as_str()
				.context("missing access token")?
				.to_owned(),
		);
		let lifetime = match grant.get("expires_in") {
			None => None,
			Some(value) => Some(value.as_u64().context("invalid upstream expiry")?),
		};
		let upstream_expiry = lifetime
			.map(|seconds| deadline(time, seconds))
			.transpose()?;
		let identity = self
			.client
			.get("https://api.github.com/user")
			.header("accept", "application/json")
			.bearer_auth(token.expose_secret())
			.send()
			.await?
			.error_for_status()?
			.bytes()
			.await?;
		let identity: Value = serde_json::from_slice(&identity)?;
		let user_id = identity["id"].as_u64().context("missing user ID")?;
		if !self.config.allowed_user_ids.contains(&user_id) {
			return Ok(response(403, json!({"error":"user_not_allowed"})));
		}
		ensure!(now()? < pending.expires_at, "login expired");
		let envelope = self.envelope(user_id, token, upstream_expiry, now()?)?;
		Ok(response(
			200,
			json!({"credential":self.seal(&envelope)?, "expires_at":envelope.expiration().map(|n| n / NANOS_PER_SECOND),
			"login":identity["login"], "github_expires_in":lifetime, "refresh_token_received":grant["refresh_token"].is_string()}),
		))
	}
}

fn secure_transport(req: &Request) -> bool {
	if req.extensions().get::<TLSConnectionInfo>().is_some() {
		return true;
	}
	req
		.extensions()
		.get::<TCPConnectionInfo>()
		.is_some_and(|tcp| {
			tcp.local_addr.ip().is_loopback()
				&& tcp.peer_addr.ip().is_loopback()
				&& tcp.raw_peer_addr.is_none()
		})
}

fn bearer(req: &Request) -> anyhow::Result<&str> {
	ensure!(
		req.headers().get_all("authorization").iter().count() == 1,
		"invalid credential"
	);
	req
		.headers()
		.get("authorization")
		.and_then(|h| h.to_str().ok())
		.and_then(|h| h.strip_prefix("Bearer "))
		.filter(|h| !h.is_empty() && h.len() <= 16384)
		.context("invalid credential")
}

fn response(status: u16, body: Value) -> Response {
	let mut response = ::http::Response::builder()
		.status(status)
		.header("content-type", "application/json")
		.header("cache-control", "no-store")
		.body(serde_json::to_vec(&body).expect("JSON response").into())
		.expect("static response headers");
	response.extensions_mut().insert(SensitiveResponse);
	response
}

/// Marks direct responses whose JSON body must never be captured in diagnostics.
#[derive(Clone, Copy, Debug)]
pub(crate) struct SensitiveResponse;

#[derive(Clone, Debug)]
struct IngressCredential(Option<SecretString>);

fn has_copilot_bearer(req: &Request) -> bool {
	req.headers().get_all("authorization").iter().any(|value| {
		// A malformed authorization scheme must not expose an otherwise reusable token.
		[ENVELOPE_PREFIX, TRANSACTION_PREFIX].iter().any(|prefix| {
			value
				.as_bytes()
				.windows(prefix.len())
				.any(|bytes| bytes == prefix.as_bytes())
		})
	})
}

/// Remove recognized credentials before gateway policies, logging, or route selection.
/// Preserve invalid/duplicate input as a rejection rather than choosing one bearer.
pub(crate) fn protect_ingress_credential(req: &mut Request) {
	if has_copilot_bearer(req) {
		let credential = bearer(req)
			.ok()
			.map(|value| SecretString::from(value.to_owned()));
		req.headers_mut().remove("authorization");
		req.extensions_mut().insert(IngressCredential(credential));
	}
}

/// Identify login requests and issued bearers before route selection and tracing.
pub(crate) fn is_sensitive_request(req: &Request) -> bool {
	matches!(req.uri().path(), "/login/start" | "/login/poll")
		|| req.extensions().get::<IngressCredential>().is_some()
		|| has_copilot_bearer(req)
}

fn local_response(status: u16, body: Value) -> PolicyResponse {
	PolicyResponse::default().with_response(response(status, body))
}

pub(crate) fn has_verified(req: &Request) -> bool {
	req.extensions().get::<Verified>().is_some()
}

/// Recheck the policy and both deadlines at every dispatch, including retries.
pub(crate) fn request_token(req: &Request) -> anyhow::Result<&str> {
	request_token_at(req, now()?)
}

fn request_token_at(req: &Request, time: u64) -> anyhow::Result<&str> {
	let verified = req
		.extensions()
		.get::<Verified>()
		.context("verified Copilot user credential required")?;
	verified.state.validate(&verified.envelope, time)?;
	Ok(verified.envelope.upstream_token.expose_secret())
}

#[cfg(test)]
#[path = "copilot/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "copilot/proxy_tests.rs"]
mod proxy_tests;
