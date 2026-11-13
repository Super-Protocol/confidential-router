package swarmevidence_test

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	swarmevidence "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go"
	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// regenerateFixtures is the switch that rewrites testdata/delegated.
//
// The fixtures are committed rather than generated on every run because they
// are the *recorded* half of the contract: a token a Verifier issued, and a
// key set that authenticates it. Regenerating them silently would make a test
// that only ever agrees with itself.
const regenerateFixtures = "SWARM_REGENERATE_FIXTURES"

// fixtureIssuedAt is the instant the recorded tokens are dated.
var fixtureIssuedAt = time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC)

// TestRegenerateDelegatedFixtures rewrites the recorded Verifier fixtures.
//
//	SWARM_REGENERATE_FIXTURES=1 go test -run TestRegenerateDelegatedFixtures ./...
//
// It reuses the committed signing keys when they are there, so regenerating a
// token does not invalidate a reviewer's memory of which key signs what.
func TestRegenerateDelegatedFixtures(t *testing.T) {
	if os.Getenv(regenerateFixtures) == "" {
		t.Skipf("set %s=1 to rewrite %s", regenerateFixtures, delegatedFixtureDir)
	}

	quote := recordedQuote(t)
	mrEnclave := fixtureMrEnclave(t, quote)
	for _, build := range []func(*testing.T, fixtureQuote, string) *delegatedFixture{
		buildITAFixture, buildEARFixture,
	} {
		fixture := build(t, quote, mrEnclave)
		encoded, err := json.MarshalIndent(fixture, "", "  ")
		if err != nil {
			t.Fatalf("marshalling the %s fixture: %v", fixture.Verifier, err)
		}
		path := filepath.Join(delegatedFixtureDir, fixture.Verifier+".json")
		if err := os.WriteFile(path, append(encoded, '\n'), 0o644); err != nil {
			t.Fatalf("writing %s: %v", path, err)
		}
		t.Logf("wrote %s", path)
	}
}

// recordedQuote is the TD both recorded Verifiers appraise.
//
// Its report data is the binding digest of the request the composite fixtures
// are appraised against, because that is what a per-request quote carries: a
// quote whose guest-chosen field held anything else would be refused at the
// binding stage before any of this mattered.
func recordedQuote(t *testing.T) fixtureQuote {
	t.Helper()
	return fixtureQuote{
		Platform:     string(swarmevidence.PlatformTDXGCP),
		TDAttributes: "0000001000000000",
		MRTD:         strings.Repeat("11", 48),
		RTMR1:        strings.Repeat("22", 48),
		RTMR2:        strings.Repeat("33", 48),
		RTMR3:        strings.Repeat("44", 48),
		TeeTCBSVN:    "05000600000000000000000000000000",
		EventLog: []fixtureEventEntry{
			{Type: "EV_EFI_PLATFORM_FIRMWARE_BLOB", Digest: strings.Repeat("a1", 48)},
			{Type: "EV_SEPARATOR", Digest: strings.Repeat("b2", 48)},
			{Type: "EV_EFI_PLATFORM_FIRMWARE_BLOB2", Digest: strings.Repeat("c3", 48)},
			{Type: "EV_EVENT_TAG", Digest: strings.Repeat("d4", 48)},
		},
		ReportData: hex.EncodeToString(bindingDigest(testFreshness, testTarget, testRequestee)),
	}
}

// fixtureMrEnclave is the image identity the recorded quote normalises to,
// computed here from the published formula so the committed value is a
// statement about the formula rather than an echo of one run.
func fixtureMrEnclave(t *testing.T, quote fixtureQuote) string {
	t.Helper()
	normalized := replayEventLog(t, quote.EventLog, map[string]bool{
		"EV_EFI_PLATFORM_FIRMWARE_BLOB": true, "EV_EFI_PLATFORM_FIRMWARE_BLOB2": true,
	})
	sum := sha256.New()
	for _, part := range [][]byte{
		unhex(t, quote.TDAttributes), unhex(t, quote.MRTD), normalized,
		unhex(t, quote.RTMR1), unhex(t, quote.RTMR2), unhex(t, quote.RTMR3),
	} {
		sum.Write(part)
	}
	return hex.EncodeToString(sum.Sum(nil))
}

// buildITAFixture reconstructs an Intel Trust Authority token.
//
// The shape — every TDX claim nested inside a `tdx` object, the `attester_*`
// claims among them, hex registers, a numeric `tdx_seamsvn`, PS384 over RSA —
// is taken from Intel's published sample,
// https://docs.trustauthority.intel.com/main/articles/concept-attestation-tokens.html.
// Claims the appraisal does not read are carried anyway, so that what the
// mapping has to find its way through is a token of realistic shape rather
// than one trimmed to the mapping.
func buildITAFixture(t *testing.T, quote fixtureQuote, mrEnclave string) *delegatedFixture {
	t.Helper()
	key := rsaFixtureKey(t, "intel-trust-authority")
	rtmr0 := hex.EncodeToString(replayEventLog(t, quote.EventLog, nil))
	claims := map[string]any{
		"iss":                   "https://portal.trustauthority.intel.com",
		"iat":                   fixtureIssuedAt.Unix(),
		"nbf":                   fixtureIssuedAt.Unix(),
		"exp":                   fixtureIssuedAt.Add(5 * time.Minute).Unix(),
		"jti":                   "64b78ebb-04bd-4d33-9db8-245196916941",
		"ver":                   "2.0.0",
		"eat_profile":           "https://portal.trustauthority.intel.com/eat_profile.html",
		"intuse":                "generic",
		"appraisal":             map[string]any{"method": "default", "ver": 2},
		"verifier_instance_ids": []any{"a02aa0ee-c849-417c-8413-1ce2579f69f3"},
		"tdx": map[string]any{
			"attester_type":       "TDX",
			"attester_tcb_status": "UpToDate",
			"attester_tcb_date":   "2026-05-14T00:00:00Z",
			"dbgstat":             "disabled",
			"tdx_is_debuggable":   false,
			"tdx_is_migratable":   false,
			"tdx_mrtd":            quote.MRTD,
			"tdx_rtmr0":           rtmr0,
			"tdx_rtmr1":           quote.RTMR1,
			"tdx_rtmr2":           quote.RTMR2,
			"tdx_rtmr3":           quote.RTMR3,
			"tdx_td_attributes":   quote.TDAttributes,
			"tdx_seamsvn":         263,
			"tdx_tee_tcb_svn":     quote.TeeTCBSVN,
			"tdx_seam_attributes": "0000000000000000",
			"tdx_xfam":            "e702060000000000",
			// The quote's REPORT_DATA. Not to be confused with
			// `attester_held_data` beside it, which is the caller's own
			// binary runtime data in base64 and is carried here precisely so
			// that a mapping pointed at the wrong one of the two would be
			// caught by a fixture rather than by a live appraisal.
			"tdx_report_data":    quote.ReportData,
			"attester_held_data": base64Std([]byte("the caller's own runtime data, not the report data")),
		},
	}
	return &delegatedFixture{
		Verifier: "intel-trust-authority",
		Note: "Intel Trust Authority as the demonstration stand's stand-in Verifier. " +
			"**Reconstructed, not recorded**: the claim names, nesting, encodings and signature " +
			"algorithm are taken from Intel's published sample token at " +
			"https://docs.trustauthority.intel.com/main/articles/concept-attestation-tokens.html, " +
			"and the token is signed by a key generated for this repository over the synthetic " +
			"quote the harness rebuilds. What it pins is the claim mapping; only the live test " +
			"against a real tenant (SUP-642) can confirm it.",
		Issuer:             claims["iss"].(string),
		JWKS:               jwksDocument(t, key.Public(), "ita-2026-11", "PS384"),
		VerificationKeyPEM: publicKeyPEM(t, key.Public()),
		Token:              signJWT(t, "PS384", "ita-2026-11", key, claims),
		Mapping:            swarmevidence.ITAClaimMapping(),
		Quote:              quote,
		ExpectedMrEnclave:  mrEnclave,
	}
}

// buildEARFixture records a second Verifier that shares nothing with the
// first: Veraison-style EAR claim names — nested, with dots *inside* the
// names — base64 rather than hex, its own issuer, ES256 over P-256.
func buildEARFixture(t *testing.T, quote fixtureQuote, mrEnclave string) *delegatedFixture {
	t.Helper()
	key := ecFixtureKey(t, "acme-ear-verifier")
	rtmr0 := replayEventLog(t, quote.EventLog, nil)
	evidence := map[string]any{
		"tdx.tdattributes": base64Std(unhex(t, quote.TDAttributes)),
		"tdx.mrtd":         base64Std(unhex(t, quote.MRTD)),
		"tdx.rtmr0":        base64Std(rtmr0),
		"tdx.rtmr1":        base64Std(unhex(t, quote.RTMR1)),
		"tdx.rtmr2":        base64Std(unhex(t, quote.RTMR2)),
		"tdx.rtmr3":        base64Std(unhex(t, quote.RTMR3)),
		"tdx.tee-tcb-svn":  5,
		"tdx.report-data":  base64Std(unhex(t, quote.ReportData)),
	}
	claims := map[string]any{
		"iss":             "https://verifier.acme-bank.example/ear",
		"aud":             "https://vault.bank.example",
		"iat":             fixtureIssuedAt.Unix(),
		"exp":             fixtureIssuedAt.Add(5 * time.Minute).Unix(),
		"ear.verifier-id": map[string]any{"developer": "acme-bank", "build": "ear-1"},
		"submods": map[string]any{
			"TDX": map[string]any{
				"ear.status":                      "affirming",
				"ear.veraison.annotated-evidence": evidence,
			},
		},
	}
	annotated := func(name string) swarmevidence.ClaimPath {
		return swarmevidence.ClaimPath{"submods", "TDX", "ear.veraison.annotated-evidence", name}
	}
	return &delegatedFixture{
		Verifier: "acme-ear-verifier",
		Note: "A second EAT-emitting Verifier, and deliberately nothing like the first: other claim " +
			"names (nested, with dots inside the names, as an EAR's annotated evidence has), base64 " +
			"instead of hex, another issuer, another algorithm and another signing key. It appraises " +
			"the same quote as the ITA fixture and must produce the same SwarmClaims.",
		Issuer:             claims["iss"].(string),
		Audience:           claims["aud"].(string),
		JWKS:               jwksDocument(t, key.Public(), "acme-ear-1", "ES256"),
		VerificationKeyPEM: publicKeyPEM(t, key.Public()),
		Token:              signJWT(t, "ES256", "acme-ear-1", key, claims),
		Mapping: swarmevidence.ClaimMapping{
			TDAttributes:        annotated("tdx.tdattributes"),
			MRTD:                annotated("tdx.mrtd"),
			RTMR0:               annotated("tdx.rtmr0"),
			RTMR1:               annotated("tdx.rtmr1"),
			RTMR2:               annotated("tdx.rtmr2"),
			RTMR3:               annotated("tdx.rtmr3"),
			SeamSVN:             annotated("tdx.tee-tcb-svn"),
			BindingData:         annotated("tdx.report-data"),
			TCBStatus:           swarmevidence.ClaimPath{"submods", "TDX", "ear.status"},
			Encoding:            swarmevidence.EncodingBase64,
			BindingDataEncoding: swarmevidence.EncodingBase64,
		},
		Quote:             quote,
		ExpectedMrEnclave: mrEnclave,
	}
}

// rsaFixtureKey loads, or mints, the committed RSA signing key of a recorded
// Verifier.
func rsaFixtureKey(t *testing.T, name string) *rsa.PrivateKey {
	t.Helper()
	if octets, err := os.ReadFile(fixtureKeyPath(name)); err == nil {
		block, _ := pem.Decode(octets)
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			t.Fatalf("reading the %s signing key: %v", name, err)
		}
		return key.(*rsa.PrivateKey)
	}
	key, err := rsa.GenerateKey(rand.Reader, 3072)
	if err != nil {
		t.Fatalf("generating the %s signing key: %v", name, err)
	}
	writeFixtureKey(t, name, key)
	return key
}

// ecFixtureKey does the same for a P-256 key.
func ecFixtureKey(t *testing.T, name string) *ecdsa.PrivateKey {
	t.Helper()
	if octets, err := os.ReadFile(fixtureKeyPath(name)); err == nil {
		block, _ := pem.Decode(octets)
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			t.Fatalf("reading the %s signing key: %v", name, err)
		}
		return key.(*ecdsa.PrivateKey)
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generating the %s signing key: %v", name, err)
	}
	writeFixtureKey(t, name, key)
	return key
}

func fixtureKeyPath(name string) string {
	return filepath.Join(delegatedFixtureDir, "keys", name+".key.pem")
}

func writeFixtureKey(t *testing.T, name string, key crypto.PrivateKey) {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshalling the %s signing key: %v", name, err)
	}
	path := fixtureKeyPath(name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("creating %s: %v", filepath.Dir(path), err)
	}
	document := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})
	if err := os.WriteFile(path, document, 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// jwksDocument renders a public key the way a Verifier's key-set endpoint
// publishes it.
func jwksDocument(t *testing.T, key crypto.PublicKey, keyID, algorithm string) json.RawMessage {
	t.Helper()
	entry := map[string]any{"kid": keyID, "alg": algorithm, "use": "sig"}
	switch public := key.(type) {
	case *rsa.PublicKey:
		entry["kty"] = "RSA"
		entry["n"] = base64.RawURLEncoding.EncodeToString(public.N.Bytes())
		entry["e"] = base64.RawURLEncoding.EncodeToString(big.NewInt(int64(public.E)).Bytes())
	case *ecdsa.PublicKey:
		// The uncompressed point, 0x04 ‖ X ‖ Y, split back into the two
		// coordinates a JWK publishes.
		point, err := public.Bytes()
		if err != nil {
			t.Fatalf("encoding the EC public key: %v", err)
		}
		size := (len(point) - 1) / 2
		entry["kty"] = "EC"
		entry["crv"] = "P-256"
		entry["x"] = base64.RawURLEncoding.EncodeToString(point[1 : 1+size])
		entry["y"] = base64.RawURLEncoding.EncodeToString(point[1+size:])
	default:
		t.Fatalf("no key set rendering for %T", key)
	}
	encoded, err := json.Marshal(map[string]any{"keys": []any{entry}})
	if err != nil {
		t.Fatalf("marshalling the key set: %v", err)
	}
	return encoded
}

// signJWT mints one compact JWS, which is what both an EAT in JWT
// serialisation and a tampered copy of one are.
func signJWT(t *testing.T, algorithm, keyID string, key crypto.PrivateKey, claims map[string]any) string {
	t.Helper()
	header := map[string]any{"alg": algorithm, "typ": "JWT"}
	if keyID != "" {
		header["kid"] = keyID
	}
	headerJSON, err := json.Marshal(header)
	if err != nil {
		t.Fatalf("marshalling the token header: %v", err)
	}
	claimsJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshalling the token claims: %v", err)
	}
	signed := base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(claimsJSON)

	signature, err := signToken(algorithm, key, []byte(signed))
	if err != nil {
		t.Fatalf("signing the token: %v", err)
	}
	return signed + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func signToken(algorithm string, key crypto.PrivateKey, signed []byte) ([]byte, error) {
	switch algorithm {
	case "PS384":
		digest := sha512.Sum384(signed)
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("PS384 needs an RSA key, got %T", key)
		}
		return rsa.SignPSS(rand.Reader, rsaKey, crypto.SHA384, digest[:],
			&rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash, Hash: crypto.SHA384})
	case "RS256":
		digest := sha256.Sum256(signed)
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("RS256 needs an RSA key, got %T", key)
		}
		return rsa.SignPKCS1v15(rand.Reader, rsaKey, crypto.SHA256, digest[:])
	case "ES256":
		digest := sha256.Sum256(signed)
		ecKey, ok := key.(*ecdsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("ES256 needs an EC key, got %T", key)
		}
		r, s, err := ecdsa.Sign(rand.Reader, ecKey, digest[:])
		if err != nil {
			return nil, err
		}
		size := (ecKey.Curve.Params().BitSize + 7) / 8
		return append(leftPad(r.Bytes(), size), leftPad(s.Bytes(), size)...), nil
	default:
		return nil, fmt.Errorf("no signer for %s", algorithm)
	}
}

func leftPad(octets []byte, size int) []byte {
	if len(octets) >= size {
		return octets
	}
	out := make([]byte, size)
	copy(out[size-len(octets):], octets)
	return out
}

// publicKeyPEM renders a public key the way [swarmevidence.PinnedKeys] takes
// one.
func publicKeyPEM(t *testing.T, key crypto.PublicKey) string {
	t.Helper()
	der, err := x509.MarshalPKIXPublicKey(key)
	if err != nil {
		t.Fatalf("marshalling a public key: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

var _ = attestedroot.ErrNotInRegistry
