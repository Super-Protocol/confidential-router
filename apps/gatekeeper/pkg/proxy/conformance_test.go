package proxy_test

import (
	"crypto/tls"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// The shared conformance vectors, driven end to end through the data plane.
//
// pkg/attestation already runs them against the verifier; what is checked here
// is the layer above it — that a listener carrying real traffic reaches the
// same verdict, over a real TLS handshake, against the real published bundle.
// The fixtures ship the TLS leaves' private keys, so the mock upstream can
// present exactly the certificate each case's observed binding names, which is
// the one thing a replayed bundle cannot fake.
const (
	fixturesDir = "libs/attestation-fixtures"
	vectorsDir  = fixturesDir + "/vectors"
	keysDir     = fixturesDir + "/tools/keys"
)

// fixtureCase is the subset of a manifest entry this test needs.
type fixtureCase struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Request     struct {
		Hostname               string   `json:"hostname"`
		TrustedRoots           []string `json:"trustedRoots"`
		ObservedTLSFingerprint *string  `json:"observedTlsFingerprint"`
		Now                    string   `json:"now"`
		MaxBundleAge           *int64   `json:"maxBundleAge"`
	} `json:"request"`
	Response struct {
		Status   int    `json:"status"`
		BodyFile string `json:"bodyFile"`
	} `json:"response"`
	Expect struct {
		OK      bool `json:"ok"`
		Payload struct {
			EvidenceDigest string `json:"evidenceDigest"`
		} `json:"payload"`
		Stage string `json:"stage"`
	} `json:"expect"`
}

func TestSharedVectorsThroughTheDataPlane(t *testing.T) {
	root := repoRoot(t)

	var manifest struct {
		Cases []fixtureCase `json:"cases"`
	}
	readFixtureJSON(t, filepath.Join(root, vectorsDir, "manifest.json"), &manifest)

	var roots struct {
		Roots []struct {
			Name string `json:"name"`
			PEM  string `json:"pem"`
		} `json:"roots"`
	}
	readFixtureJSON(t, filepath.Join(root, vectorsDir, "roots.json"), &roots)
	rootPEM := map[string]string{}
	for _, entry := range roots.Roots {
		rootPEM[entry.Name] = entry.PEM
	}

	// The TLS identities the fixtures ship a private key for. A case whose
	// observed binding names something else cannot be served over a real
	// handshake and is skipped rather than faked.
	leaves := fixtureLeaves(t, root)

	var ran int
	for _, testCase := range manifest.Cases {
		if reason := skipReason(testCase, leaves, rootPEM); reason != "" {
			t.Logf("skipping %s: %s", testCase.ID, reason)
			continue
		}
		ran++
		t.Run(testCase.ID, func(t *testing.T) {
			runFixtureCase(t, root, testCase, leaves, rootPEM)
		})
	}
	// A refactor that quietly stopped matching any case would otherwise pass.
	if ran < 4 {
		t.Fatalf("only %d vectors ran end to end; the fixtures or the filter have drifted", ran)
	}
}

func runFixtureCase(t *testing.T, root string, testCase fixtureCase,
	leaves map[string]tls.Certificate, rootPEM map[string]string,
) {
	t.Helper()
	now, err := time.Parse(time.RFC3339, testCase.Request.Now)
	if err != nil {
		t.Fatalf("case %s: unparsable now: %v", testCase.ID, err)
	}
	bundle, err := os.ReadFile(filepath.Join(root, vectorsDir, testCase.Response.BodyFile))
	if err != nil {
		t.Fatal(err)
	}

	upstream := newUpstream(t, leaves[*testCase.Request.ObservedTLSFingerprint], bundle)

	trusted := map[string]string{}
	for _, name := range testCase.Request.TrustedRoots {
		trusted[name] = rootPEM[name]
	}
	// An allowed case pins what the bundle publishes; a denied one has nothing
	// to pin, and a placeholder makes sure it is the named stage that refuses
	// rather than the pin policy standing in for it.
	pin := testCase.Expect.Payload.EvidenceDigest
	if pin == "" {
		pin = digestOf("placeholder for " + testCase.ID)
	}
	// A vector the verifier accepts is still not admissible unless it published
	// an evidenceDigest: control-plane evidence is cryptographically sound and
	// impossible to pin, so the gatekeeper verifies it and refuses it anyway.
	admissible := testCase.Expect.OK && testCase.Expect.Payload.EvidenceDigest != ""
	wantStage := testCase.Expect.Stage
	if testCase.Expect.OK && !admissible {
		wantStage = "policy"
	}
	cfg := writeConfig(t, t.TempDir(), configSpec{
		roots: trusted,
		endpoints: []endpointSpec{{
			name: "router", listen: freePort(t), pins: []string{pin},
			reattestInterval: "1h", verdictCacheTTL: "1h",
		}},
		maxBundleAge: "24h",
	})
	supervisor := startSupervisor(t, cfg, upstream, func() time.Time { return now })

	want := status.Broken
	if admissible {
		want = status.Confidential
	}
	ep := awaitHealth(t, supervisor, "router", want)
	if testCase.Expect.OK && ep.Report != nil && !ep.Report.Verified {
		t.Errorf("report = %+v, want the vector's bundle to verify", ep.Report)
	}

	resp := get(t, cfg.Endpoints[0].Listen, "/v1/models", nil)
	body := resp.body

	if admissible {
		if resp.status != http.StatusOK {
			t.Fatalf("status = %d, want the vector's verdict to admit traffic (%s)", resp.status, body)
		}
		return
	}
	if resp.status != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (%s)", resp.status, body)
	}
	// Only the stage is normative across implementations; the wording is not.
	if got := decodeDenial(t, body).Stage; got != wantStage {
		t.Errorf("stage = %q, want %q (reason: %s)", got, wantStage, ep.Reason)
	}
}

// skipReason explains why a vector cannot be driven through the data plane, or
// returns "" when it can.
func skipReason(testCase fixtureCase, leaves map[string]tls.Certificate, rootPEM map[string]string) string {
	switch {
	case testCase.Response.BodyFile == "" || testCase.Response.Status != http.StatusOK:
		return "the case is about the fetch itself, not about what the data plane does with a bundle"
	case testCase.Request.ObservedTLSFingerprint == nil:
		return "producer-asserted binding: the gatekeeper only accepts an observed one"
	case testCase.Request.MaxBundleAge == nil || *testCase.Request.MaxBundleAge != int64(24*time.Hour/time.Millisecond):
		return "the case tunes maxBundleAge away from the value the config expresses"
	case len(testCase.Request.TrustedRoots) == 0:
		return "an empty trust store is not a configuration the gatekeeper accepts"
	}
	if _, ok := leaves[*testCase.Request.ObservedTLSFingerprint]; !ok {
		return "no shipped private key presents the certificate this case's binding names"
	}
	for _, name := range testCase.Request.TrustedRoots {
		if rootPEM[name] == "" {
			return "the case names a root the fixtures do not ship"
		}
	}
	return ""
}

// fixtureLeaves pairs every TLS private key the fixtures ship with the leaf
// certificate it belongs to, keyed by that certificate's fingerprint — the
// value a case's `observedTlsFingerprint` names.
func fixtureLeaves(t *testing.T, root string) map[string]tls.Certificate {
	t.Helper()
	out := map[string]tls.Certificate{}
	for _, pair := range []struct{ bundle, key string }{
		{"bundles/valid-rsa-deployment.json", "rsa-leaf-a.key.pem"},
		{"bundles/untrusted-root-other-cloud.json", "rsa-leaf-b.key.pem"},
	} {
		var document struct {
			CertChain []string `json:"certChain"`
		}
		readFixtureJSON(t, filepath.Join(root, vectorsDir, pair.bundle), &document)
		if len(document.CertChain) == 0 {
			t.Fatalf("%s has no certChain", pair.bundle)
		}
		keyPEM, err := os.ReadFile(filepath.Join(root, keysDir, pair.key))
		if err != nil {
			t.Fatalf("reading %s: %v", pair.key, err)
		}
		cert, err := tls.X509KeyPair([]byte(document.CertChain[0]), keyPEM)
		if err != nil {
			t.Fatalf("%s does not match %s: %v", pair.key, pair.bundle, err)
		}
		block, _ := pem.Decode([]byte(document.CertChain[0]))
		if block == nil {
			t.Fatalf("%s: the leaf is not PEM", pair.bundle)
		}
		out[attestation.SHA256Fingerprint(block.Bytes)] = cert
	}
	return out
}

func readFixtureJSON(t *testing.T, path string, into any) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parsing %s: %v", path, err)
	}
}

// repoRoot walks up from the package directory to the workspace root, which is
// where the shared fixtures live. They are outside this Go module, so go:embed
// cannot reach them.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, vectorsDir, "manifest.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("could not find %s above the package directory", vectorsDir)
		}
		dir = parent
	}
}
