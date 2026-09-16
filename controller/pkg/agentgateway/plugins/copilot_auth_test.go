package plugins

import (
	"bytes"
	"encoding/json"
	"github.com/agentgateway/agentgateway/api"
	"github.com/agentgateway/agentgateway/controller/pkg/utils/kubeutils"
	"github.com/agentgateway/agentgateway/controller/pkg/wellknown"
	"google.golang.org/protobuf/encoding/protojson"
	"istio.io/istio/pkg/kube/krt"
	"istio.io/istio/pkg/test/util/assert"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	gwv1 "sigs.k8s.io/gateway-api/apis/v1"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/agentgateway/agentgateway/controller/api/v1alpha1/agentgateway"
)

func TestCopilotMissingSecretRetainsAuthentication(t *testing.T) {
	policy := &agentgateway.AgentgatewayPolicy{Namespace: "default", Name: "copilot-users"}
	if err := json.Unmarshal([]byte(`{"traffic":{"copilot":{"clientId":"test-client","audience":"https://copilot.example","allowedUserIds":[1],"disableExpiry":true,"encryptionKeyRef":{"name":"copilot-encryption"}}}}`), &policy.Spec); err != nil {
		t.Fatal(err)
	}
	policies, err := TranslatePolicyToAgw(oauthTestPolicyCtx(t), policy)
	if err == nil || len(policies) != 1 {
		t.Fatalf("missing Secret must retain an error-bearing authentication policy: policies=%d, err=%v", len(policies), err)
	}
}

func TestCopilotUserBackendTranslation(t *testing.T) {
	policy := &agentgateway.AgentgatewayPolicy{Namespace: "default", Name: "copilot-users"}
	if err := json.Unmarshal([]byte(`{"backend":{"auth":{"copilotUser":{}}}}`), &policy.Spec); err != nil {
		t.Fatal(err)
	}
	translated, err := translateBackendAuth(oauthTestPolicyCtx(t), policy, "default/copilot-users")
	if err != nil || translated == nil || translated.GetBackend().GetAuth().GetCopilotUser() == nil || translated.GetBackend().GetAuth().GetCopilotUser().TranslationError != nil {
		t.Fatalf("copilotUser must produce backend authentication: policy=%v, err=%v", translated, err)
	}
}

func copilotTestPolicy() *agentgateway.AgentgatewayPolicy {
	return &agentgateway.AgentgatewayPolicy{
		Name: "copilot-users", Namespace: "default",
		Spec: agentgateway.AgentgatewayPolicySpec{Traffic: &agentgateway.Traffic{Copilot: &agentgateway.CopilotAuthentication{
			ClientID: "test-client", Audience: "https://copilot.example", AllowedUserIDs: []int64{1, 2},
			DisableExpiry: new(true), EncryptionKeyRef: agentgateway.LocalSecretKeyRef{Name: "copilot-encryption"},
		}}},
	}
}

func copilotTestSecret(size int) *corev1.Secret {
	return &corev1.Secret{Name: "copilot-encryption", Namespace: "default", Data: map[string][]byte{"key": bytes.Repeat([]byte{0xa5}, size)}}
}

func TestCopilotAuthenticationTranslation(t *testing.T) {
	for _, tc := range []struct {
		name    string
		modify  func(*agentgateway.AgentgatewayPolicy)
		secret  *corev1.Secret
		wantErr string
	}{
		{name: "valid", secret: copilotTestSecret(32)},
		{name: "finite", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) {
			p.Spec.Traffic.Copilot.DisableExpiry = nil
			p.Spec.Traffic.Copilot.CredentialTTL = &agentgateway.Duration{Duration: time.Hour}
		}},
		{name: "explicit key", secret: &corev1.Secret{Name: "copilot-encryption", Namespace: "default", Data: map[string][]byte{"custom": bytes.Repeat([]byte{0xa5}, 32)}}, modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.EncryptionKeyRef.Key = new("custom") }},
		{name: "missing Secret", wantErr: "failed to resolve copilot encryption Secret"},
		{name: "missing key", secret: &corev1.Secret{Name: "copilot-encryption", Namespace: "default"}, wantErr: "exactly 32 bytes"},
		{name: "short key", secret: copilotTestSecret(31), wantErr: "exactly 32 bytes"},
		{name: "long key", secret: copilotTestSecret(33), wantErr: "exactly 32 bytes"},
		{name: "other namespace", secret: &corev1.Secret{Name: "copilot-encryption", Namespace: "another", Data: map[string][]byte{"key": make([]byte, 32)}}, wantErr: "failed to resolve"},
		{name: "both lifetimes", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) {
			p.Spec.Traffic.Copilot.CredentialTTL = &agentgateway.Duration{Duration: time.Hour}
		}, wantErr: "exactly one"},
		{name: "neither lifetime", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.DisableExpiry = nil }, wantErr: "exactly one"},
		{name: "false expiry", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.DisableExpiry = new(false) }, wantErr: "disableExpiry must be true"},
		{name: "zero TTL", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) {
			p.Spec.Traffic.Copilot.DisableExpiry = nil
			p.Spec.Traffic.Copilot.CredentialTTL = &agentgateway.Duration{}
		}, wantErr: "credentialTTL must be positive"},
		{name: "negative TTL", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) {
			p.Spec.Traffic.Copilot.DisableExpiry = nil
			p.Spec.Traffic.Copilot.CredentialTTL = &agentgateway.Duration{Duration: -time.Second}
		}, wantErr: "credentialTTL must be positive"},
		{name: "empty allowlist", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.AllowedUserIDs = nil }, wantErr: "positive IDs"},
		{name: "zero user", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.AllowedUserIDs = []int64{0} }, wantErr: "must be positive"},
		{name: "negative user", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.AllowedUserIDs = []int64{-1} }, wantErr: "must be positive"},
		{name: "empty client", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.ClientID = "" }, wantErr: "clientId must"},
		{name: "empty audience", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) { p.Spec.Traffic.Copilot.Audience = "" }, wantErr: "audience must"},
		{name: "pre-routing", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) {
			p.Spec.Traffic.Phase = new(agentgateway.PolicyPhasePreRouting)
		}, wantErr: "requires PostRouting"},
		{name: "custom credential kind", secret: copilotTestSecret(32), modify: func(p *agentgateway.AgentgatewayPolicy) {
			p.Spec.Traffic.Copilot.EncryptionKeyRef.Group = "custom.example"
			p.Spec.Traffic.Copilot.EncryptionKeyRef.Kind = "Credential"
		}, wantErr: "same-namespace Secret"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := copilotTestPolicy()
			if tc.modify != nil {
				tc.modify(policy)
			}
			var secrets []*corev1.Secret
			if tc.secret != nil {
				secrets = append(secrets, tc.secret)
			}
			policies, err := TranslatePolicyToAgw(oauthTestPolicyCtx(t, secrets...), policy)
			if len(policies) != 1 || policies[0].GetTraffic().GetCopilot() == nil {
				t.Fatalf("authentication was dropped: count=%d err=%v", len(policies), err)
			}
			got := policies[0].GetTraffic().GetCopilot()
			if got.PolicyId != getTrafficPolicyName("default", "copilot-users")+copilotPolicySuffix || got.PolicyId != policies[0].Key {
				t.Fatal("policy identity was not preserved")
			}
			if policies[0].GetTraffic().Phase != api.TrafficPolicySpec_ROUTE {
				t.Fatal("Copilot must always execute after routing")
			}
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) || got.TranslationError == nil || len(got.EncryptionKey) != 0 {
					t.Fatalf("expected retained sanitized denial for %q: err=%v", tc.wantErr, err)
				}
				return
			}
			if err != nil || got.TranslationError != nil {
				t.Fatalf("unexpected translation error: %v", err)
			}
			if !bytes.Equal(got.EncryptionKey, bytes.Repeat([]byte{0xa5}, 32)) || !slices.Equal(got.AllowedUserIds, []uint64{1, 2}) || got.ClientId != "test-client" || got.Audience != "https://copilot.example" {
				t.Fatal("translated configuration differs")
			}
			if ttl := policy.Spec.Traffic.Copilot.CredentialTTL; ttl != nil {
				if got.GetCredentialTtl().AsDuration() != ttl.Duration {
					t.Fatal("TTL was not preserved")
				}
			} else if !got.GetDisableExpiry() {
				t.Fatal("explicitly disabled expiry was not preserved")
			}
		})
	}
}

func TestCopilotResolverErrorIsSanitized(t *testing.T) {
	ctx := oauthTestPolicyCtx(t)
	ctx.CredentialResolver = jwtSignErrorCredentialResolver{}
	policies, err := TranslatePolicyToAgw(ctx, copilotTestPolicy())
	if err == nil || len(policies) != 1 || policies[0].GetTraffic().GetCopilot().TranslationError == nil {
		t.Fatal("missing error-bearing authentication")
	}
	serialized, marshalErr := protojson.Marshal(policies[0])
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	status := PolicyConditionMap(err, true)
	for _, condition := range status {
		if strings.Contains(condition.Message, "resolver-secret-data-marker") {
			t.Fatal("status leaked resolver details")
		}
	}
	if strings.Contains(err.Error(), "resolver-secret-data-marker") || strings.Contains(string(serialized), "resolver-secret-data-marker") {
		t.Fatal("translation leaked resolver details")
	}
}

func TestCopilotUserRejectsConflictingAuthentication(t *testing.T) {
	for _, conflict := range []string{
		`"key":"synthetic-conflicting-credential"`, `"secretRef":{"name":"missing"}`, `"passthrough":{}`, `"aws":{}`, `"azure":{}`, `"gcp":{}`, `"oauthTokenExchange":{}`, `"crossAppAccess":{}`, `"jwtSign":{}`, `"location":{"header":{"name":"x-auth"}}`, `"credentials":[{"secretRef":{"name":"missing"},"location":{"header":{"name":"x-api-key"}}}]`,
	} {
		t.Run(conflict, func(t *testing.T) {
			policy := &agentgateway.AgentgatewayPolicy{Namespace: "default", Name: "copilot-users"}
			if err := json.Unmarshal([]byte(`{"backend":{"auth":{"copilotUser":{},`+conflict+`}}}`), &policy.Spec); err != nil {
				t.Fatal(err)
			}
			translated, err := translateBackendAuth(oauthTestPolicyCtx(t), policy, "default/copilot-users")
			if err == nil || translated.GetBackend().GetAuth().GetCopilotUser().GetTranslationError() == "" {
				t.Fatal("invalid copilotUser must retain an explicit denial")
			}
			if len(translated.GetBackend().GetAuth().Credentials) != 0 {
				t.Fatal("conflicting credentials were retained")
			}
			serialized, marshalErr := protojson.Marshal(translated)
			if marshalErr != nil {
				t.Fatal(marshalErr)
			}
			if strings.Contains(string(serialized), "synthetic-conflicting-credential") {
				t.Fatal("conflicting credential was leaked")
			}
		})
	}
}

func TestCopilotSecretDependencyUpdates(t *testing.T) {
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	secrets := krt.NewStaticCollection[*corev1.Secret](nil, []*corev1.Secret{copilotTestSecret(32)}, krt.WithStop(stop))
	policies := krt.NewStaticCollection[*agentgateway.AgentgatewayPolicy](nil, []*agentgateway.AgentgatewayPolicy{copilotTestPolicy()}, krt.WithStop(stop))
	translated := krt.NewCollection(policies, func(ctx krt.HandlerContext, p *agentgateway.AgentgatewayPolicy) *AgwPolicy {
		result, _ := TranslatePolicyToAgw(PolicyCtx{Krt: ctx, CredentialResolver: kubeutils.NewSecretCredentialResolver(secrets)}, p)
		return &AgwPolicy{Policy: result[0], Gateway: &types.NamespacedName{Namespace: "default", Name: "gateway"}}
	}, krt.WithStop(stop))
	if !translated.WaitUntilSynced(stop) {
		t.Fatal("translation did not synchronize")
	}
	read := func() string {
		all := translated.List()
		if len(all) != 1 {
			return "missing"
		}
		p := all[0].Policy.GetTraffic().GetCopilot()
		if p.TranslationError != nil {
			return "invalid"
		}
		return string(p.EncryptionKey)
	}
	assert.EventuallyEqual(t, read, string(bytes.Repeat([]byte{0xa5}, 32)))
	updated := copilotTestSecret(31)
	secrets.UpdateObject(updated)
	assert.EventuallyEqual(t, read, "invalid")
	updated = copilotTestSecret(32)
	updated.Data["key"] = bytes.Repeat([]byte{0x5a}, 32)
	secrets.UpdateObject(updated)
	assert.EventuallyEqual(t, read, string(bytes.Repeat([]byte{0x5a}, 32)))
}

func TestCopilotInvalidAuthenticationRemainsAttached(t *testing.T) {
	collections := &AgwCollections{
		Gateways: krt.NewStaticCollection[*gwv1.Gateway](nil, []*gwv1.Gateway{{Name: "gateway", Namespace: "default"}}),
	}
	policy := copilotTestPolicy()
	policy.Spec.TargetRefs = []agentgateway.LocalPolicyTargetReferenceWithSectionName{{Group: wellknown.GatewayGroup, Kind: wellknown.GatewayKind, Name: "gateway"}}
	references := BuildReferenceIndex(nil, nil, DefaultReferenceTypes(collections))
	status, translated := TranslateAgentgatewayPolicy(krt.TestingDummyContext{}, policy, collections, references, nil, nil, nil, jwtSignErrorCredentialResolver{})
	if len(translated) != 1 || translated[0].Policy.GetTraffic().GetCopilot().TranslationError == nil || translated[0].Policy.Target == nil {
		t.Fatal("invalid Copilot authentication was not retained on its target")
	}
	if len(status.Ancestors) != 1 {
		t.Fatalf("expected ancestor status, got %d", len(status.Ancestors))
	}
	found := false
	for _, condition := range status.Ancestors[0].Conditions {
		if strings.Contains(condition.Message, "resolver-secret-data-marker") {
			t.Fatal("status leaked resolver details")
		}
		if condition.Type == agentgateway.PolicyConditionAccepted && condition.Reason == agentgateway.PolicyReasonPartiallyValid {
			found = true
		}
	}
	if !found {
		t.Fatal("status did not report translation failure")
	}
}
