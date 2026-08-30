package policy_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

var (
	pinnedDigest   = trust.Sum([]byte("the pinned deployment snapshot"))
	unpinnedDigest = trust.Sum([]byte("some other deployment snapshot"))
	certDigest     = trust.Sum([]byte("the TLS leaf DER"))
	rootDigest     = trust.Sum([]byte("the root DER"))
)

// newStore builds a two-endpoint trust store: `llama` pins one digest, `qwen`
// pins none of the digests used in the tests.
func newStore(t *testing.T) *trust.Store {
	t.Helper()
	cfg := &config.Config{
		Version:      config.SchemaVersion,
		TrustedRoots: []config.TrustedRoot{{Name: "swarm-cloud-prod", PEM: selfSignedPEM(t)}},
		Endpoints: []config.Endpoint{
			{
				Name:            "llama",
				Listen:          "127.0.0.1:8443",
				Upstream:        "https://llama.tee.swarm.cloud",
				TrustedEvidence: []string{pinnedDigest.String()},
			},
			{
				Name:            "qwen",
				Listen:          "127.0.0.1:8444",
				Upstream:        "https://qwen.tee.swarm.cloud",
				TrustedEvidence: []string{trust.Sum([]byte("qwen snapshot")).String()},
			},
		},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("test config is invalid: %v", err)
	}
	store, err := trust.New(cfg)
	if err != nil {
		t.Fatalf("building the trust store: %v", err)
	}
	return store
}

func newEngine(t *testing.T, modules ...policy.Module) *policy.Engine {
	t.Helper()
	engine, err := policy.New(context.Background(), policy.Options{Store: newStore(t), Modules: modules})
	if err != nil {
		t.Fatalf("policy.New: %v", err)
	}
	return engine
}

// snapshot is a miniature deployment snapshot with two container images at
// different depths, so collectImages and tree_match have something to walk.
func snapshot() map[string]any {
	return map[string]any{
		"version": 2,
		"resources": []any{
			map[string]any{
				"kind":     "Deployment",
				"metadata": map[string]any{"name": "router-api", "namespace": "cr-prod"},
				"spec": map[string]any{
					"template": map[string]any{
						"spec": map[string]any{
							"containers": []any{
								map[string]any{"name": "router-api", "image": "ghcr.io/super-protocol/router-api@sha256:11"},
								map[string]any{"name": "vllm", "image": "ghcr.io/super-protocol/vllm-tdx@sha256:22"},
							},
						},
					},
				},
			},
		},
	}
}

func payload(digest trust.Digest) map[string]any {
	return map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        "llama.tee.swarm.cloud",
		"issuedAt":        "2026-08-30T10:05:00Z",
		"certFingerprint": certDigest.String(),
		"evidenceDigest":  digest.String(),
		"evidence":        snapshot(),
	}
}

func inputFor(t *testing.T, endpoint string, digest trust.Digest) map[string]any {
	t.Helper()
	input, err := policy.BuildInput(policy.InputSource{
		Endpoint:               endpoint,
		UpstreamHostname:       "llama.tee.swarm.cloud",
		UpstreamPort:           443,
		Root:                   "swarm-cloud-prod",
		RootFingerprint:        rootDigest,
		ObservedTLSFingerprint: certDigest,
		VerifiedAt:             time.Date(2026, 8, 30, 10, 11, 4, 0, time.UTC),
		QuoteFormat:            "intel-tdx-quote-v5",
		Payload:                payload(digest),
	})
	if err != nil {
		t.Fatalf("BuildInput: %v", err)
	}
	return input
}

func selfSignedPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "swarm-cloud-prod"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}
