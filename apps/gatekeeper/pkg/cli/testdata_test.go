package cli_test

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

// rootPEM is a fixed self-signed certificate. It is checked in rather than
// generated per run so that its fingerprint — which appears in golden output —
// is stable.
func rootPEM(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("testdata/swarm-cloud-prod.pem")
	if err != nil {
		t.Fatalf("reading the test root: %v", err)
	}
	return string(data)
}

// bundleJSON builds an evidence bundle whose JWS payload carries the given
// digest. The signature is not a real one: `policy test` runs policy-only in a
// build without an attestation pipeline, and never looks at it.
func bundleJSON(t *testing.T, hostname, digest, root string) string {
	t.Helper()
	payload := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        hostname,
		"issuedAt":        fixedNow.Add(-5 * 60 * 1e9).UTC().Format("2006-01-02T15:04:05Z"),
		"certFingerprint": "sha256/4fSxZzcnad7Qy_256p4Hlw7zm-jHTEhgjN31bRF-di0",
		"evidenceDigest":  digest,
		"evidence": map[string]any{
			"deployment": map[string]any{
				"containers": []any{
					map[string]any{"name": "vllm", "image": "ghcr.io/super-protocol/vllm@sha256:aaaa"},
					map[string]any{"name": "sidecar", "image": "ghcr.io/super-protocol/sidecar@sha256:bbbb"},
				},
			},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encoding payload: %v", err)
	}
	jws := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`)) + "." +
		base64.RawURLEncoding.EncodeToString(encoded) + "." +
		base64.RawURLEncoding.EncodeToString([]byte("not-a-real-signature"))

	bundle := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        hostname,
		"issuedAt":        payload["issuedAt"],
		"certFingerprint": payload["certFingerprint"],
		"jws":             jws,
		"certChain":       []string{root},
		"rootCaTeeQuote":  map[string]any{"format": "intel-tdx-quote-v5"},
	}
	out, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		t.Fatalf("encoding bundle: %v", err)
	}
	return string(out)
}
