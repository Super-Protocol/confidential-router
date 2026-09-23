package attestedroot

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// MeasurementSource names what vouched for a VM measurement. It is the one
// difference between the two ways an attested root can be admitted, and it is
// carried all the way to the report and the Rego input so that a stricter
// deployment can refuse one of them.
type MeasurementSource string

const (
	// SourceRegistry means Super Protocol signed this measurement, checked
	// against the key pinned in this binary. It is the closed chain the whole
	// anchor was designed around.
	SourceRegistry MeasurementSource = "registry"
	// SourceOperatorPinned means the registry does not vouch for this
	// measurement and the operator listed it in
	// `attestedRoots.trustedMeasurements` themselves.
	//
	// It proves strictly less: that this VM ran the image whose measurement the
	// operator decided to accept, rather than one Super Protocol published. The
	// hardware half of the check is untouched — report signature, vendor chain,
	// reportData↔key binding and the measurement rebuild all still have to pass
	// — so a pin cannot admit a root that is not running in a real TEE, and it
	// cannot admit an image other than the one that was pinned.
	SourceOperatorPinned MeasurementSource = "operator-pinned"
)

// measurementBytes is the length of a normalised mrEnclave.
const measurementBytes = 32

// ParseMeasurement normalises the hex spelling of a VM measurement, the way the
// registry names one (`mrenclave-<hex>.json`) and the way every gatekeeper
// surface prints one.
//
// An optional `sha256:` prefix is accepted because that is the shape of every
// other digest the CLI takes, and pasting one here is the obvious mistake.
func ParseMeasurement(s string) (string, error) {
	value := strings.TrimSpace(s)
	value = strings.TrimPrefix(value, "sha256:")
	value = strings.TrimPrefix(value, "0x")
	if value == "" {
		return "", errors.New("a measurement is required")
	}
	raw, err := hex.DecodeString(strings.ToLower(value))
	if err != nil {
		return "", fmt.Errorf("measurement %q is not hex: %w", s, err)
	}
	if len(raw) != measurementBytes {
		return "", fmt.Errorf("measurement %q is %d bytes, expected %d (a %d-character hex string)",
			s, len(raw), measurementBytes, 2*measurementBytes)
	}
	return hex.EncodeToString(raw), nil
}

// AdmitMeasurement decides the last leg of an attested-root check: who vouches
// for the measurement on result, if anybody. It records the answer on result and
// reports whether the root may be admitted; a refusal leaves result.Reason
// naming the anchor that was missing.
//
// The registry is asked first, always, so a measurement Super Protocol did sign
// is reported as registry-signed even when the operator also pinned it — a
// policy that refuses operator-pinned roots must not start refusing legitimate
// ones because somebody added a belt-and-braces pin. The operator's list is the
// fallback, and it stands whether the registry answered "no" or could not be
// reached at all: a statement the operator made locally does not depend on a Git
// host being up.
//
// It is exported because this leg is meaningful without the hardware half: a
// caller that already holds a verified report — the offline demo, a test that
// cannot forge a vendor signature — still has to ask the same question, and
// asking it any other way would let the two paths, and their wording, drift.
func (v *Verifier) AdmitMeasurement(ctx context.Context, result *Result, evidence EvidenceType) bool {
	if result == nil {
		return false
	}
	if len(result.Measurement) == 0 {
		result.deny("no launch measurement was derived, so nothing can vouch for this root")
		return false
	}

	err := v.registry().Verify(ctx, result.Measurement, evidence)
	switch {
	case err == nil:
		result.MeasurementSource = SourceRegistry
		result.InRegistry = true
	case v.isPinned(result.Measurement):
		result.MeasurementSource = SourceOperatorPinned
	case errors.Is(err, ErrNotInRegistry):
		result.deny("measurement %s is not in the Super Protocol trusted registry, "+
			"and it is not listed in attestedRoots.trustedMeasurements", result.MeasurementHex())
		return false
	default:
		// Unknown is not the same as untrusted, but it cannot be admitted
		// either: an attacker who can cut off the registry must not thereby get
		// a root accepted. An operator who pinned this measurement never reaches
		// here.
		result.deny("the trusted registry could not be consulted: %v", err)
		return false
	}
	result.logf("measurement %s is vouched for by %s", result.MeasurementHex(), result.MeasurementSource)
	return true
}

// isPinned reports whether the operator listed this measurement.
func (v *Verifier) isPinned(mrEnclave []byte) bool {
	if len(mrEnclave) == 0 {
		return false
	}
	want := []byte(hex.EncodeToString(mrEnclave))
	for _, pin := range v.TrustedMeasurements {
		normalized, err := ParseMeasurement(pin)
		if err != nil {
			// A malformed pin is a configuration error the config layer already
			// rejects; here it simply matches nothing.
			continue
		}
		if subtle.ConstantTimeCompare([]byte(normalized), want) == 1 {
			return true
		}
	}
	return false
}
