package attestedroot

import (
	"encoding/hex"
	"fmt"
	"strings"
)

// SecurityFields are the report fields that describe how the VM was allowed to
// run. The gatekeeper surfaces them and never judges them: whether, say,
// ciphertext hiding being off disqualifies a cloud is a decision for the
// operator's Rego, and hard-coding it here would make the verdict unarguable.
type SecurityFields struct {
	// VMPL is the privilege level the report was produced at; 0 is highest.
	VMPL uint32 `json:"vmpl"`
	// DebugAllowed means the host may decrypt the guest. It is the one field
	// whose bad value nobody sensibly tolerates.
	DebugAllowed bool `json:"debugAllowed"`
	// CiphertextHiding and PageSwapDisabled are hardening options the guest
	// policy may or may not require.
	CiphertextHiding bool `json:"ciphertextHiding"`
	PageSwapDisabled bool `json:"pageSwapDisabled"`
	// SnpFirmwareTCB is the SNP firmware security-version number from the
	// launch TCB.
	SnpFirmwareTCB uint8 `json:"snpFirmwareTcb"`
	// ReportVersion is the attestation report format version.
	ReportVersion uint32 `json:"reportVersion"`
}

// Result is everything one attested-root check learned. It is populated as far
// as the check got, so a failed verdict still carries the evidence that
// explains it — a report whose measurement is sound but absent from the
// registry reads very differently from one whose signature is wrong.
type Result struct {
	// Attested is the verdict: true only when every step passed and the
	// measurement is in the trusted registry.
	Attested bool `json:"attested"`
	// Reason explains a false Attested.
	Reason string `json:"reason,omitempty"`

	// EvidenceType is the hardware the root enrolled from.
	EvidenceType EvidenceType `json:"-"`
	// EvidenceTypeName is [EvidenceType] as the platform's UI labels it.
	EvidenceTypeName string `json:"evidenceType,omitempty"`
	// NetworkType is what the certificate says about its own network. The live
	// Swarm stand's root says "untrusted"; that is reported, not enforced.
	NetworkType NetworkType `json:"networkType,omitempty"`

	// ReportIntegrity is true once the hardware report's signature and its
	// chain to a built-in vendor root have been checked.
	ReportIntegrity bool `json:"reportIntegrity"`
	// RevocationChecked and NotRevoked describe the optional CRL check.
	// RevocationChecked false means it was not asked for or could not be run —
	// never that the chain is clean.
	RevocationChecked bool `json:"revocationChecked"`
	NotRevoked        bool `json:"notRevoked,omitempty"`
	// CPUGeneration is the vendor CPU line the verified chain belongs to.
	CPUGeneration string `json:"cpuGeneration,omitempty"`

	// KeyBinding is whether the report's reportData commits to the root
	// certificate's public key. Without it the attestation is about some VM,
	// not about this CA.
	KeyBinding bool `json:"keyBinding"`
	// ReportData is the raw 64-byte field, for an operator comparing by eye.
	ReportData []byte `json:"-"`

	// SecurityFields are the report's policy and TCB fields.
	SecurityFields SecurityFields `json:"security"`

	// Measurement is the normalised 32-byte mrEnclave, empty when it could not
	// be derived.
	Measurement []byte `json:"-"`
	// InRegistry is whether Super Protocol signed this measurement.
	InRegistry bool `json:"inRegistry"`

	// Logs are the steps that ran, in order, so a denial can be read without
	// re-running the check with a debugger attached.
	Logs []string `json:"logs,omitempty"`
}

// MeasurementHex renders the normalised measurement the way the registry names
// it, empty when there is none.
func (r *Result) MeasurementHex() string {
	if r == nil || len(r.Measurement) == 0 {
		return ""
	}
	return hex.EncodeToString(r.Measurement)
}

// SPKIDigestHex renders the certificate key digest the report should commit to.
func (r *Result) SPKIDigestHex() string {
	if r == nil || len(r.ReportData) < 32 {
		return ""
	}
	return hex.EncodeToString(r.ReportData[:32])
}

// Label is the short form a verdict line uses: the measurement when there is
// one, the failure otherwise.
func (r *Result) Label() string {
	switch {
	case r == nil:
		return ""
	case r.Attested:
		return "attested (" + r.MeasurementHex() + ")"
	case r.Reason != "":
		return "not attested: " + r.Reason
	default:
		return "not attested"
	}
}

// RevocationLabel renders the optional CRL check for a report.
func (r *Result) RevocationLabel() string {
	switch {
	case r == nil || !r.RevocationChecked:
		return "not checked"
	case r.NotRevoked:
		return "ok"
	default:
		return "REVOKED or indeterminate"
	}
}

// logf records one step of the check. The lines are what `gatekeeper verify`
// prints under "Verification logs", so they are written for a reader who has
// only the output.
func (r *Result) logf(format string, args ...any) {
	r.Logs = append(r.Logs, strings.TrimSpace(fmt.Sprintf(format, args...)))
}
