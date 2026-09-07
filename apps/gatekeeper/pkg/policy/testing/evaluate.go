// Package testing evaluates a saved evidence bundle against a gatekeeper
// config, offline. It backs `gatekeeper policy test`.
//
// Without an [Options.Verify] function it runs in **policy-only** mode: the JWS
// payload is decoded without checking the signature, the chain is not validated
// and freshness is not enforced — there is no live TLS channel to bind to
// offline. In that mode it answers "would my policies admit this payload?", and
// nothing more; [Result.CryptoVerified] is false, every shortcut is listed in
// [Result.Warnings], and [Result.Admitted] — the answer to "would the gatekeeper
// let this through?" — is false no matter what the policies said. Callers must
// report `Admitted`, never `Decision.Allow` on its own.
//
// Passing a Verify function makes the run a real end-to-end check.
// [NewVerifier] builds the default one: pkg/attestation's pipeline, the same
// code the data plane runs. A bundle it rejects is never admitted, whatever the
// Rego policies say about the payload.
package testing

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/policy"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

// maxBundleSize caps how much of a bundle file is read.
const maxBundleSize = 8 << 20 // 8 MiB

// Verified is what a cryptographic verification of a bundle established.
type Verified struct {
	// Root is the trustedRoots[].name the chain terminated in.
	Root                   string
	RootFingerprint        trust.Digest
	ObservedTLSFingerprint trust.Digest
	VerifiedAt             time.Time
	QuoteFormat            string
	// Payload is the verified JWS payload.
	Payload map[string]any
	// Warnings names every guarantee this verification had to settle for — an
	// offline run has no handshake to bind to, for instance. They are merged
	// into [Result.Warnings], so a caller reports them without knowing which
	// verifier produced them.
	Warnings []string
}

// VerifyFunc runs the cryptographic pipeline (stages 1–6 of ADR-003 §1) over a
// bundle. It is the seam pkg/attestation plugs into.
type VerifyFunc func(ctx context.Context, bundleJSON []byte, hostname string) (*Verified, error)

// Options tunes one offline evaluation.
type Options struct {
	// Endpoint picks which endpoint's pins and name to evaluate against. Empty
	// means: the endpoint whose upstream hostname matches the bundle, or the
	// only configured endpoint.
	Endpoint string
	// Verify performs cryptographic verification. [NewVerifier] builds the
	// default adapter over pkg/attestation; when nil the run is policy-only and
	// nothing is ever admitted. See the package doc.
	Verify VerifyFunc
}

// Result is what `gatekeeper policy test` prints.
type Result struct {
	// Endpoint is the endpoint the bundle was evaluated as.
	Endpoint string
	// Admitted is the honest bottom line: the gatekeeper would let this bundle
	// through. It requires both cryptographic verification and a policy allow,
	// so a policy-only run is never admitted.
	Admitted bool
	// CryptoVerified reports whether the bundle actually passed the
	// cryptographic pipeline. False in policy-only mode.
	CryptoVerified bool
	// Decision is the policy layer's verdict alone.
	Decision policy.Decision
	// Input is the exact document the policies saw.
	Input map[string]any
	// TrustModule is the generated `gatekeeper.trust` source.
	TrustModule string
	// Warnings names every check this offline path skipped.
	Warnings []string
}

// bundle is the subset of the published bundle this package needs.
type bundle struct {
	Version         string   `json:"version"`
	Kind            string   `json:"kind"`
	Hostname        string   `json:"hostname"`
	CertFingerprint string   `json:"certFingerprint"`
	JWS             string   `json:"jws"`
	CertChain       []string `json:"certChain"`
	RootCaTeeQuote  *struct {
		Format string `json:"format"`
	} `json:"rootCaTeeQuote"`
}

// EvaluateFile loads a bundle and a config from disk and evaluates one against
// the other.
func EvaluateFile(ctx context.Context, bundlePath, configPath string, opts Options) (*Result, error) {
	raw, err := readLimited(bundlePath)
	if err != nil {
		return nil, err
	}
	// Editable: `policy test` answers "would my policies admit this bundle?"
	// offline, which is a question worth asking before the endpoint it is about
	// has been pinned. An unpinned endpoint is not an obstacle to evaluating
	// it — it is one of the answers.
	cfg, err := config.Load(config.Options{Path: configPath, Editable: true})
	if err != nil {
		return nil, err
	}
	return Evaluate(ctx, raw, cfg, opts)
}

// Evaluate runs the policy layer over an in-memory bundle.
func Evaluate(ctx context.Context, bundleJSON []byte, cfg *config.Config, opts Options) (*Result, error) {
	var b bundle
	if err := json.Unmarshal(bundleJSON, &b); err != nil {
		return nil, fmt.Errorf("bundle is not valid JSON: %w", err)
	}
	if b.Kind != "" && b.Kind != "DeploymentEvidence" {
		return nil, fmt.Errorf("bundle kind %q is not admissible; endpoints publish DeploymentEvidence", b.Kind)
	}

	store, err := trust.New(cfg)
	if err != nil {
		return nil, err
	}
	endpoint, err := pickEndpoint(store, b.Hostname, opts.Endpoint)
	if err != nil {
		return nil, err
	}

	var (
		verified *Verified
		warnings []string
	)
	if opts.Verify != nil {
		if verified, err = opts.Verify(ctx, bundleJSON, endpoint.Hostname); err != nil {
			return nil, err
		}
		if verified != nil {
			warnings = verified.Warnings
		}
	} else if verified, warnings, err = decodeUnverified(&b, store); err != nil {
		return nil, err
	}
	if verified == nil {
		return nil, errors.New("the verifier returned neither a result nor an error")
	}

	input, err := policy.BuildInput(policy.InputSource{
		Endpoint:               endpoint.Name,
		UpstreamHostname:       endpoint.Hostname,
		UpstreamPort:           endpoint.Port,
		Root:                   verified.Root,
		RootFingerprint:        verified.RootFingerprint,
		ObservedTLSFingerprint: verified.ObservedTLSFingerprint,
		VerifiedAt:             verified.VerifiedAt,
		QuoteFormat:            verified.QuoteFormat,
		Payload:                verified.Payload,
	})
	if err != nil {
		return nil, err
	}

	modules, err := policy.LoadModules(cfg)
	if err != nil {
		return nil, err
	}
	engine, err := policy.New(ctx, policy.Options{Store: store, Modules: modules})
	if err != nil {
		return nil, err
	}

	decision := engine.Evaluate(ctx, input)
	cryptoVerified := opts.Verify != nil
	return &Result{
		Endpoint:       endpoint.Name,
		Admitted:       cryptoVerified && decision.Allow,
		CryptoVerified: cryptoVerified,
		Decision:       decision,
		Input:          input,
		TrustModule:    engine.TrustModule(),
		Warnings:       warnings,
	}, nil
}

// decodeUnverified is the policy-only path: it reads the payload out of the
// bundle without checking anything, and reports each shortcut it took.
func decodeUnverified(b *bundle, store *trust.Store) (*Verified, []string, error) {
	payload, err := decodeJWSPayload(b.JWS)
	if err != nil {
		return nil, nil, err
	}

	warnings := []string{
		"POLICY-ONLY RUN: the JWS signature, the certificate chain and the bundle's freshness were NOT checked, " +
			"so a policy allow here does not mean the gatekeeper would admit this endpoint",
	}
	rootName, rootFingerprint := matchRoot(store, b.CertChain, &warnings)

	// Offline there is no handshake to observe, so the bundle's own assertion
	// stands in for the channel binding. The data plane never does this.
	observed, err := trust.ParseDigest(firstNonEmpty(b.CertFingerprint, stringField(payload, "certFingerprint")))
	if err != nil {
		return nil, nil, fmt.Errorf("bundle certFingerprint: %w", err)
	}
	warnings = append(warnings, "channel binding used the bundle's own certFingerprint, not an observed TLS leaf")

	quoteFormat := ""
	if b.RootCaTeeQuote != nil {
		quoteFormat = b.RootCaTeeQuote.Format
	}

	return &Verified{
		Root:                   rootName,
		RootFingerprint:        rootFingerprint,
		ObservedTLSFingerprint: observed,
		QuoteFormat:            quoteFormat,
		Payload:                payload,
	}, warnings, nil
}

func pickEndpoint(store *trust.Store, hostname, wanted string) (trust.Endpoint, error) {
	endpoints := store.Endpoints()
	if wanted != "" {
		ep, ok := store.Endpoint(wanted)
		if !ok {
			return trust.Endpoint{}, fmt.Errorf("no endpoint named %q; configured: %s", wanted, names(endpoints))
		}
		return ep, nil
	}
	for _, ep := range endpoints {
		if hostname != "" && ep.Hostname == hostname {
			return ep, nil
		}
	}
	if len(endpoints) == 1 {
		return endpoints[0], nil
	}
	return trust.Endpoint{}, fmt.Errorf(
		"no endpoint has upstream hostname %q; pass --endpoint (configured: %s)", hostname, names(endpoints))
}

// matchRoot fingerprints the chain terminus and looks it up among the trusted
// roots. This is a name lookup, not a validation: nothing here proves the chain
// is well formed or that the leaf signed the payload.
func matchRoot(store *trust.Store, chain []string, warnings *[]string) (string, trust.Digest) {
	if len(chain) == 0 {
		*warnings = append(*warnings, "the bundle carries no certificate chain; input.attestation.root is empty")
		return "", ""
	}
	fingerprint, err := trust.FingerprintPEM([]byte(chain[len(chain)-1]))
	if err != nil {
		*warnings = append(*warnings, "the last certificate of the chain could not be parsed: "+err.Error())
		return "", ""
	}
	root, ok := store.RootByFingerprint(fingerprint)
	if !ok {
		*warnings = append(*warnings,
			"the chain terminates in "+fingerprint.Display()+", which is not a trusted root")
		return "", fingerprint
	}
	return root.Name, fingerprint
}

func decodeJWSPayload(compact string) (map[string]any, error) {
	parts := strings.Split(compact, ".")
	if len(parts) != 3 {
		return nil, errors.New("bundle jws is not a compact JWS (expected three dot-separated segments)")
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil, fmt.Errorf("bundle jws payload is not base64url: %w", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(decoded, &payload); err != nil {
		return nil, fmt.Errorf("bundle jws payload is not a JSON object: %w", err)
	}
	return payload, nil
}

func readLimited(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxBundleSize {
		return nil, fmt.Errorf("%s: bundle is larger than %d bytes", path, maxBundleSize)
	}
	return os.ReadFile(path) //nolint:gosec // operator-supplied path by design
}

func names(endpoints []trust.Endpoint) string {
	out := make([]string, 0, len(endpoints))
	for _, ep := range endpoints {
		out = append(out, ep.Name)
	}
	return strings.Join(out, ", ")
}

func stringField(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return value
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
