use super::*;

#[test]
fn expiry_is_exclusive_and_each_deadline_applies() {
	assert!(validate_deadlines(100, Some(110), Some(108), Some(10), 107).is_ok());
	assert!(validate_deadlines(100, Some(110), Some(108), Some(10), 108).is_err());
	assert!(validate_deadlines(100, Some(110), Some(120), Some(10), 110).is_err());
}

#[test]
fn disabled_gateway_expiry_still_honors_upstream_expiry() {
	assert!(validate_deadlines(100, None, None, None, 900).is_ok());
	assert!(validate_deadlines(100, None, Some(110), None, 109).is_ok());
	assert!(validate_deadlines(100, None, Some(110), None, 110).is_err());
}

#[test]
fn receiving_policy_checks_current_lifetime() {
	assert!(validate_deadlines(100, Some(110), None, None, 105).is_ok());
	assert!(validate_deadlines(100, None, None, Some(10), 105).is_err());
	assert!(validate_deadlines(100, Some(111), None, Some(10), 105).is_err());
	assert!(validate_deadlines(100, Some(110), None, Some(10), 99).is_err());
	assert!(validate_deadlines(100, Some(100), None, None, 100).is_err());
	assert!(validate_deadlines(100, None, Some(99), None, 100).is_err());
}

fn config(ttl: Option<Duration>) -> CopilotConfig {
	CopilotConfig {
		client_id: "synthetic-client".into(),
		audience: "https://copilot.test".into(),
		allowed_user_ids: vec![1, 2],
		credential_ttl: ttl,
		disable_expiry: ttl.is_none().then_some(true),
		policy_id: "namespace/policy".into(),
	}
}

fn policy(ttl: Option<Duration>) -> CopilotPolicy {
	CopilotPolicy::from_config(config(ttl), &[7; 32]).unwrap()
}

#[test]
fn envelope_survives_restart_and_rejects_other_trust_boundaries() {
	let p = policy(None);
	let state = p.state.as_ref().unwrap();
	let envelope = state
		.envelope(1, "synthetic-alice".into(), None, 100)
		.unwrap();
	let sealed = state.seal(&envelope).unwrap();
	assert!(policy(None).state.unwrap().open(&sealed, 101).is_ok());
	for field in ["policy", "audience", "key", "allowlist"] {
		let mut c = config(None);
		let mut key = [7; 32];
		match field {
			"policy" => c.policy_id = "other/policy".into(),
			"audience" => c.audience = "https://elsewhere.test".into(),
			"key" => key = [8; 32],
			"allowlist" => c.allowed_user_ids = vec![2],
			_ => unreachable!(),
		}
		let receiver = CopilotPolicy::from_config(c, &key).unwrap();
		assert!(
			receiver.state.unwrap().open(&sealed, 101).is_err(),
			"{field}"
		);
	}
	let mut tampered = URL_SAFE_NO_PAD
		.decode(sealed.strip_prefix(ENVELOPE_PREFIX).unwrap())
		.unwrap();
	tampered[20] ^= 1;
	assert!(
		state
			.open(
				&format!("{ENVELOPE_PREFIX}{}", URL_SAFE_NO_PAD.encode(tampered)),
				101
			)
			.is_err()
	);
}

#[test]
fn authenticated_metadata_and_future_issuance_are_checked() {
	let p = policy(None);
	let state = p.state.as_ref().unwrap();
	for field in ["version", "issuer", "purpose", "future", "token"] {
		let mut envelope = state
			.envelope(1, "synthetic-alice".into(), None, 100)
			.unwrap();
		match field {
			"version" => envelope.version = 2,
			"issuer" => envelope.issuer = "other".into(),
			"purpose" => envelope.purpose = "other".into(),
			"future" => envelope.issued_at = 200,
			"token" => envelope.upstream_token = "".into(),
			_ => unreachable!(),
		}
		assert!(
			state.open(&state.seal(&envelope).unwrap(), 101).is_err(),
			"{field}"
		);
	}
}

#[test]
fn issuance_rejects_overflow_and_expired_upstream_token() {
	let p = policy(Some(Duration::from_nanos(10)));
	let state = p.state.as_ref().unwrap();
	assert!(
		state
			.envelope(1, "synthetic".into(), None, u64::MAX - 5)
			.is_err()
	);
	assert!(
		state
			.envelope(1, "synthetic".into(), Some(100), 100)
			.is_err()
	);
	assert_eq!(
		state
			.envelope(1, "synthetic".into(), Some(108), 100)
			.unwrap()
			.expiration(),
		Some(108)
	);
}

#[test]
fn configuration_requires_explicit_lifetime_and_valid_key() {
	for length in [0, 31, 33] {
		assert!(CopilotPolicy::from_config(config(None), &vec![7; length]).is_err());
	}
	for case in [
		"missing",
		"both",
		"false",
		"zero",
		"empty-users",
		"zero-user",
		"empty-client",
		"empty-audience",
		"empty-policy",
		"overflow",
	] {
		let mut c = config(None);
		match case {
			"missing" => c.disable_expiry = None,
			"both" => c.credential_ttl = Some(Duration::from_secs(1)),
			"false" => c.disable_expiry = Some(false),
			"zero" => {
				c.disable_expiry = None;
				c.credential_ttl = Some(Duration::ZERO);
			},
			"empty-users" => c.allowed_user_ids.clear(),
			"zero-user" => c.allowed_user_ids = vec![0],
			"empty-client" => c.client_id.clear(),
			"empty-audience" => c.audience.clear(),
			"empty-policy" => c.policy_id.clear(),
			"overflow" => {
				c.disable_expiry = None;
				c.credential_ttl = Some(Duration::MAX);
			},
			_ => unreachable!(),
		}
		assert!(CopilotPolicy::from_config(c, &[7; 32]).is_err(), "{case}");
	}
}

#[test]
fn debug_and_runtime_serialization_do_not_reveal_credentials() {
	let p = CopilotPolicy::from_config(config(None), b"synthetic-key-marker-32-bytes!!!").unwrap();
	let state = p.state.as_ref().unwrap();
	let envelope = state
		.envelope(1, "synthetic-token-marker".into(), None, 100)
		.unwrap();
	let verified = Verified {
		state: state.clone(),
		envelope: Arc::new(envelope),
	};
	let invalid = CopilotPolicy::invalid("synthetic-resolver-secret".into());
	let debug = format!("{p:?} {verified:?} {invalid:?}");
	let serialized = format!(
		"{} {}",
		serde_json::to_string(&p).unwrap(),
		serde_json::to_string(&invalid).unwrap()
	);
	for output in [&debug, &serialized] {
		for marker in [
			"synthetic-key-marker",
			"synthetic-token-marker",
			"synthetic-resolver-secret",
		] {
			assert!(!output.contains(marker));
		}
	}
}

fn request(path: &str, method: &str, credential: Option<&str>) -> Request {
	let mut builder = ::http::Request::builder().uri(path).method(method);
	if let Some(credential) = credential {
		builder = builder.header("authorization", format!("Bearer {credential}"));
	}
	{
		let mut req = builder.body(crate::http::Body::empty()).unwrap();
		req.extensions_mut().insert(TCPConnectionInfo {
			peer_addr: "127.0.0.1:10000".parse().unwrap(),
			local_addr: "127.0.0.1:18765".parse().unwrap(),
			start: std::time::Instant::now(),
			raw_peer_addr: None,
		});
		req
	}
}

#[tokio::test]
async fn ingress_capture_preserves_authentication_and_duplicate_rejection() {
	let policy = policy(None);
	let credential = policy
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	for duplicate in [false, true] {
		let mut req = request("/v1/chat/completions", "POST", Some(&credential));
		if duplicate {
			req
				.headers_mut()
				.append("authorization", "Bearer another".parse().unwrap());
		}
		protect_ingress_credential(&mut req);
		assert!(!req.headers().contains_key("authorization"));
		assert!(!format!("{:?}", req.extensions().get::<IngressCredential>()).contains(&credential));
		let _ = policy.authenticate(&mut req).await;
		assert_eq!(has_verified(&req), !duplicate);
	}
	let mut ordinary = request("/login/poll", "POST", Some("ordinary-auth"));
	protect_ingress_credential(&mut ordinary);
	assert_eq!(ordinary.headers()["authorization"], "Bearer ordinary-auth");
	let mut malformed = request("/v1/chat/completions", "POST", None);
	malformed.headers_mut().insert(
		"authorization",
		format!("bearer {credential}").parse().unwrap(),
	);
	protect_ingress_credential(&mut malformed);
	assert!(!malformed.headers().contains_key("authorization"));
	assert!(
		policy
			.authenticate(&mut malformed)
			.await
			.direct_response
			.is_some()
	);
	let mut replaced = request("/v1/chat/completions", "POST", Some(&credential));
	protect_ingress_credential(&mut replaced);
	replaced
		.headers_mut()
		.insert("authorization", "Bearer replacement".parse().unwrap());
	assert!(
		policy
			.authenticate(&mut replaced)
			.await
			.direct_response
			.is_some()
	);
}

#[tokio::test]
async fn policy_requires_credential_and_strips_it_before_continuing() {
	let p = policy(None);
	let credential = p
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	let mut req = request("/v1/chat/completions", "POST", Some(&credential));
	assert!(p.authenticate(&mut req).await.direct_response.is_none());
	assert!(!req.headers().contains_key("authorization"));
	assert!(has_verified(&req));
	assert_eq!(request_token(&req).unwrap(), "synthetic-alice");
	let mut missing = request("/v1/chat/completions", "POST", None);
	assert_eq!(
		p.authenticate(&mut missing)
			.await
			.direct_response
			.unwrap()
			.status(),
		401
	);
	assert!(request_token(&missing).is_err());
}

#[tokio::test]
async fn invalid_credentials_and_duplicate_headers_never_reach_dispatch() {
	let p = policy(None);
	let credential = p
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	let mut req = request("/v1/chat/completions", "POST", Some(&credential));
	req
		.headers_mut()
		.append("authorization", "Bearer another".parse().unwrap());
	assert_eq!(
		p.authenticate(&mut req)
			.await
			.direct_response
			.unwrap()
			.status(),
		401
	);
	assert!(!has_verified(&req));
	assert!(!req.headers().contains_key("authorization"));
	let mut req = request(
		"/v1/chat/completions",
		"POST",
		Some("plaintext-github-token"),
	);
	assert_eq!(
		p.authenticate(&mut req)
			.await
			.direct_response
			.unwrap()
			.status(),
		401
	);
	assert!(request_token(&req).is_err());
	let mut req = request("/v1/chat/completions", "POST", Some(&credential));
	assert_eq!(
		CopilotPolicy::invalid("safe".into())
			.authenticate(&mut req)
			.await
			.direct_response
			.unwrap()
			.status(),
		500
	);
	assert!(!req.headers().contains_key("authorization"));
}

#[tokio::test]
async fn login_rejects_browser_origin_and_invalid_methods_without_network() {
	let p = policy(None);
	for path in ["/login/start", "/login/poll"] {
		let mut req = request(path, "GET", None);
		let resp = p.authenticate(&mut req).await.direct_response.unwrap();
		assert_eq!(resp.status(), 405);
		assert_eq!(resp.headers()["cache-control"], "no-store");
		let mut req = request(path, "POST", None);
		req
			.headers_mut()
			.insert("origin", "https://browser.test".parse().unwrap());
		assert_eq!(
			p.authenticate(&mut req)
				.await
				.direct_response
				.unwrap()
				.status(),
			403
		);
	}
	let mut req = request("/login/poll", "POST", Some("unknown-transaction"));
	assert_eq!(
		p.authenticate(&mut req)
			.await
			.direct_response
			.unwrap()
			.status(),
		401
	);
}

#[tokio::test]
async fn current_allowlist_returns_admission_denial() {
	let issuer = policy(None);
	let credential = issuer
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	let mut c = config(None);
	c.allowed_user_ids = vec![2];
	let receiver = CopilotPolicy::from_config(c, &[7; 32]).unwrap();
	let mut req = request("/v1/chat/completions", "POST", Some(&credential));
	assert_eq!(
		receiver
			.authenticate(&mut req)
			.await
			.direct_response
			.unwrap()
			.status(),
		403
	);
}

#[tokio::test]
async fn local_key_is_raw_bytes_and_inline_is_rejected_without_echoing_it() {
	let directory = tempfile::tempdir().unwrap();
	let key_path = directory.path().join("synthetic-key");
	std::fs::write(&key_path, [0xff; 32]).unwrap();
	let value = json!({"clientId":"synthetic-client", "audience":"gateway", "allowedUserIds":[1], "disableExpiry":true, "encryptionKey":{"file":key_path}});
	let local: LocalCopilotConfig = serde_json::from_value(value).unwrap();
	assert!(
		local
			.compile(&ResourceFetcher::files_only(), "route/policy".into())
			.await
			.is_ok()
	);
	let value = json!({"clientId":"synthetic-client", "audience":"gateway", "allowedUserIds":[1], "credentialTTL":"1s", "encryptionKey":"synthetic-inline-secret"});
	let local: LocalCopilotConfig = serde_json::from_value(value).unwrap();
	assert!(!format!("{local:?}").contains("synthetic-inline-secret"));
	let error = local
		.compile(&ResourceFetcher::files_only(), "route/policy".into())
		.await
		.unwrap_err();
	assert!(!format!("{error:#}").contains("synthetic-inline-secret"));
}

#[test]
fn downstream_transport_cannot_be_spoofed_by_forwarded_headers() {
	let mut req = ::http::Request::builder()
		.uri("https://gateway.test/login/start")
		.header("x-forwarded-proto", "https")
		.header("forwarded", "proto=https")
		.body(crate::http::Body::empty())
		.unwrap();
	assert!(!secure_transport(&req));
	req.extensions_mut().insert(TCPConnectionInfo {
		peer_addr: "203.0.113.1:10000".parse().unwrap(),
		local_addr: "127.0.0.1:18765".parse().unwrap(),
		start: std::time::Instant::now(),
		raw_peer_addr: None,
	});
	assert!(!secure_transport(&req));
	req
		.extensions_mut()
		.get_mut::<TCPConnectionInfo>()
		.unwrap()
		.peer_addr = "127.0.0.1:10000".parse().unwrap();
	assert!(secure_transport(&req));
	req
		.extensions_mut()
		.get_mut::<TCPConnectionInfo>()
		.unwrap()
		.raw_peer_addr = Some("203.0.113.2:10000".parse().unwrap());
	assert!(!secure_transport(&req));
	req
		.extensions_mut()
		.get_mut::<TCPConnectionInfo>()
		.unwrap()
		.raw_peer_addr = Some("127.0.0.1:10000".parse().unwrap());
	assert!(!secure_transport(&req));
	req.extensions_mut().insert(TLSConnectionInfo::default());
	assert!(secure_transport(&req));
}

#[tokio::test]
async fn bounded_pending_logins_and_poll_intervals_need_no_network() {
	let p = policy(None);
	let state = p.state.as_ref().unwrap();
	let time = now().unwrap();
	for n in 0..MAX_PENDING {
		state.pending.lock().unwrap().insert(
			format!("transaction-{n}"),
			Pending {
				device_code: "synthetic-device-code".into(),
				expires_at: deadline(time, 900).unwrap(),
				next_poll: deadline(time, 10).unwrap(),
				interval: 10,
				polling: false,
				_permit: state.login_slots.clone().try_acquire_owned().unwrap(),
			},
		);
	}
	assert_eq!(state.login_start().await.unwrap().status(), 429);
	assert_eq!(
		state.login_poll("transaction-0").await.unwrap().status(),
		202
	);
	assert_eq!(state.pending.lock().unwrap().len(), MAX_PENDING);
	{
		let mut pending = state.pending.lock().unwrap();
		let transaction = pending.get_mut("transaction-0").unwrap();
		transaction.next_poll = 0;
		transaction.polling = true;
	}
	assert_eq!(
		state.login_poll("transaction-0").await.unwrap().status(),
		202
	);
	state
		.pending
		.lock()
		.unwrap()
		.get_mut("transaction-0")
		.unwrap()
		.expires_at = 0;
	assert_eq!(
		state.login_poll("transaction-0").await.unwrap().status(),
		401
	);
	assert_eq!(state.login_slots.available_permits(), 1);
}

#[test]
fn slow_down_delays_next_poll_and_checks_overflow() {
	let slots = Arc::new(tokio::sync::Semaphore::new(1));
	let mut pending = Pending {
		device_code: "synthetic-device-code".into(),
		expires_at: u64::MAX,
		next_poll: 0,
		interval: 5,
		polling: true,
		_permit: slots.try_acquire_owned().unwrap(),
	};
	assert_eq!(pending.defer(true, 100).unwrap(), 10);
	assert_eq!(pending.next_poll, 100 + 10 * NANOS_PER_SECOND);
	assert!(!pending.polling);
	assert_eq!(pending.defer(false, 200).unwrap(), 10);
	assert_eq!(pending.defer(true, 300).unwrap(), 15);
	assert!(pending.defer(false, u64::MAX).is_err());
}

#[test]
fn retry_rechecks_deadlines_without_extending_credential_lifetime() {
	let p = policy(Some(Duration::from_nanos(10)));
	let state = p.state.as_ref().unwrap();
	let envelope = state
		.envelope(1, "synthetic-alice".into(), None, 100)
		.unwrap();
	let mut req = request("/v1/chat/completions", "POST", None);
	req.extensions_mut().insert(Verified {
		state: state.clone(),
		envelope: Arc::new(envelope),
	});
	assert_eq!(request_token_at(&req, 109).unwrap(), "synthetic-alice");
	assert!(request_token_at(&req, 110).is_err());
	assert!(request_token_at(&req, 111).is_err());
}

#[tokio::test]
async fn concurrent_users_keep_request_credentials_separate() {
	let policy = policy(None);
	let alice = policy
		.test_credential(1, "synthetic-alice", SystemTime::now(), None)
		.unwrap();
	let bob = policy
		.test_credential(2, "synthetic-bob", SystemTime::now(), None)
		.unwrap();
	let mut requests = Vec::new();
	for i in 0..12 {
		let (credential, expected) = if i % 2 == 0 {
			(alice.clone(), "synthetic-alice")
		} else {
			(bob.clone(), "synthetic-bob")
		};
		let policy = policy.clone();
		requests.push(tokio::spawn(async move {
			let mut req = request("/v1/chat/completions", "POST", Some(&credential));
			assert!(
				policy
					.authenticate(&mut req)
					.await
					.direct_response
					.is_none()
			);
			assert_eq!(request_token(&req).unwrap(), expected);
			assert!(!req.headers().contains_key("authorization"));
		}));
	}
	for request in requests {
		request.await.unwrap();
	}
}

#[test]
fn encrypted_parse_errors_do_not_echo_plaintext() {
	let p = policy(None);
	let state = p.state.as_ref().unwrap();
	let malformed = br#"{"version":"synthetic-secret-marker"}"#;
	let sealed = format!(
		"{ENVELOPE_PREFIX}{}",
		URL_SAFE_NO_PAD.encode(state.key.seal(malformed).unwrap())
	);
	let error = state.open(&sealed, 100).unwrap_err();
	assert!(!format!("{error:#}").contains("synthetic-secret-marker"));
}

#[test]
fn issued_envelopes_have_recognizable_prefix_for_early_trace_redaction() {
	let p = policy(None);
	let state = p.state.as_ref().unwrap();
	let envelope = state
		.envelope(1, "synthetic-alice".into(), None, 100)
		.unwrap();
	let sealed = state.seal(&envelope).unwrap();
	assert!(sealed.starts_with("agw_cp1."));
	assert!(
		state
			.open(sealed.trim_start_matches("agw_cp1."), 101)
			.is_err()
	);
}

#[test]
fn sensitive_login_and_credential_requests_are_detected_before_routing() {
	for path in ["/login/start", "/login/poll"] {
		assert!(is_sensitive_request(&request(path, "POST", None)));
	}
	assert!(!is_sensitive_request(&request("/normal", "GET", None)));
	assert!(!is_sensitive_request(&request(
		"/normal",
		"GET",
		Some("unrelated-token")
	)));
	let mut req = request("/v1/chat/completions", "POST", Some("unrelated-token"));
	req
		.headers_mut()
		.append("authorization", "Bearer agw_cp1.synthetic".parse().unwrap());
	assert!(is_sensitive_request(&req));
}

#[test]
fn all_local_responses_mark_credential_bodies_as_sensitive() {
	for status in [200, 202, 401, 403, 405, 429, 500, 502] {
		let response = response(status, json!({"credential":"synthetic-credential"}));
		assert!(response.extensions().get::<SensitiveResponse>().is_some());
		assert_eq!(response.headers()["cache-control"], "no-store");
	}
}
