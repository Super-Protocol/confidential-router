package swarmevidence_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/internal/testca"
)

// canonicalEvidence is the deployment snapshot the payloads digest. Its exact
// bytes matter: evidenceDigest is the SHA-256 of this document.
const canonicalEvidence = `{"version":2,"resources":[{"image":"ghcr.io/super-protocol/router-api@sha256:` +
	`3f0a1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c","kind":"Deployment",` +
	`"name":"router-api"}]}`

// errStub is what a quote appraiser that could not reach an answer returns. The
// wording matters to one case: a registry that could not be consulted must deny
// rather than report an unapproved image, or whoever can cut the registry off
// gets to decide what counts as unsigned.
var errStub = errors.New("the registry could not be consulted: dial tcp: no route to host")

// fixture is one appraisal's worth of material: a pinned root, a chain under
// it, and a quote appraiser that answers without hardware.
//
// The hardware half is not stubbed out of convenience — it is stubbed because
// it is already covered where it can be, by attestation/attestedroot against
// recorded vendor evidence. What these tests are about is the layer above: how
// an appraisal becomes claims, and which outcomes are claims rather than
// denials.
type fixture struct {
	root, inter, leaf *testca.Cert
	k1Root, k1Leaf    *testca.Cert
	stray             *testca.Cert
	freshness         []byte
	appraisal         *swarmevidence.QuoteAppraisal
	now               time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	notBefore := mustTime(t, "2026-08-01T00:00:00Z")
	notAfter := mustTime(t, "2027-08-01T00:00:00Z")

	ca := func(cn string) testca.Template {
		return testca.Template{
			CommonName: cn, NotBefore: notBefore, NotAfter: notAfter,
			IsCA: true, MaxPathLen: -1,
			KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		}
	}
	ee := func(cn string) testca.Template {
		return testca.Template{
			CommonName: cn, NotBefore: notBefore, NotAfter: notAfter,
			MaxPathLen: -1, KeyUsage: x509.KeyUsageDigitalSignature,
		}
	}

	f := &fixture{
		freshness: bytes.Repeat([]byte{0xa5}, 64),
		appraisal: stubAppraisal(),
		now:       mustTime(t, testNow),
	}
	f.root = issue(t, ca("Swarm Cloud Test Root"), testca.RSA, nil)
	f.inter = issue(t, ca("Swarm Cloud Test Intermediate"), testca.RSA, f.root)
	f.leaf = issue(t, ee(testSubject), testca.RSA, f.inter)

	// A root whose key crypto/x509 cannot read at all: the platform issues RSA
	// and P-256 CAs, so this is what "not one of ours" looks like to the
	// appraisal even when the chain itself validates.
	f.k1Root = issue(t, ca("Swarm Cloud Test Root K256"), testca.Secp256k1, nil)
	f.k1Leaf = issue(t, ee(testSubject), testca.Secp256k1, f.k1Root)

	f.stray = issue(t, ee(testSubject), testca.RSA, issue(t, ca("Some Other Cloud Root"), testca.RSA, nil))
	return f
}

func (f *fixture) options() swarmevidence.Options {
	return swarmevidence.Options{
		Subject:                testSubject,
		PKIRoots:               []attestation.TrustedRoot{{Name: "swarm-cloud-test", PEM: f.root.PEM}},
		FreshnessInput:         f.freshness,
		ObservedTLSFingerprint: f.leaf.Fingerprint(),
		QuoteAppraiser:         &stubAppraiser{appraisal: f.appraisal},
		Now:                    f.now,
	}
}

// bundle assembles the evidence document an endpoint would serve.
func (f *fixture) bundle(t *testing.T, mutate func(map[string]any)) []byte {
	t.Helper()
	return f.bundleFrom(t, []*testca.Cert{f.leaf, f.inter, f.root}, f.leaf, mutate)
}

// bundleSignedBy assembles a bundle whose JWS was signed by a key that is not
// the chain's leaf.
func (f *fixture) bundleSignedBy(t *testing.T, signer *testca.Cert) []byte {
	t.Helper()
	return f.bundleFrom(t, []*testca.Cert{f.leaf, f.inter, f.root}, signer, nil)
}

// secp256k1Bundle assembles a bundle whose chain validates and whose root key
// crypto/x509 refuses.
func (f *fixture) secp256k1Bundle(t *testing.T) []byte {
	t.Helper()
	return f.bundleFrom(t, []*testca.Cert{f.k1Leaf, f.k1Root}, f.k1Leaf, nil)
}

func (f *fixture) bundleFrom(
	t *testing.T, chain []*testca.Cert, signer *testca.Cert, mutate func(map[string]any),
) []byte {
	t.Helper()
	leaf := chain[0]
	timestamp := f.now.UTC().Format(time.RFC3339)
	digest := sha256.Sum256([]byte(canonicalEvidence))

	payload := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        testSubject,
		"issuedAt":        timestamp,
		"certFingerprint": leaf.Fingerprint(),
		"evidenceDigest":  attestation.SHA256Fingerprint(digest[:]),
		"evidence":        json.RawMessage(canonicalEvidence),
	}
	jws, err := signer.SignJWS(payload)
	if err != nil {
		t.Fatalf("sign JWS: %v", err)
	}

	pems := make([]string, 0, len(chain))
	for _, cert := range chain {
		pems = append(pems, cert.PEM)
	}
	bundle := map[string]any{
		"version":         "1",
		"kind":            "DeploymentEvidence",
		"hostname":        testSubject,
		"issuedAt":        timestamp,
		"certFingerprint": leaf.Fingerprint(),
		"jws":             jws,
		"certChain":       pems,
	}
	if mutate != nil {
		mutate(bundle)
	}
	encoded, err := json.Marshal(bundle)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	return encoded
}

// stubAppraiser stands in for the hardware half.
type stubAppraiser struct {
	appraisal *swarmevidence.QuoteAppraisal
	err       error
}

func (s *stubAppraiser) Name() string { return "stub" }

func (s *stubAppraiser) AppraiseRootQuote(
	context.Context, *x509.Certificate,
) (*swarmevidence.QuoteAppraisal, error) {
	return s.appraisal, s.err
}

// stubAppraisal is a SEV-SNP root that passed every hardware leg and whose
// image Super Protocol signed — the shape the positive cases start from.
func stubAppraisal() *swarmevidence.QuoteAppraisal {
	return &swarmevidence.QuoteAppraisal{
		Platform:          swarmevidence.PlatformSNPQemu,
		QuoteVerified:     true,
		TCBStatus:         swarmevidence.TCBUnknown,
		CollateralChecked: false,
		KeyBinding:        true,
		NetworkType:       "untrusted",
		Measurements: swarmevidence.Measurements{
			LaunchDigest: "3f" + strings.Repeat("00", 47),
		},
		PlatformSecurity: swarmevidence.PlatformSecurity{
			SnpFirmwareTCB: 23,
			ReportVersion:  3,
			CPUGeneration:  "Genoa",
		},
		MrEnclave:         "c9e148780ef1aa945a2b8578926dc9faaf1fc37038bce04e9613037f1fe42442",
		MrEnclaveApproved: true,
		MrEnclaveSource:   swarmevidence.SourceRegistry,
		SpvmBuild:         "build-448-release",
	}
}

func asDenial(err error, target **swarmevidence.Denial) bool {
	return err != nil && errors.As(err, target)
}

func issue(t *testing.T, template testca.Template, algorithm testca.Algorithm, issuer *testca.Cert) *testca.Cert {
	t.Helper()
	key, err := testca.NewKey(algorithm)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	cert, err := testca.Issue(template, key, issuer)
	if err != nil {
		t.Fatalf("issue %q: %v", template.CommonName, err)
	}
	return cert
}

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed
}
