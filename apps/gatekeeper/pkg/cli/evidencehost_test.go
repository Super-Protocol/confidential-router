package cli_test

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// evidenceHost is a stand-in for a router endpoint: a real HTTPS server that
// publishes a freshly signed evidence bundle binding its own TLS certificate.
//
// It is a real server rather than an injected [status.Verifier] because the
// bug this file guards against was in the seam between the CLI and the
// verification pipeline — a fake verifier skips exactly the code that broke.
// The certificate the JWS commits to is the one the handshake presents, so the
// channel binding is established the way it is in production, by the gatekeeper
// observing the connection it fetched over.
type evidenceHost struct {
	server *httptest.Server
	// RootPEM is the certificate to add with `trust roots add`.
	RootPEM string

	leafPEM string
	leafKey *rsa.PrivateKey

	mu     sync.Mutex
	digest string
}

// rsaKeys are the slowest thing in this package's tests, so one pair is minted
// for the whole run and reissued into per-test certificates.
var (
	sharedKeysOnce sync.Once
	sharedRootKey  *rsa.PrivateKey
	sharedLeafKey  *rsa.PrivateKey
	sharedKeysErr  error
)

func testKeys(t *testing.T) (root, leaf *rsa.PrivateKey) {
	t.Helper()
	sharedKeysOnce.Do(func() {
		if sharedRootKey, sharedKeysErr = rsa.GenerateKey(rand.Reader, 2048); sharedKeysErr != nil {
			return
		}
		sharedLeafKey, sharedKeysErr = rsa.GenerateKey(rand.Reader, 2048)
	})
	if sharedKeysErr != nil {
		t.Fatalf("generating the test keys: %v", sharedKeysErr)
	}
	return sharedRootKey, sharedLeafKey
}

// newEvidenceHost starts a mock endpoint publishing the given evidenceDigest.
func newEvidenceHost(t *testing.T, digest string) *evidenceHost {
	t.Helper()
	rootKey, leafKey := testKeys(t)
	now := time.Now()

	rootTemplate := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "swarm-cloud-test-root"},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTemplate, rootTemplate, &rootKey.PublicKey, rootKey)
	if err != nil {
		t.Fatalf("creating the root certificate: %v", err)
	}
	rootCert, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}

	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "127.0.0.1"},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, rootCert, &leafKey.PublicKey, rootKey)
	if err != nil {
		t.Fatalf("creating the leaf certificate: %v", err)
	}

	h := &evidenceHost{
		RootPEM: encodeCertPEM(rootDER),
		leafPEM: encodeCertPEM(leafDER),
		leafKey: leafKey,
		digest:  digest,
	}

	mux := http.NewServeMux()
	mux.HandleFunc(attestation.EvidencePath, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		if _, err := w.Write(h.bundle(t, hostOf(r.Host))); err != nil {
			t.Errorf("writing the bundle: %v", err)
		}
	})

	h.server = httptest.NewUnstartedServer(mux)
	h.server.TLS = &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{leafDER}, PrivateKey: leafKey}},
		MinVersion:   tls.VersionTLS12,
	}
	h.server.StartTLS()
	t.Cleanup(h.server.Close)
	return h
}

// Upstream is the `--upstream` value an endpoint pointing here needs.
func (h *evidenceHost) Upstream() string {
	parsed, err := url.Parse(h.server.URL)
	if err != nil {
		panic(err)
	}
	return "https://" + net.JoinHostPort(parsed.Hostname(), parsed.Port())
}

// Publish swaps the evidenceDigest the host publishes from now on, which is how
// a redeployment looks to a gatekeeper that has already pinned the old one.
func (h *evidenceHost) Publish(digest string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.digest = digest
}

// bundle builds the document served at /.well-known/swarm-evidence. It is built
// per request so `issuedAt` is always fresh and the freshness stage is exercised
// rather than skipped.
func (h *evidenceHost) bundle(t *testing.T, hostname string) []byte {
	t.Helper()
	h.mu.Lock()
	digest := h.digest
	h.mu.Unlock()

	issuedAt := time.Now().UTC().Format(time.RFC3339)
	fingerprint := attestation.SHA256Fingerprint(h.server.TLS.Certificates[0].Certificate[0])
	payload := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        hostname,
		"issuedAt":        issuedAt,
		"certFingerprint": fingerprint,
		"evidenceDigest":  digest,
		"evidence": map[string]any{
			"deployment": map[string]any{
				"containers": []any{
					map[string]any{"name": "vllm", "image": "ghcr.io/super-protocol/vllm@sha256:aaaa"},
				},
			},
		},
	}

	document := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        hostname,
		"issuedAt":        issuedAt,
		"certFingerprint": fingerprint,
		"jws":             h.signJWS(t, payload),
		"certChain":       []string{h.leafPEM, h.RootPEM},
		"rootCaTeeQuote":  map[string]any{"format": "intel-tdx-quote-v5"},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// signJWS produces the compact RS256 JWS over the payload, under the same key
// the TLS leaf carries.
func (h *evidenceHost) signJWS(t *testing.T, payload map[string]any) string {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	claims := base64.RawURLEncoding.EncodeToString(body)
	sum := sha256.Sum256([]byte(header + "." + claims))
	signature, err := rsa.SignPKCS1v15(rand.Reader, h.leafKey, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return header + "." + claims + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func encodeCertPEM(der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// hostOf strips the port from a Host header, so the bundle names the hostname
// the gatekeeper asked for — which is what the fetch stage compares it against.
func hostOf(hostHeader string) string {
	host, _, err := net.SplitHostPort(hostHeader)
	if err != nil {
		return hostHeader
	}
	return host
}

// testDigest is a well-formed evidenceDigest standing for one deployment.
func testDigest(deployment string) string {
	return attestation.SHA256Fingerprint([]byte(deployment))
}

// portOf is the upstream's port, for the assertions that check what was dialled.
func portOf(t *testing.T, upstream string) int {
	t.Helper()
	parsed, err := url.Parse(upstream)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil {
		t.Fatal(err)
	}
	return port
}
