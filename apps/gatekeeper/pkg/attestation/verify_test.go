package attestation_test

import (
	"strings"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation/internal/testca"
)

// The shared vectors in libs/attestation-fixtures pin the verdicts both
// implementations must agree on. The tables below cover the rules this
// implementation enforces beyond that set — the chain-hygiene checks and the
// envelope fields — so a regression in them is caught here rather than in a
// later stage of the pipeline.

func TestVerifyBundleRejectsMalformedEnvelopes(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	issuedAt := mustTime(t, "2026-08-30T10:05:00Z")

	cases := map[string]struct {
		mutate func(map[string]any)
		reason string
	}{
		"body is not an object":    {nil, "not a JSON object"},
		"hostname absent":          {func(b map[string]any) { delete(b, "hostname") }, "missing hostname"},
		"hostname empty":           {func(b map[string]any) { b["hostname"] = "" }, "missing hostname"},
		"hostname not a string":    {func(b map[string]any) { b["hostname"] = 7 }, "missing hostname"},
		"issuedAt absent":          {func(b map[string]any) { delete(b, "issuedAt") }, "missing issuedAt"},
		"certFingerprint unscheme": {func(b map[string]any) { b["certFingerprint"] = "deadbeef" }, "certFingerprint is malformed"},
		"jws empty":                {func(b map[string]any) { b["jws"] = "" }, "missing jws"},
		"certChain empty":          {func(b map[string]any) { b["certChain"] = []string{} }, "certChain is missing or malformed"},
		"certChain entry empty":    {func(b map[string]any) { b["certChain"] = []string{""} }, "certChain is missing or malformed"},
		"certChain not an array":   {func(b map[string]any) { b["certChain"] = "one pem" }, "certChain is missing or malformed"},
		"tlsLeaf not a string":     {func(b map[string]any) { b["tlsLeaf"] = 42 }, "tlsLeaf is malformed"},
		"tlsLeaf empty":            {func(b map[string]any) { b["tlsLeaf"] = "" }, "tlsLeaf is malformed"},
		"rootCaTeeQuote not an object": {
			func(b map[string]any) { b["rootCaTeeQuote"] = "a quote" }, "rootCaTeeQuote is malformed",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			body := []byte(`["not","a","bundle"]`)
			if tc.mutate != nil {
				bundle := buildBundle(t, testHostname,
					[]*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}, kit.rsaLeaf, issuedAt, nil, tc.mutate)
				body = document(t, bundle)
			}

			result := attestation.VerifyBundle(body, attestation.Params{
				Hostname:               testHostname,
				TrustedRoots:           []attestation.TrustedRoot{{Name: "root", PEM: kit.rsaRoot.PEM}},
				ObservedTLSFingerprint: kit.rsaLeaf.Fingerprint(),
				Now:                    mustTime(t, testNow),
			})

			if result.OK {
				t.Fatal("expected a fetch-stage denial")
			}
			if result.Stage != attestation.StageFetch {
				t.Fatalf("stage = %q, want fetch (reason: %s)", result.Stage, result.Reason)
			}
			if !strings.Contains(result.Reason, tc.reason) {
				t.Errorf("reason %q does not mention %q", result.Reason, tc.reason)
			}
		})
	}
}

// TestValidateChainEnforcesIssuerHygiene covers the rules that stop a
// well-signed chain from being trusted for the wrong reason: an issuer that is
// not authorised to issue, one that exceeded the depth its own root allowed, and
// one whose name matches but whose key did not sign.
func TestValidateChainEnforcesIssuerHygiene(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	now := mustTime(t, testNow)

	cases := map[string]struct {
		chain  []*testca.Cert
		reason string
	}{
		"issuer is not a CA": {
			[]*testca.Cert{kit.nonCAInterLeaf, kit.nonCAInter, kit.rsaRoot},
			"is not a CA",
		},
		"issuer does not assert keyCertSign": {
			[]*testca.Cert{kit.noCertSignLeaf, kit.noCertSignInter, kit.rsaRoot},
			"does not assert keyCertSign",
		},
		"pathLenConstraint exceeded": {
			[]*testca.Cert{kit.pathLenLeaf, kit.pathLenInter, kit.pathLenRoot},
			"pathLenConstraint=0",
		},
		"issuer name matches but the signature does not": {
			[]*testca.Cert{kit.forgedSignatureLeaf, kit.rsaInter, kit.rsaRoot},
			"signature verification failed",
		},
		"issuer name does not match the next subject": {
			[]*testca.Cert{kit.forgedIssuerLeaf, kit.rsaInter, kit.rsaRoot},
			"issuer does not match next certificate's subject",
		},
		"chain stops before a self-signed root": {
			[]*testca.Cert{kit.rsaLeaf, kit.rsaInter},
			"does not terminate at a self-signed root",
		},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			pems := make([]string, 0, len(tc.chain))
			for _, cert := range tc.chain {
				pems = append(pems, cert.PEM)
			}

			_, err := attestation.ValidateChain(pems, now)
			if err == nil {
				t.Fatal("expected the chain to be rejected")
			}
			if !strings.Contains(err.Error(), tc.reason) {
				t.Errorf("err = %q, want it to mention %q", err, tc.reason)
			}
		})
	}
}

func TestValidateChainEnforcesValidityWindows(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	pems := []string{kit.rsaLeaf.PEM, kit.rsaInter.PEM, kit.rsaRoot.PEM}

	if _, err := attestation.ValidateChain(pems, mustTime(t, "2027-09-01T00:00:00Z")); err == nil ||
		!strings.Contains(err.Error(), "has expired") {
		t.Errorf("err = %v, want an expiry rejection", err)
	}
	if _, err := attestation.ValidateChain(pems, mustTime(t, "2026-07-01T00:00:00Z")); err == nil ||
		!strings.Contains(err.Error(), "is not yet valid") {
		t.Errorf("err = %v, want a not-yet-valid rejection", err)
	}
}

// TestVerifyBundleFreshnessWindow pins the three outcomes around issuedAt:
// inside the window, too old, and further ahead than benign clock drift.
func TestVerifyBundleFreshnessWindow(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	now := mustTime(t, testNow)

	cases := map[string]struct {
		issuedAt string
		maxAge   time.Duration
		wantOK   bool
		reason   string
	}{
		"fresh":                        {"2026-08-30T10:05:00Z", 24 * time.Hour, true, ""},
		"30s in the future is drift":   {"2026-08-30T10:06:30Z", 24 * time.Hour, true, ""},
		"an hour ahead is not":         {"2026-08-30T11:06:00Z", 24 * time.Hour, false, "in the future"},
		"older than the window":        {"2026-08-28T10:05:00Z", 24 * time.Hour, false, "exceeds maxBundleAge"},
		"no window accepts an old one": {"2026-08-02T00:00:00Z", 0, true, ""},
	}

	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			bundle := buildBundle(t, testHostname,
				[]*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}, kit.rsaLeaf,
				mustTime(t, tc.issuedAt), nil, nil)

			result := attestation.VerifyBundle(document(t, bundle), attestation.Params{
				Hostname:               testHostname,
				TrustedRoots:           []attestation.TrustedRoot{{Name: "root", PEM: kit.rsaRoot.PEM}},
				ObservedTLSFingerprint: kit.rsaLeaf.Fingerprint(),
				MaxBundleAge:           tc.maxAge,
				Now:                    now,
			})

			if tc.wantOK {
				if !result.OK {
					t.Fatalf("expected ok, got %q: %s", result.Stage, result.Reason)
				}
				return
			}
			if result.OK || result.Stage != attestation.StageJWS {
				t.Fatalf("result = %+v, want a jws-stage denial", result)
			}
			if !strings.Contains(result.Reason, tc.reason) {
				t.Errorf("reason %q does not mention %q", result.Reason, tc.reason)
			}
		})
	}
}

// TestVerifyBundleUnparseableIssuedAt: issuedAt is only parsed when a freshness
// window is set, so an unusable timestamp must surface there rather than being
// silently tolerated.
func TestVerifyBundleUnparseableIssuedAt(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	bundle := buildBundle(t, testHostname,
		[]*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}, kit.rsaLeaf,
		mustTime(t, "2026-08-30T10:05:00Z"),
		func(p map[string]any) { p["issuedAt"] = "yesterday" }, nil)

	result := attestation.VerifyBundle(document(t, bundle), attestation.Params{
		Hostname:               testHostname,
		TrustedRoots:           []attestation.TrustedRoot{{Name: "root", PEM: kit.rsaRoot.PEM}},
		ObservedTLSFingerprint: kit.rsaLeaf.Fingerprint(),
		MaxBundleAge:           24 * time.Hour,
		Now:                    mustTime(t, testNow),
	})

	if result.OK || result.Stage != attestation.StageJWS ||
		!strings.Contains(result.Reason, "not a parseable timestamp") {
		t.Fatalf("result = %+v, want a jws-stage denial about the timestamp", result)
	}
}

func TestVerifyBundleAcceptsBothKeyAlgorithms(t *testing.T) {
	t.Parallel()
	kit := testKitFor(t)
	issuedAt := mustTime(t, "2026-08-30T10:05:00Z")

	for name, tc := range map[string]struct {
		chain []*testca.Cert
		root  *testca.Cert
	}{
		"RS256 over an RSA chain":       {[]*testca.Cert{kit.rsaLeaf, kit.rsaInter, kit.rsaRoot}, kit.rsaRoot},
		"ES256K over a secp256k1 chain": {[]*testca.Cert{kit.k1Leaf, kit.k1Inter, kit.k1Root}, kit.k1Root},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			bundle := buildBundle(t, testHostname, tc.chain, tc.chain[0], issuedAt, nil, nil)

			result := attestation.VerifyBundle(document(t, bundle), attestation.Params{
				Hostname:               testHostname,
				TrustedRoots:           []attestation.TrustedRoot{{Name: "root", PEM: tc.root.PEM}},
				ObservedTLSFingerprint: tc.chain[0].Fingerprint(),
				MaxBundleAge:           24 * time.Hour,
				Now:                    mustTime(t, testNow),
			})

			if !result.OK {
				t.Fatalf("verification failed at %q: %s", result.Stage, result.Reason)
			}
			if result.MatchedRoot.Fingerprint != tc.root.Fingerprint() {
				t.Errorf("matchedRoot.Fingerprint = %q, want %q", result.MatchedRoot.Fingerprint, tc.root.Fingerprint())
			}
		})
	}
}
