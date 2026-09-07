// Package status is the vocabulary the user-facing halves of the gatekeeper
// share: what an endpoint's live state looks like, and what a verification of
// one produced.
//
// It exists so that the CLI (`gatekeeper status`, `gatekeeper verify`) and the
// TUI dashboard are written against one model rather than against the data
// plane's internals. Two seams are declared here and implemented elsewhere:
//
//   - [Verifier] — one-shot attestation + policy evaluation of a live host.
//     pkg/attestation (SUP-68) plus pkg/policy supply it.
//   - [Supervisor] — the running proxy's status and control API: which
//     listeners are up, what each endpoint's last verdict was, start/stop and
//     re-attest. The data plane (SUP-71) supplies it.
//
// Nothing in this package talks to the network. [Demo] implements both seams
// from a config alone, which is what makes the dashboard reviewable — and
// testable — before the data plane exists.
package status

import (
	"context"
	"errors"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// ErrUnavailable is what a seam returns when this build has no implementation
// of it wired in. Commands turn it into an explanation rather than a stack
// trace, and exit with [ExitUnavailable].
var ErrUnavailable = errors.New("not available in this build")

// Health is an endpoint's traffic-light state, as the dashboard paints it.
type Health string

// The states an endpoint can be in. They are deliberately about what a user
// sees at the listener, not about the verifier's internal stages.
const (
	// Unknown is a configured endpoint nothing has looked at yet.
	Unknown Health = "unknown"
	// Stopped is a configured endpoint whose listener is not running.
	Stopped Health = "stopped"
	// Attesting is a running endpoint still working towards its first verdict.
	Attesting Health = "attesting"
	// Confidential is the good state: verified, admitted, proxying.
	Confidential Health = "confidential"
	// NonConfidential is a `failMode: open` endpoint proxying without a valid
	// verdict. Traffic flows; the confidentiality claim does not hold.
	NonConfidential Health = "non-confidential"
	// Broken is a `failMode: closed` endpoint refusing traffic, or a listener
	// that could not be bound.
	Broken Health = "broken"
)

// Label renders the state for a table cell.
func (h Health) Label() string {
	if h == "" {
		return string(Unknown)
	}
	return string(h)
}

// Serving reports whether client traffic reaches the upstream in this state.
func (h Health) Serving() bool { return h == Confidential || h == NonConfidential }

// Trusted reports whether traffic in this state is covered by a verdict. It is
// the distinction `failMode: open` blurs and the dashboard must not.
func (h Health) Trusted() bool { return h == Confidential }

// Certificate is one entry of a verified chain, reduced to what a human reads.
type Certificate struct {
	Subject     string    `json:"subject"`
	Issuer      string    `json:"issuer"`
	Fingerprint string    `json:"fingerprint"`
	NotBefore   time.Time `json:"notBefore"`
	NotAfter    time.Time `json:"notAfter"`
	// Root marks the chain terminus — the certificate matched against the
	// trusted-root list.
	Root bool `json:"root"`
}

// PolicyResult is one Rego package's contribution to the verdict; it mirrors
// policy.PackageDecision without importing it, so a caller can render a report
// without pulling OPA in.
type PolicyResult struct {
	Package string `json:"package"`
	// Policy is policies[].name, empty for the built-in pin policy.
	Policy string `json:"policy,omitempty"`
	Allow  bool   `json:"allow"`
	Error  string `json:"error,omitempty"`
}

// AttestedRoot is what the chain's terminal certificate authority proved about
// itself, when the gatekeeper checked its TEE evidence rather than looking it
// up in the user's list. It mirrors attestation/attestedroot.Result without
// importing it, so a report can be rendered without pulling in a verifier.
//
// Every field is reported even for a root that was rejected: "the report is
// sound but the measurement is not one of Super Protocol's" and "the report is
// forged" are different problems, and an operator has to be able to tell them
// apart from the output alone.
type AttestedRoot struct {
	// Attested is the verdict; Reason explains a false one.
	Attested bool   `json:"attested"`
	Reason   string `json:"reason,omitempty"`

	// EvidenceType is the hardware the CA enrolled from, as the platform's own
	// UI labels it, and NetworkType is the network the certificate declares.
	EvidenceType string `json:"evidenceType,omitempty"`
	NetworkType  string `json:"networkType,omitempty"`

	// ReportIntegrity covers the hardware report's signature and its chain to
	// the CPU vendor's root. Revocation is separate and network-dependent:
	// RevocationChecked false means it was not run, never that it was clean.
	ReportIntegrity   bool   `json:"reportIntegrity"`
	RevocationChecked bool   `json:"revocationChecked"`
	NotRevoked        bool   `json:"notRevoked,omitempty"`
	CPUGeneration     string `json:"cpuGeneration,omitempty"`

	// KeyBinding is whether the report commits to this certificate's public
	// key, and KeyDigest is the SHA-256 of that key as the report carries it.
	KeyBinding bool   `json:"keyBinding"`
	KeyDigest  string `json:"keyDigest,omitempty"`

	// Measurement is the normalised mrEnclave in hex, and InRegistry whether
	// Super Protocol has signed it.
	Measurement string `json:"measurement,omitempty"`
	InRegistry  bool   `json:"inRegistry"`

	// TEE flags a policy may want to police. Named after the report fields
	// rather than after any judgement about them.
	VMPL             uint32 `json:"vmpl"`
	DebugAllowed     bool   `json:"debugAllowed"`
	CiphertextHiding bool   `json:"ciphertextHiding"`
	PageSwapDisabled bool   `json:"pageSwapDisabled"`
	SnpFirmwareTCB   uint8  `json:"snpFirmwareTcb,omitempty"`
	ReportVersion    uint32 `json:"reportVersion,omitempty"`

	// Logs are the steps the check ran, in order.
	Logs []string `json:"logs,omitempty"`
}

// RevocationLabel renders the optional vendor-CRL check for a report.
func (a *AttestedRoot) RevocationLabel() string {
	switch {
	case a == nil || !a.RevocationChecked:
		return "not checked"
	case a.NotRevoked:
		return "ok"
	default:
		return "REVOKED or indeterminate"
	}
}

// Report is one verification of one endpoint: the pretty report `gatekeeper
// verify` prints and the TUI detail pane shows.
//
// Verified and Admitted are separate on purpose. Verified covers stages 1–6 —
// the cryptography. Admitted additionally requires every policy package to
// allow, and is the only field that answers "would traffic have gone through?".
type Report struct {
	Endpoint  string    `json:"endpoint,omitempty"`
	Hostname  string    `json:"hostname"`
	Port      int       `json:"port,omitempty"`
	CheckedAt time.Time `json:"checkedAt"`

	Verified bool `json:"verified"`
	Admitted bool `json:"admitted"`
	// Stage and Reason describe the failure, and are empty on success. Stage is
	// one of the ADR-003 §1 names: fetch, cert-chain, untrusted-root, jws,
	// tls-fingerprint, policy.
	Stage  string `json:"stage,omitempty"`
	Reason string `json:"reason,omitempty"`

	// Root is the trustedRoots[] entry the chain terminated in, or the name the
	// attested-root anchor gives it; empty when the chain terminated somewhere
	// untrusted.
	Root            string `json:"root,omitempty"`
	RootFingerprint string `json:"rootFingerprint,omitempty"`
	// RootAttested marks a root that was accepted on its own TEE evidence
	// rather than because the user listed it. The manual list wins when both
	// apply, so this is false for a root that is also pinned.
	RootAttested bool `json:"rootAttested,omitempty"`
	// AttestedRoot is the evidence behind that decision, populated whenever the
	// check ran — including when it denied.
	AttestedRoot *AttestedRoot `json:"attestedRoot,omitempty"`
	// ObservedTLSFingerprint is the leaf the gatekeeper saw on its own
	// handshake; CertFingerprint is what the signed payload claims. The
	// verifier admits only bundles where the two agree.
	ObservedTLSFingerprint string        `json:"observedTlsFingerprint,omitempty"`
	CertFingerprint        string        `json:"certFingerprint,omitempty"`
	Chain                  []Certificate `json:"chain,omitempty"`

	Kind     string    `json:"kind,omitempty"`
	IssuedAt time.Time `json:"issuedAt,omitzero"`
	// EvidenceDigest is the canonical digest of the deployment snapshot — the
	// value users pin.
	EvidenceDigest string `json:"evidenceDigest,omitempty"`
	// Pinned reports whether EvidenceDigest is in the endpoint's
	// trustedEvidence list.
	Pinned bool `json:"pinned"`
	// Images are the container images named anywhere in the snapshot.
	Images []string `json:"images,omitempty"`
	// QuoteFormat is rootCaTeeQuote.format when the bundle carried a quote. The
	// quote is displayed, never validated (ADR-003 §2).
	QuoteFormat string `json:"quoteFormat,omitempty"`

	Policies []PolicyResult `json:"policies,omitempty"`
	// Warnings names checks that were skipped, e.g. an offline policy-only run.
	Warnings []string `json:"warnings,omitempty"`

	// UntrustedRoot is the fingerprint the chain terminated in when that root
	// is not in the trust store, and UntrustedRootPEM is the certificate
	// itself. They are what the dashboard's "add this root" key needs, and they
	// are populated on a *failed* report — which is the only time the question
	// arises.
	UntrustedRoot    string `json:"untrustedRoot,omitempty"`
	UntrustedRootPEM string `json:"untrustedRootPem,omitempty"`
}

// Denied returns the one-line reason a report is not admitted, or "" when it is.
func (r *Report) Denied() string {
	if r == nil {
		return "no verification has been made"
	}
	if r.Admitted {
		return ""
	}
	if r.Reason != "" {
		if r.Stage != "" {
			return r.Stage + ": " + r.Reason
		}
		return r.Reason
	}
	for _, p := range r.Policies {
		if p.Allow {
			continue
		}
		who := "the built-in pin policy (" + p.Package + ")"
		if p.Policy != "" {
			who = "policy " + p.Policy + " (" + p.Package + ")"
		}
		if p.Error != "" {
			return who + " failed to evaluate: " + p.Error
		}
		return who + " denied"
	}
	return "denied"
}

// Endpoint is one endpoint's live state.
type Endpoint struct {
	Name     string `json:"name"`
	Listen   string `json:"listen"`
	Upstream string `json:"upstream"`
	FailMode string `json:"failMode"`

	Health Health `json:"health"`
	// Reason explains a state that is not Confidential.
	Reason string `json:"reason,omitempty"`

	LastAttestAt time.Time `json:"lastAttestAt,omitzero"`
	NextAttestAt time.Time `json:"nextAttestAt,omitzero"`

	RequestsPerSecond float64 `json:"requestsPerSecond"`
	BytesIn           int64   `json:"bytesIn"`
	BytesOut          int64   `json:"bytesOut"`

	// Report is the last verification, nil before the first one completes.
	Report *Report `json:"report,omitempty"`
	// PublishedDigest is the evidenceDigest the upstream publishes right now,
	// pinned or not. It is what the dashboard's "Trust this deployment" pins,
	// and it is populated even for a denied endpoint — that is the whole point
	// of the key.
	PublishedDigest string `json:"publishedDigest,omitempty"`
}

// Snapshot is every endpoint's state at one instant.
type Snapshot struct {
	At        time.Time  `json:"at"`
	Endpoints []Endpoint `json:"endpoints"`
}

// Endpoint returns one endpoint by name.
func (s Snapshot) Endpoint(name string) (Endpoint, bool) {
	for _, ep := range s.Endpoints {
		if ep.Name == name {
			return ep, true
		}
	}
	return Endpoint{}, false
}

// LogLine is one line of the dashboard's live log tail.
type LogLine struct {
	At    time.Time `json:"at"`
	Level string    `json:"level"`
	// Endpoint is empty for process-wide lines.
	Endpoint string `json:"endpoint,omitempty"`
	Message  string `json:"message"`
}

// EventKind discriminates an [Event].
type EventKind string

// The kinds of event a supervisor publishes.
const (
	// EventSnapshot carries a new full snapshot. Full rather than incremental:
	// a dashboard that missed an event must not be able to drift.
	EventSnapshot EventKind = "snapshot"
	// EventLog carries one log line.
	EventLog EventKind = "log"
)

// Event is one update from a running gatekeeper.
type Event struct {
	Kind     EventKind `json:"kind"`
	Snapshot *Snapshot `json:"snapshot,omitempty"`
	Log      *LogLine  `json:"log,omitempty"`
}

// VerifyRequest asks for one verification.
type VerifyRequest struct {
	// Hostname is the bare host to fetch evidence from.
	Hostname string
	// Port defaults to 443.
	Port int
	// Endpoint names the configured endpoint whose pins and policies apply.
	// Empty means: the endpoint whose upstream is Hostname, or — when no
	// endpoint matches — verify cryptographically and evaluate policies with no
	// pins, which can never be admitted.
	Endpoint string
}

// Verifier runs the full pipeline against a live host: fetch, chain, root,
// JWS, freshness, observed channel binding, then policy.
type Verifier interface {
	Verify(ctx context.Context, req VerifyRequest) (*Report, error)
}

// Supervisor is a running gatekeeper's status and control surface. The data
// plane implements it; `gatekeeper status` and the TUI are its only consumers.
type Supervisor interface {
	// Snapshot is the current state of every endpoint.
	Snapshot(ctx context.Context) Snapshot
	// Events streams updates until ctx is done. The channel is closed when the
	// supervisor stops publishing.
	Events(ctx context.Context) <-chan Event
	// Start binds an endpoint's listener; it is a no-op if already running.
	Start(ctx context.Context, endpoint string) error
	// Stop drains and closes it.
	Stop(ctx context.Context, endpoint string) error
	// Reattest forces a fresh verification, bypassing the verdict cache.
	Reattest(ctx context.Context, endpoint string) (*Report, error)
}

// Reloader is implemented by supervisors that can adopt a new configuration
// without restarting. `gatekeeper run` calls it on SIGHUP; a supervisor that
// does not implement it makes SIGHUP a no-op with a log line, never a restart —
// dropping live connections because a config file was touched would be worse
// than not reloading.
type Reloader interface {
	Reload(ctx context.Context, cfg *config.Config) error
}
