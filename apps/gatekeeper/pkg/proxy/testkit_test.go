package proxy_test

import (
	"bufio"
	"context"
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

	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/proxy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/verifier"
)

// upstreamHost is the hostname every test endpoint is published for. It does
// not resolve, and it does not need to: proxy.Options.Dial and the verifier's
// dialer both point at the fixture's loopback listener, so the whole data path
// runs against the hostname the evidence actually names — which is what the
// bundle, the SNI and the Host header are all checked against.
const upstreamHost = "router.example.test"

// ---------------------------------------------------------------------------
// A throwaway PKI
// ---------------------------------------------------------------------------

// leafPair is one certificate with the key that goes with it: the JWS is signed
// under it, and the TLS handshake presents it.
type leafPair struct {
	pem  string
	der  []byte
	key  *rsa.PrivateKey
	cert tls.Certificate
}

func (l *leafPair) fingerprint() string { return attestation.SHA256Fingerprint(l.der) }

// testPKI is two independent clouds: `root` is the one the tests trust, and
// `foreign` is the one an untrusted-root denial comes from.
type testPKI struct {
	rootPEM string
	// leaf is the endpoint's certificate; rotated is a second one under the
	// same root, which is what a certificate rotation looks like.
	leaf    *leafPair
	rotated *leafPair

	foreignRootPEM string
	foreignLeaf    *leafPair
}

// RSA-2048 is by far the slowest thing in this package's tests, so one PKI is
// minted for the whole run.
var (
	pkiOnce   sync.Once
	sharedPKI *testPKI
	pkiErr    error
)

func newPKI(t *testing.T) *testPKI {
	t.Helper()
	pkiOnce.Do(func() { sharedPKI, pkiErr = mintPKI() })
	if pkiErr != nil {
		t.Fatalf("minting the test PKI: %v", pkiErr)
	}
	return sharedPKI
}

func mintPKI() (*testPKI, error) {
	rootKey, rootCert, rootPEM, err := mintRoot("confidential-router-test-root")
	if err != nil {
		return nil, err
	}
	leaf, err := mintLeaf(rootKey, rootCert, 2)
	if err != nil {
		return nil, err
	}
	rotated, err := mintLeaf(rootKey, rootCert, 3)
	if err != nil {
		return nil, err
	}

	foreignKey, foreignCert, foreignPEM, err := mintRoot("some-other-cloud-root")
	if err != nil {
		return nil, err
	}
	foreignLeaf, err := mintLeaf(foreignKey, foreignCert, 4)
	if err != nil {
		return nil, err
	}
	return &testPKI{
		rootPEM: rootPEM, leaf: leaf, rotated: rotated,
		foreignRootPEM: foreignPEM, foreignLeaf: foreignLeaf,
	}, nil
}

func mintRoot(name string) (*rsa.PrivateKey, *x509.Certificate, string, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, "", err
	}
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, nil, "", err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, nil, "", err
	}
	return key, cert, encodePEM(der), nil
}

func mintLeaf(issuerKey *rsa.PrivateKey, issuer *x509.Certificate, serial int64) (*leafPair, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: upstreamHost},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		DNSNames:     []string{upstreamHost},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, issuer, &key.PublicKey, issuerKey)
	if err != nil {
		return nil, err
	}
	return &leafPair{
		pem: encodePEM(der), der: der, key: key,
		cert: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
	}, nil
}

func encodePEM(der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

// ---------------------------------------------------------------------------
// Evidence bundles
// ---------------------------------------------------------------------------

// bundleSpec describes one evidence document to publish.
type bundleSpec struct {
	// signer signs the JWS and its certificate heads the chain.
	signer *leafPair
	// rootPEM terminates the chain.
	rootPEM string
	// certFingerprint is what the payload commits to; empty means the signer's
	// own certificate.
	certFingerprint string
	digest          string
	issuedAt        time.Time
}

func buildBundle(t *testing.T, spec bundleSpec) []byte {
	t.Helper()
	if spec.issuedAt.IsZero() {
		spec.issuedAt = time.Now().Add(-2 * time.Minute)
	}
	if spec.certFingerprint == "" {
		spec.certFingerprint = spec.signer.fingerprint()
	}
	issued := spec.issuedAt.UTC().Format(time.RFC3339)

	payload := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        upstreamHost,
		"issuedAt":        issued,
		"certFingerprint": spec.certFingerprint,
		"evidenceDigest":  spec.digest,
		"evidence": map[string]any{
			"version": 2,
			"resources": []any{map[string]any{
				"kind": "Deployment", "name": "router-api",
				"containers": []any{map[string]any{
					"name": "router-api", "image": "ghcr.io/super-protocol/router-api@sha256:" + strings.Repeat("1", 64),
				}},
			}},
		},
	}
	document := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        upstreamHost,
		"issuedAt":        issued,
		"certFingerprint": spec.certFingerprint,
		"jws":             signJWS(t, spec.signer.key, payload),
		"certChain":       []string{spec.signer.pem, spec.rootPEM},
		"rootCaTeeQuote":  map[string]any{"format": "intel-tdx-quote-v5"},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func signJWS(t *testing.T, key *rsa.PrivateKey, payload map[string]any) string {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256"}`))
	claims := base64.RawURLEncoding.EncodeToString(body)
	sum := sha256.Sum256([]byte(header + "." + claims))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return header + "." + claims + "." + base64.RawURLEncoding.EncodeToString(signature)
}

// digestOf is a canonical evidenceDigest derived from a label, so a test can
// pin one without inventing base64 by hand.
func digestOf(label string) string {
	sum := sha256.Sum256([]byte(label))
	return "sha256/" + base64.RawURLEncoding.EncodeToString(sum[:])
}

// ---------------------------------------------------------------------------
// The mock upstream
// ---------------------------------------------------------------------------

// fakeUpstream is a TLS server that publishes an evidence bundle and serves the
// kinds of traffic the data plane has to carry: a streamed event stream, an
// echo, and a protocol upgrade. Both its certificate and its bundle can be
// swapped while it is running.
type fakeUpstream struct {
	t        *testing.T
	listener net.Listener
	server   *http.Server

	cert   atomic.Pointer[tls.Certificate]
	bundle atomic.Pointer[[]byte]
	// bundleStatus is the status the evidence path answers with.
	bundleStatus atomic.Int64

	// sni records the server name of the most recent handshake. It is read from
	// the ClientHello rather than from the accepted connection, which has not
	// handshaken yet when http.Server hands it over.
	sni atomic.Pointer[string]

	// release gates the event stream between chunks, which is how a test proves
	// the proxy is not buffering: the second chunk is not written until the
	// first has been read through the proxy.
	release chan struct{}

	mu       sync.Mutex
	requests []recordedRequest
}

// recordedRequest is what the upstream saw, so that "the verdict never leaves
// this machine" can be asserted from the far end.
type recordedRequest struct {
	Method string
	Path   string
	Host   string
	Header http.Header
}

func newUpstream(t *testing.T, cert tls.Certificate, bundle []byte) *fakeUpstream {
	t.Helper()
	u := &fakeUpstream{t: t, release: make(chan struct{})}
	u.cert.Store(&cert)
	u.bundle.Store(&bundle)
	u.bundleStatus.Store(http.StatusOK)

	mux := http.NewServeMux()
	mux.HandleFunc(attestation.EvidencePath, u.serveEvidence)
	mux.HandleFunc("/sse", u.serveSSE)
	mux.HandleFunc("/echo", u.serveEcho)
	mux.HandleFunc("/ws", u.serveUpgrade)
	mux.HandleFunc("/", u.serveHello)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("binding the mock upstream: %v", err)
	}
	u.listener = listener
	u.server = &http.Server{
		Handler:           u.record(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	tlsListener := tls.NewListener(listener, &tls.Config{
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			name := hello.ServerName
			u.sni.Store(&name)
			return u.cert.Load(), nil
		},
		NextProtos: []string{"http/1.1"},
		MinVersion: tls.VersionTLS12,
	})
	go func() { _ = u.server.Serve(tlsListener) }()
	t.Cleanup(func() { _ = u.server.Close() })
	return u
}

func (u *fakeUpstream) addr() string { return u.listener.Addr().String() }

// dial is proxy.Options.Dial: every upstream address resolves to this server.
func (u *fakeUpstream) dial(ctx context.Context, network, _ string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, u.addr())
}

// serverName is the SNI of the most recent handshake.
func (u *fakeUpstream) serverName() string {
	if name := u.sni.Load(); name != nil {
		return *name
	}
	return ""
}

func (u *fakeUpstream) setCertificate(cert tls.Certificate) { u.cert.Store(&cert) }
func (u *fakeUpstream) setBundle(bundle []byte)             { u.bundle.Store(&bundle) }

func (u *fakeUpstream) record(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		u.requests = append(u.requests, recordedRequest{
			Method: r.Method, Path: r.URL.Path, Host: r.Host, Header: r.Header.Clone(),
		})
		u.mu.Unlock()
		next.ServeHTTP(w, r)
	})
}

// seen returns the requests that reached the upstream, ignoring the evidence
// fetches the verifier makes.
func (u *fakeUpstream) seen() []recordedRequest {
	u.mu.Lock()
	defer u.mu.Unlock()
	out := make([]recordedRequest, 0, len(u.requests))
	for _, r := range u.requests {
		if r.Path != attestation.EvidencePath {
			out = append(out, r)
		}
	}
	return out
}

func (u *fakeUpstream) serveEvidence(w http.ResponseWriter, _ *http.Request) {
	status := int(u.bundleStatus.Load())
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(*u.bundle.Load())
}

// serveSSE writes one event, then waits to be released before writing the
// second. A proxy that buffered would deliver nothing until both were written.
func (u *fakeUpstream) serveSSE(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	controller := http.NewResponseController(w)

	_, _ = io.WriteString(w, "data: {\"chunk\":1}\n\n")
	_ = controller.Flush()

	select {
	case <-u.release:
	case <-r.Context().Done():
		return
	case <-time.After(5 * time.Second):
		return
	}

	_, _ = io.WriteString(w, "data: {\"chunk\":2}\n\n")
	_, _ = io.WriteString(w, "data: [DONE]\n\n")
	_ = controller.Flush()
}

func (u *fakeUpstream) serveEcho(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, r.Body)
}

func (u *fakeUpstream) serveHello(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = io.WriteString(w, `{"object":"list","data":[]}`)
}

// serveUpgrade is a minimal protocol switch: it answers 101 and then echoes
// whatever the client sends, upper-cased. It is enough to prove the data plane
// hands over the raw connection; the WebSocket framing itself is not the
// gatekeeper's business.
func (u *fakeUpstream) serveUpgrade(w http.ResponseWriter, r *http.Request) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		http.Error(w, "expected an upgrade", http.StatusBadRequest)
		return
	}
	conn, buffered, err := http.NewResponseController(w).Hijack()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer conn.Close() //nolint:errcheck // test fixture

	_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
	if err := buffered.Flush(); err != nil {
		return
	}
	scanner := bufio.NewScanner(buffered)
	for scanner.Scan() {
		if _, err := buffered.WriteString(strings.ToUpper(scanner.Text()) + "\n"); err != nil {
			return
		}
		if err := buffered.Flush(); err != nil {
			return
		}
	}
}

// ---------------------------------------------------------------------------
// A configured, running supervisor
// ---------------------------------------------------------------------------

// endpointSpec is one `endpoints[]` entry a test wants written.
type endpointSpec struct {
	name             string
	listen           string
	pins             []string
	failMode         string
	reattestInterval string
	verdictCacheTTL  string
	initialTimeout   string
}

// configSpec is the whole config file a test wants written.
type configSpec struct {
	roots        map[string]string
	endpoints    []endpointSpec
	adminSocket  string
	auditFile    string
	maxBundleAge string
}

func writeConfig(t *testing.T, dir string, spec configSpec) *config.Config {
	t.Helper()
	var b strings.Builder
	b.WriteString("version: 1\ntrustedRoots:\n")
	for name, certPEM := range spec.roots {
		b.WriteString("  - name: " + name + "\n    pem: |\n")
		for _, line := range strings.Split(strings.TrimRight(certPEM, "\n"), "\n") {
			b.WriteString("      " + line + "\n")
		}
	}
	if spec.maxBundleAge != "" {
		b.WriteString("defaults:\n  maxBundleAge: " + spec.maxBundleAge + "\n")
	}
	b.WriteString("endpoints:\n")
	for _, ep := range spec.endpoints {
		b.WriteString("  - name: " + ep.name + "\n")
		b.WriteString("    listen: " + ep.listen + "\n")
		b.WriteString("    upstream: https://" + upstreamHost + "\n")
		b.WriteString("    trustedEvidence:\n")
		for _, pin := range ep.pins {
			b.WriteString("      - " + pin + "\n")
		}
		for key, value := range map[string]string{
			"failMode":         ep.failMode,
			"reattestInterval": ep.reattestInterval,
			"verdictCacheTtl":  ep.verdictCacheTTL,
			"initialTimeout":   ep.initialTimeout,
		} {
			if value != "" {
				b.WriteString("    " + key + ": " + value + "\n")
			}
		}
	}
	if spec.adminSocket != "" {
		b.WriteString("admin:\n  listen: unix:" + spec.adminSocket + "\n")
	}
	if spec.auditFile != "" {
		b.WriteString("audit:\n  file: " + spec.auditFile + "\n")
	}

	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load(config.Options{Path: path, Environ: []string{}})
	if err != nil {
		t.Fatalf("loading the generated config:\n%s\n%v", b.String(), err)
	}
	return cfg
}

// verifierFor builds the real verification pipeline against the fixture's
// upstream: the genuine attestation and policy code, reached over the test's
// dialer and, when one is given, at the test's clock.
func verifierFor(u *fakeUpstream, now func() time.Time) proxy.VerifierFunc {
	return func(ctx context.Context, cfg *config.Config) (status.Verifier, error) {
		built, err := verifier.New(ctx, cfg)
		if err != nil {
			return nil, err
		}
		built = built.WithDialer(u.dial)
		if now != nil {
			built = built.WithClock(now)
		}
		return built, nil
	}
}

// startSupervisor builds a supervisor over the fixture's upstream and brings
// every endpoint up, with the real verifier behind it.
func startSupervisor(t *testing.T, cfg *config.Config, u *fakeUpstream, now func() time.Time) *proxy.Supervisor {
	t.Helper()
	opts := proxy.Options{
		Config:          cfg,
		Dial:            u.dial,
		Now:             now,
		PublishInterval: 50 * time.Millisecond,
		Verifier:        verifierFor(u, now),
	}
	supervisor, err := proxy.New(t.Context(), opts)
	if err != nil {
		t.Fatalf("building the supervisor: %v", err)
	}
	t.Cleanup(func() { _ = supervisor.Close() })

	for _, ep := range cfg.Endpoints {
		if err := supervisor.Start(t.Context(), ep.Name); err != nil {
			t.Fatalf("starting %s: %v", ep.Name, err)
		}
	}
	return supervisor
}

// awaitHealth waits for an endpoint to reach one of the given states, which is
// how a test synchronises with the background re-attestation loop.
func awaitHealth(t *testing.T, s *proxy.Supervisor, name string, want ...status.Health) status.Endpoint {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var last status.Endpoint
	for time.Now().Before(deadline) {
		ep, ok := s.Snapshot(t.Context()).Endpoint(name)
		if ok {
			last = ep
			for _, health := range want {
				if ep.Health == health {
					return ep
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s stayed %q (%s), want one of %v", name, last.Health, last.Reason, want)
	return last
}

// freePort reserves a loopback port and releases it, so a listener the test
// writes into a config file can bind it.
func freePort(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return addr
}

// localClient talks to a gatekeeper listener the way a user's SDK would.
func localClient() *http.Client {
	return &http.Client{Timeout: 20 * time.Second}
}

// reply is one answer from a gatekeeper listener, read to the end. Returning a
// value rather than an *http.Response keeps every test from having to remember
// to close a body.
type reply struct {
	status int
	header http.Header
	body   string
}

func get(t *testing.T, listen, path string, header http.Header) reply {
	t.Helper()
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+listen+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, values := range header {
		for _, value := range values {
			req.Header.Add(name, value)
		}
	}
	resp, err := localClient().Do(req)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	return collect(t, resp)
}

// readUnix reads one path from an admin socket and returns its body.
func readUnix(t *testing.T, socket, path string) string {
	t.Helper()
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}}
	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://gatekeeper"+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("GET %s over %s: %v", path, socket, err)
	}
	return collect(t, resp).body
}

// collect drains and closes a response.
func collect(t *testing.T, resp *http.Response) reply {
	t.Helper()
	defer resp.Body.Close() //nolint:errcheck // test helper
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading the response body: %v", err)
	}
	return reply{status: resp.StatusCode, header: resp.Header, body: string(body)}
}

// decodeDenial reads the JSON body a fail-closed endpoint answers with.
func decodeDenial(t *testing.T, body string) struct {
	Error struct {
		Type    string `json:"type"`
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Stage  string `json:"stage"`
	Reason string `json:"reason"`
} {
	t.Helper()
	var out struct {
		Error struct {
			Type    string `json:"type"`
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
		Stage  string `json:"stage"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("the denial body is not JSON (%v): %s", err, body)
	}
	return out
}
