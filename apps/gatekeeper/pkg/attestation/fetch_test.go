package attestation_test

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/testca"
)

// localhost is the hostname the end-to-end tests publish evidence for: the
// bundle names the host it is fetched from, and the test server listens on the
// loopback address.
const localhost = "127.0.0.1"

func TestFetchObservesTheLeafOfTheConnectionItUsed(t *testing.T) {
	t.Parallel()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != attestation.EvidencePath {
			t.Errorf("path = %q, want %q", r.URL.Path, attestation.EvidencePath)
		}
		if accept := r.Header.Get("accept"); accept != "application/json" {
			t.Errorf("accept = %q, want application/json", accept)
		}
		_, _ = w.Write([]byte(`{"hello":"world"}`))
	}))
	defer server.Close()

	result, err := attestation.Fetch(context.Background(), localhost, fetchOptionsFor(t, server))
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if string(result.Body) != `{"hello":"world"}` {
		t.Errorf("body = %q", result.Body)
	}

	sum := sha256.Sum256(server.Certificate().Raw)
	want := "sha256/" + base64.RawURLEncoding.EncodeToString(sum[:])
	if result.ObservedTLSFingerprint != want {
		t.Errorf("observed fingerprint = %q, want %q (the certificate the server actually served)",
			result.ObservedTLSFingerprint, want)
	}
}

func TestFetchRejectsNonSuccessStatus(t *testing.T) {
	t.Parallel()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusNotFound)
	}))
	defer server.Close()

	// A non-2xx response is reported, not raised: the verifier turns it into a
	// fetch-stage denial that names the endpoint's own status.
	result, err := attestation.Fetch(context.Background(), localhost, fetchOptionsFor(t, server))
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if result.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", result.StatusCode)
	}

	verdict := attestation.VerifyHostname(context.Background(), attestation.Params{
		Hostname: localhost,
		Fetch:    attestation.FetchOptions{Port: serverPort(t, server)},
	})
	if verdict.OK || verdict.Stage != attestation.StageFetch ||
		!strings.Contains(verdict.Reason, "unexpected status 404") {
		t.Fatalf("verdict = %+v, want a fetch-stage denial naming the status", verdict)
	}
}

func TestFetchRefusesRedirects(t *testing.T) {
	t.Parallel()
	// A redirect would move the bundle onto a connection whose certificate was
	// never observed, so it is reported as a status failure rather than followed.
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Redirect(w, &http.Request{}, "https://elsewhere.example.com/", http.StatusFound)
	}))
	defer server.Close()

	result, err := attestation.Fetch(context.Background(), localhost, fetchOptionsFor(t, server))
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if result.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want the 302 to be surfaced rather than followed", result.StatusCode)
	}
}

func TestFetchEnforcesTheSizeLimit(t *testing.T) {
	t.Parallel()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("a", 4096)))
	}))
	defer server.Close()

	options := fetchOptionsFor(t, server)
	options.MaxBytes = 1024
	_, err := attestation.Fetch(context.Background(), localhost, options)
	if err == nil || !strings.Contains(err.Error(), "exceeds the 1024 byte limit") {
		t.Fatalf("err = %v, want a size-limit error", err)
	}
}

func TestFetchHonoursContextCancellation(t *testing.T) {
	t.Parallel()
	release := make(chan struct{})
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
		_, _ = w.Write([]byte("{}"))
	}))
	defer server.Close()
	defer close(release)

	options := fetchOptionsFor(t, server)
	options.Timeout = 150 * time.Millisecond
	start := time.Now()
	_, err := attestation.Fetch(context.Background(), localhost, options)
	if err == nil {
		t.Fatal("expected a timeout")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("Fetch took %s; the timeout was not applied", elapsed)
	}
}

// TestFetchRejectsMalformedHostnames asserts the reason, not just the failure:
// a regression of the guard would otherwise still "pass" through a DNS or URL
// error, and would quietly make this the one test that needs the network.
func TestFetchRejectsMalformedHostnames(t *testing.T) {
	t.Parallel()
	for hostname, want := range map[string]string{
		"":                         "hostname must be a non-empty string",
		"https://host.example.com": "must be a bare host, without scheme or port",
		"host.example.com:443":     "must be a bare host, without scheme or port",
	} {
		t.Run(hostname, func(t *testing.T) {
			t.Parallel()
			_, err := attestation.Fetch(context.Background(), hostname, attestation.FetchOptions{})
			if err == nil {
				t.Fatalf("Fetch(%q) succeeded, want a rejection", hostname)
			}
			if !strings.Contains(err.Error(), want) {
				t.Fatalf("err = %q, want it to mention %q", err, want)
			}
		})
	}
}

func TestVerifyHostnameEndToEnd(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	chain := []*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}
	issuedAt := mustTime(t, "2026-08-30T10:05:00Z")
	bundle := buildBundle(t, localhost, chain, kit.rsaLeaf, issuedAt, nil, nil)

	server := evidenceServer(t, kit, bundle)
	defer server.Close()

	result := attestation.VerifyHostname(context.Background(), attestation.Params{
		Hostname:     localhost,
		TrustedRoots: []attestation.TrustedRoot{{Name: "swarm-cloud-test-rsa", PEM: kit.rsaRoot.PEM}},
		MaxBundleAge: 24 * time.Hour,
		Now:          mustTime(t, testNow),
		Fetch:        attestation.FetchOptions{Port: serverPort(t, server)},
	})

	if !result.OK {
		t.Fatalf("verification failed at %q: %s", result.Stage, result.Reason)
	}
	if result.ChannelBinding != attestation.BindingObserved {
		t.Errorf("channelBinding = %q, want observed", result.ChannelBinding)
	}
	if result.ObservedTLSFingerprint != kit.rsaLeaf.Fingerprint() {
		t.Errorf("observed fingerprint = %q, want the served leaf %q",
			result.ObservedTLSFingerprint, kit.rsaLeaf.Fingerprint())
	}
	payload, ok := result.Deployment()
	if !ok {
		t.Fatalf("payload is %T, want *DeploymentEvidencePayload", result.Payload)
	}
	if payload.EvidenceDigest != attestation.SHA256Fingerprint([]byte(canonicalEvidence)) {
		t.Errorf("evidenceDigest = %q", payload.EvidenceDigest)
	}
}

// TestVerifyHostnameDetectsASubstitutedCertificate is the whole point of
// observing in the same dial: the bundle is perfectly valid, but it is served
// over a certificate other than the one it commits to.
func TestVerifyHostnameDetectsASubstitutedCertificate(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	chain := []*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}
	bundle := buildBundle(t, localhost, chain, kit.rsaLeaf, mustTime(t, "2026-08-30T10:05:00Z"), nil, nil)

	document, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	// Served over the stray certificate, not the one the payload names.
	server := tlsServerWithCert(t, kit.strayLeaf, document)
	defer server.Close()

	result := attestation.VerifyHostname(context.Background(), attestation.Params{
		Hostname:     localhost,
		TrustedRoots: []attestation.TrustedRoot{{Name: "swarm-cloud-test-rsa", PEM: kit.rsaRoot.PEM}},
		Now:          mustTime(t, testNow),
		Fetch:        attestation.FetchOptions{Port: serverPort(t, server)},
	})

	if result.OK {
		t.Fatal("expected the substituted certificate to be caught")
	}
	if result.Stage != attestation.StageTLSFingerprint {
		t.Fatalf("stage = %q, want tls-fingerprint (reason: %s)", result.Stage, result.Reason)
	}
}

func TestVerifyHostnameReportsUnreachableEndpointsAtTheFetchStage(t *testing.T) {
	t.Parallel()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close() // nothing is listening on this port any more

	result := attestation.VerifyHostname(context.Background(), attestation.Params{
		Hostname: localhost,
		Fetch:    attestation.FetchOptions{Port: port, Timeout: 2 * time.Second},
	})
	if result.OK || result.Stage != attestation.StageFetch {
		t.Fatalf("result = %+v, want a fetch-stage denial", result)
	}
}

func TestVerifyHostnameRejectsAMalformedObservedFingerprint(t *testing.T) {
	t.Parallel()
	result := attestation.VerifyHostname(context.Background(), attestation.Params{
		Hostname:               "host.example.com",
		ObservedTLSFingerprint: "not-a-fingerprint",
	})
	if result.OK || result.Stage != attestation.StageTLSFingerprint {
		t.Fatalf("result = %+v, want a tls-fingerprint denial", result)
	}
}

func fetchOptionsFor(t *testing.T, server *httptest.Server) attestation.FetchOptions {
	t.Helper()
	return attestation.FetchOptions{Port: serverPort(t, server), Timeout: 10 * time.Second}
}

func serverPort(t *testing.T, server *httptest.Server) int {
	t.Helper()
	_, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "https://"))
	if err != nil {
		t.Fatalf("parse server URL %q: %v", server.URL, err)
	}
	parsed, err := strconv.Atoi(port)
	if err != nil {
		t.Fatalf("parse port %q: %v", port, err)
	}
	return parsed
}

// evidenceServer serves bundle at the evidence path over the kit's own leaf
// certificate, so the observed fingerprint is the one the payload commits to.
func evidenceServer(t *testing.T, kit *testKit, bundle map[string]any) *httptest.Server {
	t.Helper()
	document, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	return tlsServerWithCert(t, kit.rsaLeaf, document)
}

func tlsServerWithCert(t *testing.T, leaf *testca.Cert, document []byte) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(document)
	}))
	server.TLS = &tls.Config{
		Certificates: []tls.Certificate{{
			Certificate: [][]byte{leaf.DER},
			PrivateKey:  leaf.Key.RSA,
		}},
		MinVersion: tls.VersionTLS12,
	}
	server.StartTLS()
	t.Cleanup(server.Close)

	// Sanity: the served certificate must be the one the test thinks it is.
	if _, err := x509.ParseCertificate(leaf.DER); err != nil {
		t.Fatalf("test leaf is not parseable by crypto/x509: %v", err)
	}
	return server
}

// TestVerifyHostnameCatchesARotatedCertificateAgainstAPin covers the
// re-attestation path: a caller that pins the leaf a previous verdict was formed
// over must be told the certificate changed, not silently re-bound to the new one.
func TestVerifyHostnameCatchesARotatedCertificateAgainstAPin(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	chain := []*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}
	bundle := buildBundle(t, localhost, chain, kit.rsaLeaf, mustTime(t, "2026-08-30T10:05:00Z"), nil, nil)

	server := evidenceServer(t, kit, bundle)
	defer server.Close()

	result := attestation.VerifyHostname(context.Background(), attestation.Params{
		Hostname:               localhost,
		TrustedRoots:           []attestation.TrustedRoot{{Name: "swarm-cloud-test-rsa", PEM: kit.rsaRoot.PEM}},
		ObservedTLSFingerprint: kit.strayLeaf.Fingerprint(), // the leaf a previous verdict used
		Now:                    mustTime(t, testNow),
		Fetch:                  attestation.FetchOptions{Port: serverPort(t, server)},
	})

	if result.OK || result.Stage != attestation.StageTLSFingerprint {
		t.Fatalf("result = %+v, want a tls-fingerprint denial", result)
	}
	if result.ObservedTLSFingerprint != kit.rsaLeaf.Fingerprint() {
		t.Errorf("observed fingerprint = %q, want the certificate actually served", result.ObservedTLSFingerprint)
	}
}

// TestVerifyHostnameWithTheTLSLeafOutsideTheChain is the production shape: the
// evidence chain is the platform's secp256k1 one, while the certificate on the
// wire is a separate auto-SSL RSA leaf. The JWS is verified under the chain
// leaf; the channel binding is against the observed one. The other live tests
// serve the chain leaf as the TLS certificate, which cannot tell the two apart.
func TestVerifyHostnameWithTheTLSLeafOutsideTheChain(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	chain := []*testca.Cert{kit.k1Leaf, kit.k1Inter, kit.k1Root}

	// tlsLeaf is an RSA certificate from an unrelated issuer — Go's TLS stack
	// cannot serve a secp256k1 one, which is exactly why production separates
	// the two.
	tlsLeaf := kit.strayLeaf
	bundle := buildBundle(t, localhost, chain, kit.k1Leaf, mustTime(t, "2026-08-30T10:05:00Z"),
		func(p map[string]any) { p["certFingerprint"] = tlsLeaf.Fingerprint() },
		func(b map[string]any) { b["certFingerprint"] = tlsLeaf.Fingerprint() })

	server := tlsServerWithCert(t, tlsLeaf, document(t, bundle))
	defer server.Close()

	result := attestation.VerifyHostname(context.Background(), attestation.Params{
		Hostname:     localhost,
		TrustedRoots: []attestation.TrustedRoot{{Name: "swarm-cloud-test-k256", PEM: kit.k1Root.PEM}},
		MaxBundleAge: 24 * time.Hour,
		Now:          mustTime(t, testNow),
		Fetch:        attestation.FetchOptions{Port: serverPort(t, server)},
	})

	if !result.OK {
		t.Fatalf("verification failed at %q: %s", result.Stage, result.Reason)
	}
	if result.MatchedRoot.Fingerprint != kit.k1Root.Fingerprint() {
		t.Errorf("matchedRoot = %q, want the secp256k1 root", result.MatchedRoot.Fingerprint)
	}
	if result.ObservedTLSFingerprint != tlsLeaf.Fingerprint() {
		t.Errorf("observed fingerprint = %q, want the TLS leaf %q",
			result.ObservedTLSFingerprint, tlsLeaf.Fingerprint())
	}
	if result.ObservedTLSFingerprint == kit.k1Leaf.Fingerprint() {
		t.Error("the binding must be against the observed leaf, not the chain leaf")
	}
}
