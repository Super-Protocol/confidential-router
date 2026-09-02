// Package attestedroot decides whether a certificate authority is one of Super
// Protocol's, by checking the hardware attestation the CA enrolled with.
//
// It is the gatekeeper's second trust anchor. The first — the manual
// `trustedRoots[]` list — answers "did the user say they trust this cloud?".
// This one answers "is this cloud a Super Swarm cloud at all?", and it answers
// it the way the platform's own clients do (`tee-pki`'s
// root-certificate-verifier and the browser extension's panel):
//
//  1. read the TEE evidence the root certificate carries in its extensions;
//  2. verify the hardware report against the CPU vendor's built-in root;
//  3. require the report's reportData to commit to the certificate's own public
//     key, so the attestation is about this CA and not merely about a VM;
//  4. rebuild the VM's launch measurement from published build artefacts,
//     require it to reproduce the report's own measurement, and normalise it to
//     the vCPU-independent `mrEnclave` of sp-vm/docs/04-vm-measurements.md;
//  5. require Super Protocol to have signed that measurement, checked against a
//     public key pinned in this binary.
//
// Step 5 is what makes the chain closed: without it the check would prove that
// *some* SEV-SNP VM issued the certificate, which any tenant of any AMD host
// could arrange.
//
// The whole path fails closed. A registry that cannot be reached, artefacts
// that cannot be fetched, an unsupported evidence type — all deny, and the
// manual trust store keeps working offline, which is the escape hatch.
package attestedroot

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"sync"
	"time"

	sevtrust "github.com/google/go-sev-guest/verify/trust"
	tdxtrust "github.com/google/go-tdx-guest/verify/trust"
)

// DefaultCacheTTL is how long a verdict about one root is reused. Attesting a
// root costs a firmware download and a registry round trip, and the answer only
// changes when the registry does, so re-deriving it on every re-attestation
// would be pure cost. It matches the ten minutes the browser extension caches.
const DefaultCacheTTL = 10 * time.Minute

// Verifier answers whether a root certificate is a TEE-attested Super Swarm
// root. It is safe for concurrent use and caches verdicts by certificate.
type Verifier struct {
	// Registry decides whether Super Protocol vouches for a measurement.
	// Defaults to [HTTPRegistry] against [DefaultRegistryBaseURL].
	Registry Registry
	// Artifacts resolves sp-vm builds to the firmware a SEV-SNP measurement is
	// rebuilt from. Defaults to [HTTPArtifactSource].
	Artifacts ArtifactSource
	// CacheTTL overrides [DefaultCacheTTL]; a negative value disables caching.
	CacheTTL time.Duration
	// CheckRevocations additionally consults the vendor CRLs. It needs the
	// network and is reported separately from report integrity.
	CheckRevocations bool
	// HTTPGetter and TdxGetter override how vendor collateral is fetched.
	HTTPGetter sevtrust.HTTPSGetter
	TdxGetter  tdxtrust.HTTPSGetter
	// Now overrides the clock, for tests and for verifying against a fixed date.
	Now func() time.Time

	mu    sync.Mutex
	cache map[string]cacheEntry
}

type cacheEntry struct {
	result  *Result
	expires time.Time
}

func (v *Verifier) clock() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

func (v *Verifier) registry() Registry {
	if v.Registry != nil {
		return v.Registry
	}
	return &HTTPRegistry{}
}

func (v *Verifier) artifacts() ArtifactSource {
	if v.Artifacts != nil {
		return v.Artifacts
	}
	return &HTTPArtifactSource{}
}

// Verify checks one root certificate.
//
// It never returns an error for a root that simply is not attested: that is a
// [Result] with Attested false and a Reason, because the caller has to render
// it next to the manual-store verdict either way. An error is reserved for a
// caller mistake, such as passing no certificate.
func (v *Verifier) Verify(ctx context.Context, cert *x509.Certificate) (*Result, error) {
	if cert == nil {
		return nil, errors.New("attestedroot: no certificate to verify")
	}

	key := string(cert.Raw)
	if cached, ok := v.cached(key); ok {
		return cached, nil
	}
	result := v.verify(ctx, cert)
	v.store(key, result)
	return result, nil
}

func (v *Verifier) verify(ctx context.Context, cert *x509.Certificate) *Result {
	out := &Result{}

	ext, err := ReadRootExtensions(cert)
	if err != nil {
		return out.deny("%v", err)
	}
	out.NetworkType = ext.NetworkType
	if !ext.HasEvidence() {
		return out.deny("the root certificate carries no TEE evidence extension (%s)", oidTeeEvidence)
	}
	out.logf("root certificate carries TEE evidence (%d bytes), network type %q",
		len(ext.Evidence), orUnset(string(ext.NetworkType)))

	evidence, err := ParseEvidence(ext.Evidence)
	if err != nil {
		return out.deny("%v", err)
	}
	out.EvidenceType = evidence.Type
	out.EvidenceTypeName = evidence.Type.String()
	out.logf("evidence type %s", out.EvidenceTypeName)

	switch {
	case evidence.SevSnp != nil:
		err = v.verifySevSnp(ctx, evidence.SevSnp, ext, out)
	case evidence.Tdx != nil:
		err = v.verifyTdx(evidence.Tdx, ext, out)
	default:
		err = fmt.Errorf("evidence type %s is not supported by this build", evidence.Type)
	}
	if err != nil {
		return out.deny("%v", err)
	}
	out.logf("hardware report verified; measurement %s", out.MeasurementHex())
	out.logf("certificate public key SHA-256 %s matches the report data", out.SPKIDigestHex())

	switch err := v.registry().Verify(ctx, out.Measurement, evidence.Type); {
	case err == nil:
		out.InRegistry = true
	case errors.Is(err, ErrNotInRegistry):
		return out.deny("measurement %s is not in the Super Protocol trusted registry", out.MeasurementHex())
	default:
		// Unknown is not the same as untrusted, but it cannot be admitted
		// either: an attacker who can cut off the registry must not thereby get
		// a root accepted.
		return out.deny("the trusted registry could not be consulted: %v", err)
	}
	out.logf("measurement %s is in the trusted registry", out.MeasurementHex())

	out.Attested = true
	return out
}

func (r *Result) deny(format string, args ...any) *Result {
	r.Attested = false
	r.Reason = fmt.Sprintf(format, args...)
	r.logf("denied: %s", r.Reason)
	return r
}

func (v *Verifier) cached(key string) (*Result, bool) {
	if v.CacheTTL < 0 {
		return nil, false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	entry, ok := v.cache[key]
	if !ok || v.clock().After(entry.expires) {
		return nil, false
	}
	return entry.result, true
}

func (v *Verifier) store(key string, result *Result) {
	if v.CacheTTL < 0 {
		return
	}
	ttl := v.CacheTTL
	if ttl == 0 {
		ttl = DefaultCacheTTL
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.cache == nil {
		v.cache = map[string]cacheEntry{}
	}
	v.cache[key] = cacheEntry{result: result, expires: v.clock().Add(ttl)}
}

func orUnset(s string) string {
	if s == "" {
		return "(not declared)"
	}
	return s
}
