package attestation

import (
	"bytes"
	"encoding/pem"
	"fmt"
	"time"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/internal/certparse"
)

// maxPoolCertificates bounds how many certificates a producer may put in one
// PEM file. Chain building is quadratic in the pool size, and a membership
// chain that needs more than this is not one the platform issues; the bound's
// only job is to keep an attacker-supplied file from sizing the work done
// before it can be rejected.
const maxPoolCertificates = 64

// maxChainPaths and maxChainDepth bound the search for one certificate's
// chain. Without them a pool whose certificates all name each other as issuer
// — which costs an attacker nothing to build, since a subject name is not
// authenticated until a signature is checked — would make the walk
// combinatorial, and the verifier would spend that work before it could
// reject anything. A real membership chain is three or four certificates
// deep and has exactly one path.
const (
	maxChainPaths = 32
	maxChainDepth = 12
)

// CertPool is a bag of certificates with no order of its own: the composite
// form's `swarm-pki-membership` element is a PEM file, and the signatures that
// have to be checked against it — the node's and the leader's — do not share a
// single chain. [CertPool.ChainTo] derives the chain for one of them.
//
// It is deliberately not crypto/x509.CertPool: the platform issues secp256k1
// CAs, which crypto/x509 cannot parse at all, and the whole point of
// [ValidateChain] is that it does not build a path against a system pool.
type CertPool struct {
	certs []*certparse.Certificate
	pems  []string
}

// ParseCertPool reads every CERTIFICATE block of a PEM file, in file order.
//
// A block that is not a certificate is an error rather than something to skip:
// the element is declared `application/x-pem-file` and carries exactly the
// chain material, so anything else in it means the producer and this verifier
// disagree about what was sent.
func ParseCertPool(pemBytes []byte) (*CertPool, error) {
	pool := &CertPool{}
	rest := pemBytes
	for {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			break
		}
		if block.Type != "CERTIFICATE" {
			return nil, chainErrf("PEM file carries a %q block, expected only CERTIFICATE", block.Type)
		}
		if len(pool.certs) == maxPoolCertificates {
			return nil, chainErrf("PEM file carries more than %d certificates", maxPoolCertificates)
		}
		encoded := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: block.Bytes}))
		cert, err := certparse.ParsePEM(encoded)
		if err != nil {
			return nil, chainErrf("failed to parse certificate at index %d: %v", len(pool.certs), err)
		}
		pool.certs = append(pool.certs, cert)
		pool.pems = append(pool.pems, encoded)
	}
	if len(pool.certs) == 0 {
		return nil, chainErrf("PEM file carries no certificate")
	}
	return pool, nil
}

// Len is how many certificates the pool holds.
func (p *CertPool) Len() int { return len(p.certs) }

// PEMAt is the PEM of the certificate at index i, re-encoded from its DER so
// that whitespace and headers in the input cannot change what is hashed.
func (p *CertPool) PEMAt(i int) string { return p.pems[i] }

// FingerprintAt is the `sha256/<base64url>` digest of the certificate at index i.
func (p *CertPool) FingerprintAt(i int) string { return SHA256Fingerprint(p.certs[i].Raw) }

// IndexOfFingerprint finds the certificate a `sha256/<base64url>` digest names,
// or -1. It is how an object that names its own signer — a NodeRequestEnvelope
// naming `node_cert_fingerprint` — is matched to a certificate in the pool.
func (p *CertPool) IndexOfFingerprint(fingerprint string) int {
	for i := range p.certs {
		if SHA256Fingerprint(p.certs[i].Raw) == fingerprint {
			return i
		}
	}
	return -1
}

// ChainTo orders the pool into the chain from the certificate at index i up to
// a self-signed root, and validates it with [ValidateChain].
//
// Issuers are followed by subject name, and a name that appears twice is tried
// in file order until one of the resulting chains validates: the pool may hold
// two roots of the same cloud — a swarm PKI has a `basic` and a `lite` root —
// and picking the wrong namesake must not fail a chain that exists. The search
// is bounded by [maxChainPaths] and [maxChainDepth]; subject names are
// unauthenticated until a signature is checked, so the walk they drive must
// not be allowed to grow with what a producer wrote.
func (p *CertPool) ChainTo(i int, now time.Time) (*ParsedChain, error) {
	if i < 0 || i >= len(p.certs) {
		return nil, chainErrf("no certificate at index %d in a pool of %d", i, len(p.certs))
	}
	var lastErr error
	for _, path := range p.pathsFrom(i) {
		pems := make([]string, 0, len(path))
		for _, index := range path {
			pems = append(pems, p.pems[index])
		}
		chain, err := ValidateChain(pems, now)
		if err == nil {
			return chain, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = chainErrf(
			"certificate %q has no issuer in the PEM file and is not self-signed", p.certs[i].Subject)
	}
	return nil, lastErr
}

// pathsFrom enumerates the leaf→root orderings the pool admits for one
// certificate, depth-first in file order and without revisiting a certificate,
// so a cycle of mutually-issuing certificates terminates instead of looping.
func (p *CertPool) pathsFrom(leaf int) [][]int {
	var out [][]int
	var walk func(path []int)
	walk = func(path []int) {
		if len(out) >= maxChainPaths || len(path) > maxChainDepth {
			return
		}
		current := p.certs[path[len(path)-1]]
		if bytes.Equal(current.RawIssuer, current.RawSubject) {
			out = append(out, append([]int(nil), path...))
			return
		}
		for next := range p.certs {
			if bytes.Equal(p.certs[next].RawSubject, current.RawIssuer) && !contains(path, next) {
				walk(append(path, next))
			}
		}
	}
	walk([]int{leaf})
	return out
}

func contains(path []int, value int) bool {
	for _, element := range path {
		if element == value {
			return true
		}
	}
	return false
}

// VerifyCompactJWS verifies a compact JWS under the chain's leaf key and
// returns the payload octets it covers.
//
// It is the signature half of [verifyJWS] without its payload shape test: the
// composite form's statement and request envelope are signed the same way as
// the published bundle and carry entirely different bodies, and a verifier
// that insisted on one shape could not read the other.
func VerifyCompactJWS(jws string, chain *ParsedChain) ([]byte, error) {
	if chain == nil || len(chain.certs) == 0 {
		return nil, fmt.Errorf("no certificate chain to verify the JWS against")
	}
	return verifyCompactJWS(jws, chain.leaf())
}
