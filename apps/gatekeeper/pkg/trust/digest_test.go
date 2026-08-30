package trust_test

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

func TestParseDigestNormalisesEverySpelling(t *testing.T) {
	sum := sha256.Sum256([]byte("canonical snapshot"))
	canonical, err := trust.DigestFromBytes(sum[:])
	if err != nil {
		t.Fatal(err)
	}
	hexForm := hex.EncodeToString(sum[:])

	tests := []struct {
		name  string
		input string
	}{
		{"canonical", canonical.String()},
		{"canonical with padding", canonical.String() + "="},
		{"bare lower-case hex", hexForm},
		{"bare upper-case hex", strings.ToUpper(hexForm)},
		{"prefixed hex", "sha256:" + hexForm},
		{"surrounded by whitespace", "  " + canonical.String() + "\n"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := trust.ParseDigest(tc.input)
			if err != nil {
				t.Fatalf("ParseDigest(%q): %v", tc.input, err)
			}
			if got != canonical {
				t.Errorf("ParseDigest(%q) = %q, want %q", tc.input, got, canonical)
			}
		})
	}
}

func TestParseDigestRejectsJunk(t *testing.T) {
	for _, input := range []string{
		"",
		"not-a-digest",
		"sha256/tooshort",
		"sha512/" + strings.Repeat("a", 43),
		hexOfLength(62),
		hexOfLength(66),
		"sha256:" + strings.Repeat("z", 64),
	} {
		if got, err := trust.ParseDigest(input); err == nil {
			t.Errorf("ParseDigest(%q) = %q, want an error — pinning must never accept a value it did not understand", input, got)
		}
	}
}

func TestDigestHexRoundTrip(t *testing.T) {
	sum := sha256.Sum256([]byte("payload"))
	d := trust.Sum([]byte("payload"))

	if got, want := d.Hex(), hex.EncodeToString(sum[:]); got != want {
		t.Errorf("Hex = %q, want %q", got, want)
	}
	back, err := trust.ParseDigest(d.Hex())
	if err != nil {
		t.Fatal(err)
	}
	if back != d {
		t.Errorf("round trip through hex gave %q, want %q", back, d)
	}
	if !d.Equal(back) {
		t.Error("Equal reported two identical digests as different")
	}
	if d.Equal(trust.Sum([]byte("other"))) {
		t.Error("Equal reported two different digests as identical")
	}
}

func TestDigestFromBytesRejectsWrongLength(t *testing.T) {
	if _, err := trust.DigestFromBytes([]byte{1, 2, 3}); err == nil {
		t.Fatal("DigestFromBytes accepted a 3-byte digest")
	}
}

func hexOfLength(n int) string { return strings.Repeat("a", n) }
