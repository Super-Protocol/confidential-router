// Package attestedroot is the gatekeeper's view of the second trust anchor:
// whether a certificate authority is a Super Swarm one at all, decided from the
// hardware attestation the CA enrolled with.
//
// The check itself lives in
// github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot
// (SUP-647). As in the parent package, an alias is added here when a gatekeeper
// package needs one; this is not a mirror of the module's surface.
package attestedroot

import (
	core "github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// The evidence types a root certificate can carry, as the platform's
// TeeEvidence.proto numbers them.
const (
	EvidenceSevSnpQemu  = core.EvidenceSevSnpQemu
	EvidenceTdxQemu     = core.EvidenceTdxQemu
	EvidenceTdxGCP      = core.EvidenceTdxGCP
	EvidenceTdxAzure    = core.EvidenceTdxAzure
	EvidenceSevSnpAzure = core.EvidenceSevSnpAzure
)

// The two Super Protocol network types a root may declare.
const (
	NetworkTrusted   = core.NetworkTrusted
	NetworkUntrusted = core.NetworkUntrusted
)

// What vouched for a VM measurement: Super Protocol's signed registry, or the
// operator's own pin.
const (
	SourceRegistry       = core.SourceRegistry
	SourceOperatorPinned = core.SourceOperatorPinned
)

// ErrNotInRegistry is what a lookup returns when the registry answered, and the
// answer was that it holds no signature for this measurement.
var ErrNotInRegistry = core.ErrNotInRegistry

// The anchor's types, as the gatekeeper refers to them.
type (
	// EvidenceType is the kind of hardware evidence a root certificate carries.
	EvidenceType = core.EvidenceType
	// NetworkType is which Super Protocol network a root belongs to.
	NetworkType = core.NetworkType
	// MeasurementSource names what vouched for a VM measurement.
	MeasurementSource = core.MeasurementSource
	// SecurityFields are the report fields that describe how the VM was
	// allowed to run.
	SecurityFields = core.SecurityFields
	// Result is everything one attested-root check learned.
	Result = core.Result
	// Verifier answers whether a root certificate is a TEE-attested Super
	// Swarm root.
	Verifier = core.Verifier
	// Registry answers whether Super Protocol vouches for a measurement.
	Registry = core.Registry
	// HTTPRegistry is the real registry.
	HTTPRegistry = core.HTTPRegistry
	// HTTPArtifactSource resolves sp-vm builds to the firmware a SEV-SNP
	// measurement is rebuilt from.
	HTTPArtifactSource = core.HTTPArtifactSource
)

// ParseMeasurement normalises the hex spelling of a VM measurement.
func ParseMeasurement(s string) (string, error) { return core.ParseMeasurement(s) }
