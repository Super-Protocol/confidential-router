package attestedroot

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"
)

// pinnedMeasurement is a well-formed measurement standing for an image nobody
// signed.
const pinnedMeasurement = "bb6962eb20d616eb0f19479cf7fbccda50ee5682eab75b2104915d305a826aab"

func TestParseMeasurement(t *testing.T) {
	for _, tc := range []struct {
		name  string
		in    string
		want  string
		wantE string
	}{
		{name: "bare hex", in: pinnedMeasurement, want: pinnedMeasurement},
		{name: "upper case", in: strings.ToUpper(pinnedMeasurement), want: pinnedMeasurement},
		{name: "surrounding space", in: "  " + pinnedMeasurement + "\n", want: pinnedMeasurement},
		// The CLI takes every other digest as `sha256:<hex>`, so pasting one
		// here is the mistake to absorb rather than the one to punish.
		{name: "a sha256 prefix", in: "sha256:" + pinnedMeasurement, want: pinnedMeasurement},
		{name: "an 0x prefix", in: "0x" + pinnedMeasurement, want: pinnedMeasurement},
		{name: "empty", in: "   ", wantE: "required"},
		{name: "not hex", in: strings.Repeat("z", 64), wantE: "not hex"},
		{name: "too short", in: pinnedMeasurement[:62], wantE: "expected 32"},
		{name: "too long", in: pinnedMeasurement + "ab", wantE: "expected 32"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ParseMeasurement(tc.in)
			if tc.wantE != "" {
				if err == nil {
					t.Fatalf("ParseMeasurement(%q) = %q, want an error naming %q", tc.in, got, tc.wantE)
				}
				if !strings.Contains(err.Error(), tc.wantE) {
					t.Errorf("error = %q, want it to mention %q", err, tc.wantE)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseMeasurement(%q): %v", tc.in, err)
			}
			if got != tc.want {
				t.Errorf("ParseMeasurement(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestAdmitMeasurementPrefersTheRegistry is the ordering the whole feature rests
// on: a measurement Super Protocol signed is reported as registry-signed even
// when the operator pinned it too.
//
// Without it, a belt-and-braces pin would silently demote a legitimate root to
// `operator-pinned`, and a policy written to accept only registry roots would
// start refusing the clouds it was written for.
func TestAdmitMeasurementPrefersTheRegistry(t *testing.T) {
	registry := &stubRegistry{}
	v := &Verifier{Registry: registry, TrustedMeasurements: []string{pinnedMeasurement}}

	result := &Result{Measurement: mustHex(t, pinnedMeasurement)}
	if !v.AdmitMeasurement(context.Background(), result, EvidenceSevSnpQemu) {
		t.Fatalf("a registry-signed measurement was refused: %s", result.Reason)
	}
	if got, want := result.MeasurementSource, SourceRegistry; got != want {
		t.Errorf("source = %q, want %q", got, want)
	}
	if !result.InRegistry {
		t.Error("inRegistry = false for a measurement the registry vouched for")
	}
}

// TestAdmitMeasurementFallsBackToTheOperatorsPin is SUP-139 itself: the registry
// has no signature for this image, the operator said they accept it anyway, and
// the root is admitted — labelled so that everything downstream can tell.
func TestAdmitMeasurementFallsBackToTheOperatorsPin(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{name: "the registry says no", err: ErrNotInRegistry},
		// A pin is a local statement; it does not stop being true because a Git
		// host is unreachable.
		{name: "the registry cannot be reached", err: errors.New("dial tcp: no route to host")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := &Verifier{
				Registry:            &stubRegistry{err: tc.err},
				TrustedMeasurements: []string{"sha256:" + strings.ToUpper(pinnedMeasurement)},
			}
			result := &Result{Measurement: mustHex(t, pinnedMeasurement)}
			if !v.AdmitMeasurement(context.Background(), result, EvidenceSevSnpQemu) {
				t.Fatalf("a pinned measurement was refused: %s", result.Reason)
			}
			if got, want := result.MeasurementSource, SourceOperatorPinned; got != want {
				t.Errorf("source = %q, want %q", got, want)
			}
			// The pin admits the root; it does not let it claim a signature it
			// does not have.
			if result.InRegistry {
				t.Error("inRegistry = true for a measurement only the operator vouched for")
			}
		})
	}
}

// TestAdmitMeasurementRefusesAnUnvouchedMeasurement keeps the default closed:
// with no pin, an absent signature is still a denial, and the reason names both
// anchors so the operator knows which one to reach for.
func TestAdmitMeasurementRefusesAnUnvouchedMeasurement(t *testing.T) {
	v := &Verifier{Registry: &stubRegistry{err: ErrNotInRegistry}}
	result := &Result{Measurement: mustHex(t, pinnedMeasurement)}

	if v.AdmitMeasurement(context.Background(), result, EvidenceSevSnpQemu) {
		t.Fatal("an unsigned, unpinned measurement was admitted")
	}
	for _, want := range []string{pinnedMeasurement, "trusted registry", "trustedMeasurements"} {
		if !strings.Contains(result.Reason, want) {
			t.Errorf("reason = %q, want it to mention %q", result.Reason, want)
		}
	}
	if !result.NeedsMeasurementAnchor() {
		t.Error("NeedsMeasurementAnchor = false for the one denial a pin would clear")
	}
}

// TestAdmitMeasurementIgnoresAPinForAnotherImage is the property that makes a
// pin narrow: it admits the image it names and nothing else.
func TestAdmitMeasurementIgnoresAPinForAnotherImage(t *testing.T) {
	other := strings.Repeat("ab", 32)
	v := &Verifier{
		Registry:            &stubRegistry{err: ErrNotInRegistry},
		TrustedMeasurements: []string{other, "not-a-measurement"},
	}
	result := &Result{Measurement: mustHex(t, pinnedMeasurement)}

	if v.AdmitMeasurement(context.Background(), result, EvidenceSevSnpQemu) {
		t.Fatalf("a pin for %s admitted %s", other, pinnedMeasurement)
	}
	if result.MeasurementSource != "" {
		t.Errorf("source = %q, want none", result.MeasurementSource)
	}
}

// TestAdmitMeasurementRefusesWithoutAMeasurement covers the caller that never
// got that far: a report whose measurement could not be derived has nothing to
// match a pin against, and must not be admitted by an empty comparison.
func TestAdmitMeasurementRefusesWithoutAMeasurement(t *testing.T) {
	v := &Verifier{Registry: &stubRegistry{}, TrustedMeasurements: []string{pinnedMeasurement}}
	result := &Result{}

	if v.AdmitMeasurement(context.Background(), result, EvidenceSevSnpQemu) {
		t.Fatal("a result with no measurement was admitted")
	}
	if result.NeedsMeasurementAnchor() {
		t.Error("NeedsMeasurementAnchor = true for a denial no pin can clear")
	}
}

// TestAPinDoesNotReplaceTheKeyBinding is the guarantee the feature is sold on,
// over the real Super Swarm Root CA evidence: pinning the measurement that
// evidence produces still does not admit a certificate the report was not
// issued for.
//
// The fixture's certificate is not the one the report commits to (see
// TestVerifyRealSwarmRootEvidence), so this is the real check failing for the
// real reason — with the pin in place and the registry never consulted.
func TestAPinDoesNotReplaceTheKeyBinding(t *testing.T) {
	cert := newRootCert(t, rootCertOptions{
		challengeType: "sev-snp",
		networkType:   string(NetworkUntrusted),
		evidence:      swarmRootEvidence(t),
	})
	registry := &stubRegistry{}
	v := &Verifier{
		Registry:            registry,
		Artifacts:           fixedArtifacts{build: "build-350", artifacts: build350(t)},
		TrustedMeasurements: []string{pinnedMeasurement, strings.Repeat("cd", 32)},
		Now:                 func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) },
		CacheTTL:            -1,
	}

	result, err := v.Verify(context.Background(), cert)
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}
	if result.Attested {
		t.Fatalf("a pin admitted a root the report does not commit to: %+v", result)
	}
	if !strings.Contains(result.Reason, "reportData") {
		t.Errorf("reason = %q, want the reportData binding", result.Reason)
	}
	if len(registry.asked) != 0 {
		t.Error("the registry was consulted for a root that failed the key binding")
	}
	if result.MeasurementSource != "" {
		t.Errorf("source = %q, want none for a root that never reached the measurement leg",
			result.MeasurementSource)
	}
}

// TestAPinDoesNotRescueATamperedReport is the same guarantee against the other
// half of the hardware check: flip a byte the AMD key signed, pin the
// measurement the untampered evidence would have produced, and the root is
// still refused — at report integrity, before any measurement exists.
func TestAPinDoesNotRescueATamperedReport(t *testing.T) {
	evidence := swarmRootEvidence(t)
	tampered := make([]byte, len(evidence))
	copy(tampered, evidence)
	parsed, err := ParseEvidence(evidence)
	if err != nil {
		t.Fatal(err)
	}
	offset := indexOf(tampered, parsed.SevSnp.RawReport)
	if offset < 0 {
		t.Fatal("could not locate the raw report inside the serialised evidence")
	}
	// MEASUREMENT sits at 0x90 of the report, inside the signed region.
	tampered[offset+0x90] ^= 0xff

	cert := newRootCert(t, rootCertOptions{challengeType: "sev-snp", evidence: tampered})
	v := &Verifier{
		Registry:  &stubRegistry{},
		Artifacts: fixedArtifacts{build: "build-350", artifacts: build350(t)},
		// Pin every measurement the tampered report could plausibly claim.
		TrustedMeasurements: []string{pinnedMeasurement, hex.EncodeToString(parsed.SevSnp.RawReport[0x90 : 0x90+32])},
		Now:                 func() time.Time { return time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC) },
		CacheTTL:            -1,
	}

	result, err := v.Verify(context.Background(), cert)
	if err != nil {
		t.Fatalf("Verify returned an error: %v", err)
	}
	if result.Attested || result.ReportIntegrity {
		t.Fatalf("a pin admitted a tampered report: %+v", result)
	}
	if !strings.Contains(result.Reason, "attestation report") {
		t.Errorf("reason = %q, want it to name the attestation report", result.Reason)
	}
}

// TestLabelNamesTheAnchor pins the one line a verdict has room for. "attested"
// alone was enough while there was one way to be attested; there are two now,
// and they do not prove the same thing.
func TestLabelNamesTheAnchor(t *testing.T) {
	for _, tc := range []struct {
		source MeasurementSource
		want   string
	}{
		{source: SourceRegistry, want: "attested (registry)"},
		{source: SourceOperatorPinned, want: "attested (operator-pinned)"},
	} {
		result := &Result{Attested: true, MeasurementSource: tc.source}
		if got := result.Label(); got != tc.want {
			t.Errorf("Label() = %q, want %q", got, tc.want)
		}
	}
}
