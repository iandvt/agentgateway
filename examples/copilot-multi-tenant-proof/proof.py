#!/usr/bin/env python3
"""Native Copilot policy tests or a fresh device login with Python and curl."""
import argparse
import contextlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
WORKTREE = ROOT.parents[1]
BINARY = WORKTREE / "target/debug/agentgateway"
ARTIFACTS = WORKTREE / "target/copilot-proof"
GATEWAY_PORT = 18765
LOCAL_URL = "http://127.0.0.1:" + str(GATEWAY_PORT)
MODEL = "gpt-4o-mini"
TOKEN_ENV = ("GH_COPILOT_TOKEN", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "SSLKEYLOGFILE")


class ProofError(Exception):
    """Messages must contain only public operation names and statuses."""


def check(condition, message):
    if not condition:
        raise ProofError(message)


def clean_environment():
    environment = os.environ.copy()
    for name in TOKEN_ENV:
        environment.pop(name, None)
    return environment


class Client:
    def __init__(self, base_url, ca_file=None):
        self.base_url = base_url.rstrip("/")
        self.url = urlsplit(self.base_url)
        self.ca_file = ca_file
        # An explicit context avoids SSLKEYLOGFILE enabling credential-bearing TLS logs.
        self.context = None
        if self.url.scheme == "https":
            self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            if ca_file:
                self.context.load_verify_locations(cafile=ca_file)
            else:
                self.context.load_default_certs()

    def request(self, path, credential=None, payload=None, method="POST", timeout=60):
        headers = {"Content-Type": "application/json"}
        if credential is not None:
            headers["Authorization"] = "Bearer " + credential
        body = None if payload is None else json.dumps(payload).encode()
        if self.context:
            connection = http.client.HTTPSConnection(self.url.hostname, self.url.port,
                                                    timeout=timeout, context=self.context)
        else:
            connection = http.client.HTTPConnection(self.url.hostname, self.url.port, timeout=timeout)
        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def json_request(self, path, credential=None):
        status, raw = self.request(path, credential)
        try:
            return status, json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise ProofError("Expected JSON from native login endpoint") from None


def parse_sse(status, raw):
    text = []
    finish = None
    done = False
    try:
        for line in raw.decode().splitlines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                done = True
                continue
            event = json.loads(data)
            for choice in event.get("choices", []):
                content = choice.get("delta", {}).get("content")
                if isinstance(content, str):
                    text.append(content)
                if choice.get("finish_reason") is not None:
                    finish = choice["finish_reason"]
    except (ValueError, UnicodeDecodeError, AttributeError, TypeError):
        raise ProofError("Invalid inference SSE response") from None
    return {"status": status, "text": "".join(text), "finish_reason": finish, "DONE": done}


def inference_payload():
    return {"model": MODEL, "messages": [{"role": "user", "content": "Reply with exactly OK."}],
            "stream": True, "max_completion_tokens": 128}


def inference(client, credential):
    status, raw = client.request("/v1/chat/completions", credential, inference_payload())
    return parse_sse(status, raw)


def verify_stream(result):
    check(result["status"] == 200, "Inference did not return HTTP 200")
    check(bool(result["text"]), "Inference returned empty text")
    check(result["finish_reason"] == "stop", "Inference did not finish with stop")
    check(result["DONE"], "Inference did not emit DONE")


def gateway_config(key_path, ttl):
    policy = {"clientId": "Ov23liBhXifrbEyuGaF1", "audience": LOCAL_URL,
              "allowedUserIds": [25870869], "encryptionKey": {"file": str(key_path)}}
    policy.update({"disableExpiry": True} if ttl == "none" else {"credentialTTL": ttl})
    return {
        "config": {"adminAddr": "off", "statsAddr": "off", "readinessAddr": "off"},
        "gateways": {"default": {"bindAddress": "127.0.0.1", "port": GATEWAY_PORT}},
        "routes": [
            {"name": "health", "gateways": ["default"],
             "matches": [{"path": {"exact": "/health"}}],
             "policies": {"directResponse": {"status": 200, "body": "ok"}}},
            {"name": "copilot", "gateways": ["default"],
             "matches": [{"path": {"pathPrefix": "/login"}}, {"path": {"pathPrefix": "/v1"}}],
             "policies": {"copilot": policy},
             "backends": [{"ai": {"name": "native-copilot-proof",
                                   "provider": {"copilot": {"model": MODEL}},
                                   "policies": {"backendAuth": "copilotUser"}}}]},
        ],
    }


@contextlib.contextmanager
def gateway_process(client, config_path):
    check(BINARY.is_file(), "Native gateway binary has not been built")
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", GATEWAY_PORT))
        except OSError:
            raise ProofError("The loopback gateway port is already occupied") from None
    environment = clean_environment()
    environment.update({"ADMIN_ADDR": "off", "STATS_ADDR": "off", "READINESS_ADDR": "off"})
    process = subprocess.Popen([str(BINARY), "--file", str(config_path)],
                               env=environment, cwd=ROOT, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            check(process.poll() is None, "Native gateway exited during startup")
            try:
                status, _ = client.request("/health", method="GET", timeout=0.3)
                if status == 200:
                    break
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.1)
        else:
            raise ProofError("Native gateway did not become healthy")
        yield
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


@contextlib.contextmanager
def gateway(client, ttl):
    with tempfile.TemporaryDirectory(prefix="copilot-proof-") as directory:
        key_path = Path(directory) / "encryption.key"
        with os.fdopen(os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as key:
            key.write(os.urandom(32))
        config_path = Path(directory) / "config.json"
        config_path.write_text(json.dumps(gateway_config(key_path, ttl)) + "\n")
        with contextlib.ExitStack() as process:
            def restart(new_key=False):
                process.close()
                if new_key:
                    key_path.write_bytes(os.urandom(32))
                process.enter_context(gateway_process(client, config_path))
            restart()
            yield restart


def check_restart_lifetime(expires_at):
    check(expires_at is None or time.time() < expires_at,
          "Credential expired during restart checks; repeat with sufficient lifetime")


def mock_proof():
    command = ["cargo", "+1.98.0", "test", "--offline", "--locked", "-p", "agentgateway",
               "--no-default-features", "--features", "crypto-aws-lc", "--lib", "copilot"]
    completed = subprocess.run(command, cwd=WORKTREE, env=clean_environment(),
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = completed.stdout.decode(errors="replace")
    print(output, end="", flush=True)
    check(completed.returncode == 0, "Native Copilot tests failed")
    match = re.search(r"test result: ok\. (\d+) passed;", output)
    check(match is not None and int(match[1]) > 0, "Native Copilot test selection ran no tests")
    return {"mode": "native_tests", "passed": True, "command": command,
            "exit_code": completed.returncode, "tests_passed": int(match[1])}


def curl_inference(client, credential):
    check("\n" not in credential and "\r" not in credential, "Invalid credential framing")
    def quote(value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'
    lines = ["url = " + quote(client.base_url + "/v1/chat/completions"),
             'request = "POST"', 'header = "Content-Type: application/json"',
             "header = " + quote("Authorization: Bearer " + credential),
             "data = " + quote(json.dumps(inference_payload())),
             'write-out = "\\nPROOF_HTTP_STATUS:%{http_code}\\n"',
             'max-time = "60"', "silent", "show-error", "no-buffer", 'noproxy = "*"']
    if client.ca_file:
        lines.append("cacert = " + quote(client.ca_file))
    completed = subprocess.run(["curl", "--disable", "--config", "-"],
                               input=("\n".join(lines) + "\n").encode(), env=clean_environment(),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=65)
    check(completed.returncode == 0, "curl inference process failed")
    try:
        raw, trailer = completed.stdout.rsplit(b"\nPROOF_HTTP_STATUS:", 1)
        status = int(trailer.strip())
    except (ValueError, TypeError):
        raise ProofError("curl status trailer missing") from None
    return parse_sse(status, raw)


def live_proof(base_url, ca_file, ttl):
    client = Client(base_url or LOCAL_URL, ca_file)
    lifetime = ttl or "none"
    with (contextlib.nullcontext() if base_url else gateway(client, lifetime)) as restart:
        status, _ = client.request("/health", method="GET")
        check(status == 200, "Unauthenticated health route failed")
        status, _ = client.request("/v1/chat/completions", payload=inference_payload())
        check(status == 401, "Copilot route did not reject a missing credential")
        status, login = client.json_request("/login/start")
        check(status == 200, "Native login start failed")
        print("verification_uri: " + str(login["verification_uri"]), flush=True)
        print("user_code: " + str(login["user_code"]), flush=True)
        transaction = login["transaction"]
        interval = max(1, int(login.get("interval", 5)))
        deadline = time.monotonic() + int(login.get("expires_in", 900))
        while time.monotonic() < deadline:
            time.sleep(interval)
            status, polled = client.json_request("/login/poll", transaction)
            if status == 202:
                interval = max(1, int(polled.get("interval", interval)))
                continue
            check(status == 200, "Native login poll failed")
            credential = polled["credential"]
            break
        else:
            raise ProofError("Native device login expired before authorization")
        api_result = inference(client, credential)
        verify_stream(api_result)
        print("Python API: " + json.dumps(api_result), flush=True)
        cli_result = curl_inference(client, credential)
        verify_stream(cli_result)
        print("curl CLI: " + json.dumps(cli_result), flush=True)
        same_key_restart = None
        changed_key_rejection = None
        if restart is not None:
            check_restart_lifetime(polled.get("expires_at"))
            restart()
            check_restart_lifetime(polled.get("expires_at"))
            same_key_restart = inference(client, credential)
            verify_stream(same_key_restart)
            print("Same-key restart API: " + json.dumps(same_key_restart), flush=True)
            restart(new_key=True)
            check_restart_lifetime(polled.get("expires_at"))
            status, _ = client.request("/v1/chat/completions", credential, inference_payload())
            check_restart_lifetime(polled.get("expires_at"))
            check(status == 401, "Changed gateway key did not reject the previous credential")
            changed_key_rejection = {"status": status, "passed": True}
            print("Changed-key rejection: HTTP 401", flush=True)
        return {"mode": "live", "passed": True, "api": api_result, "cli": cli_result,
                "same_key_restart": same_key_restart, "changed_key_rejection": changed_key_rejection,
                "endpoint": client.base_url, "health_status": 200, "missing_credential_status": 401,
                "effective_expires_at": polled.get("expires_at"),
                "gateway_ttl": "externally configured" if base_url else lifetime,
                "github_expires_in": polled.get("github_expires_in"),
                "refresh_token_received": bool(polled.get("refresh_token_received")),
                "host_credential_environment_removed": list(TOKEN_ENV)}


def save_result(result):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    path = ARTIFACTS / "native-results.json"
    existing = json.loads(path.read_text()) if path.exists() else {}
    result["recorded_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    existing[result["mode"]] = result
    path.write_text(json.dumps(existing, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--mock", action="store_true", help="Run native synthetic Rust tests (default)")
    modes.add_argument("--live", action="store_true", help="Request a fresh GitHub device login")
    parser.add_argument("--base-url", help="Existing HTTPS gateway origin; start no local gateway")
    parser.add_argument("--ca-file", help="CA certificate file for the existing HTTPS gateway")
    parser.add_argument("--ttl", help="Local gateway credential lifetime: none (default), or e.g. 5m")
    arguments = parser.parse_args()
    if not arguments.live and any(value is not None for value in (arguments.base_url, arguments.ca_file, arguments.ttl)):
        parser.error("--base-url, --ca-file, and --ttl require --live")
    if arguments.ca_file and not arguments.base_url:
        parser.error("--ca-file requires --base-url")
    if arguments.base_url is not None:
        try:
            url = urlsplit(arguments.base_url)
            port = url.port
        except ValueError:
            parser.error("--base-url contains an invalid host or port")
        if (url.scheme != "https" or not url.hostname or port == 0 or url.username is not None
                or url.password is not None or url.path not in ("", "/") or url.query or url.fragment
                or any(character.isspace() for character in arguments.base_url)):
            parser.error("--base-url must be an HTTPS origin without credentials, path, query, or fragment")
        if arguments.ttl is not None:
            parser.error("--ttl configures only a local gateway; set the existing gateway policy lifetime")
    if arguments.ttl is not None and arguments.ttl != "none" and not re.fullmatch(r"[1-9][0-9]*[smhd]", arguments.ttl):
        parser.error("--ttl must be none or a positive whole duration such as 30s, 5m, 1h, or 1d")
    mode = "live" if arguments.live else "native_tests"
    try:
        result = live_proof(arguments.base_url, arguments.ca_file, arguments.ttl) if arguments.live else mock_proof()
        save_result(result)
        print(mode + " passed; target/copilot-proof/native-results.json contains the credential-free summary", flush=True)
        return 0
    except KeyboardInterrupt:
        result = {"mode": mode, "passed": False, "error": "Interrupted by operator"}
    except ProofError as error:
        result = {"mode": mode, "passed": False, "error": str(error)}
    except Exception as error:
        result = {"mode": mode, "passed": False, "error": "Unexpected " + type(error).__name__}
    save_result(result)
    print(result["error"], file=sys.stderr, flush=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
