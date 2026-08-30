package attestation_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

func TestSHA256FingerprintIsUnpaddedBase64URL(t *testing.T) {
	t.Parallel()
	der := []byte("some certificate bytes")
	sum := sha256.Sum256(der)

	got := attestation.SHA256Fingerprint(der)
	want := "sha256/" + base64.RawURLEncoding.EncodeToString(sum[:])
	if got != want {
		t.Fatalf("SHA256Fingerprint = %q, want %q", got, want)
	}
	if strings.Contains(got, "=") || strings.ContainsAny(got[len("sha256/"):], "+/") {
		t.Errorf("fingerprint %q is not unpadded base64url", got)
	}
}

func TestIsFingerprintMatchesTheTypeScriptVerifier(t *testing.T) {
	t.Parallel()
	// Deliberately loose, like libs/swarm-attestation/src/fingerprint.ts: the
	// verifier's shape check must not reject anything the TypeScript verifier
	// would accept, or the two would disagree on a verdict.
	valid := []string{
		attestation.SHA256Fingerprint([]byte("x")),
		"sha256/abc",
		"sha256/" + strings.Repeat("A", 43),
	}
	invalid := []string{"", "sha256/", "sha1/abcdef", "abc", "sha256/has+plus", "sha256/has/slash"}

	for _, value := range valid {
		if !attestation.IsFingerprint(value) {
			t.Errorf("IsFingerprint(%q) = false, want true", value)
		}
	}
	for _, value := range invalid {
		if attestation.IsFingerprint(value) {
			t.Errorf("IsFingerprint(%q) = true, want false", value)
		}
	}
}

func TestNormalizeEvidenceDigestIsIdempotent(t *testing.T) {
	t.Parallel()
	const hexDigest = "c0ffee11c0ffee22c0ffee33c0ffee44c0ffee55c0ffee66c0ffee77c0ffee88"

	canonical, err := attestation.NormalizeEvidenceDigest(hexDigest)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	again, err := attestation.NormalizeEvidenceDigest(canonical)
	if err != nil {
		t.Fatalf("normalize twice: %v", err)
	}
	if again != canonical {
		t.Fatalf("normalising a canonical digest changed it: %q -> %q", canonical, again)
	}
	if !attestation.IsEvidenceDigest(canonical) {
		t.Errorf("IsEvidenceDigest(%q) = false", canonical)
	}
}

func TestEvidenceDigestEqualsAcrossSpellings(t *testing.T) {
	t.Parallel()
	const hexDigest = "c0ffee11c0ffee22c0ffee33c0ffee44c0ffee55c0ffee66c0ffee77c0ffee88"
	canonical, err := attestation.NormalizeEvidenceDigest(hexDigest)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}

	equal, err := attestation.EvidenceDigestEquals(hexDigest, canonical)
	if err != nil || !equal {
		t.Fatalf("EvidenceDigestEquals(hex, base64url) = %v, %v; want true, nil", equal, err)
	}
	if _, err := attestation.EvidenceDigestEquals(hexDigest, "junk"); err == nil {
		t.Error("comparing against junk should be an error, not a silent false")
	}
}

func TestEvidenceDigestHexRoundTrips(t *testing.T) {
	t.Parallel()
	const hexDigest = "c0ffee11c0ffee22c0ffee33c0ffee44c0ffee55c0ffee66c0ffee77c0ffee88"
	canonical, err := attestation.NormalizeEvidenceDigest(hexDigest)
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	got, err := attestation.EvidenceDigestHex(canonical)
	if err != nil {
		t.Fatalf("EvidenceDigestHex: %v", err)
	}
	if got != hexDigest {
		t.Fatalf("EvidenceDigestHex = %q, want %q", got, hexDigest)
	}
	if _, err := hex.DecodeString(got); err != nil {
		t.Fatalf("result is not hex: %v", err)
	}
}

func TestFingerprintsEqual(t *testing.T) {
	t.Parallel()
	a := attestation.SHA256Fingerprint([]byte("a"))
	b := attestation.SHA256Fingerprint([]byte("b"))

	if !attestation.FingerprintsEqual(a, a) {
		t.Error("a fingerprint should equal itself")
	}
	if attestation.FingerprintsEqual(a, b) {
		t.Error("different fingerprints compared equal")
	}
	if attestation.FingerprintsEqual(a, a[:len(a)-1]) {
		t.Error("a prefix compared equal to the full fingerprint")
	}
}
