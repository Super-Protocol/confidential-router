package cli

import (
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// The `--json` documents.
//
// Every digest the CLI reports is spelled the way the CLI prints it —
// `sha256:<hex>` — with the canonical `sha256/<base64url>` form alongside it in
// a `*Canonical` field. A script that greps the digest out of `verify --json`
// and pastes it into `endpoint trust add` therefore gets the same string a
// human would read off the report or copy out of the router console; a script
// that compares against the value inside a signed bundle uses the companion.
//
// The documents wrap [status.Report] and [status.Endpoint] rather than changing
// them, because those types are also the proxy's control-plane wire format
// (pkg/proxy/admin.go, decoded back by pkg/proxy/client.go). Internally a digest
// stays canonical everywhere; hex is what crosses the boundary to a reader.
//
// The embedded value supplies every other field; the fields declared here
// shadow the ones it carries, since encoding/json resolves a name conflict in
// favour of the shallower field.

// reportDocument is one verification as `verify --json` and `discover --json`
// report it.
type reportDocument struct {
	*status.Report
	EvidenceDigest                  string                `json:"evidenceDigest,omitempty"`
	EvidenceDigestCanonical         string                `json:"evidenceDigestCanonical,omitempty"`
	CertFingerprint                 string                `json:"certFingerprint,omitempty"`
	CertFingerprintCanonical        string                `json:"certFingerprintCanonical,omitempty"`
	ObservedTLSFingerprint          string                `json:"observedTlsFingerprint,omitempty"`
	ObservedTLSFingerprintCanonical string                `json:"observedTlsFingerprintCanonical,omitempty"`
	RootFingerprint                 string                `json:"rootFingerprint,omitempty"`
	RootFingerprintCanonical        string                `json:"rootFingerprintCanonical,omitempty"`
	UntrustedRoot                   string                `json:"untrustedRoot,omitempty"`
	UntrustedRootCanonical          string                `json:"untrustedRootCanonical,omitempty"`
	Chain                           []certificateDocument `json:"chain,omitempty"`
}

// certificateDocument is one chain entry, with its fingerprint in both forms.
type certificateDocument struct {
	status.Certificate
	Fingerprint          string `json:"fingerprint"`
	FingerprintCanonical string `json:"fingerprintCanonical,omitempty"`
}

// endpointDocument is one endpoint's live state as `status --json` reports it.
type endpointDocument struct {
	status.Endpoint
	PublishedDigest          string          `json:"publishedDigest,omitempty"`
	PublishedDigestCanonical string          `json:"publishedDigestCanonical,omitempty"`
	Report                   *reportDocument `json:"report,omitempty"`
}

// snapshotDocument is every endpoint's state at one instant.
type snapshotDocument struct {
	status.Snapshot
	Endpoints []endpointDocument `json:"endpoints"`
}

func documentOf(report *status.Report) *reportDocument {
	if report == nil {
		return nil
	}
	doc := &reportDocument{
		Report:                          report,
		EvidenceDigest:                  hexDigest(report.EvidenceDigest),
		EvidenceDigestCanonical:         report.EvidenceDigest,
		CertFingerprint:                 hexDigest(report.CertFingerprint),
		CertFingerprintCanonical:        report.CertFingerprint,
		ObservedTLSFingerprint:          hexDigest(report.ObservedTLSFingerprint),
		ObservedTLSFingerprintCanonical: report.ObservedTLSFingerprint,
		RootFingerprint:                 hexDigest(report.RootFingerprint),
		RootFingerprintCanonical:        report.RootFingerprint,
		UntrustedRoot:                   hexDigest(report.UntrustedRoot),
		UntrustedRootCanonical:          report.UntrustedRoot,
	}
	for _, cert := range report.Chain {
		doc.Chain = append(doc.Chain, certificateDocument{
			Certificate:          cert,
			Fingerprint:          hexDigest(cert.Fingerprint),
			FingerprintCanonical: cert.Fingerprint,
		})
	}
	return doc
}

func endpointDocumentOf(ep status.Endpoint) endpointDocument {
	return endpointDocument{
		Endpoint:                 ep,
		PublishedDigest:          hexDigest(ep.PublishedDigest),
		PublishedDigestCanonical: ep.PublishedDigest,
		Report:                   documentOf(ep.Report),
	}
}

func snapshotDocumentOf(snapshot status.Snapshot) snapshotDocument {
	doc := snapshotDocument{Snapshot: snapshot, Endpoints: make([]endpointDocument, 0, len(snapshot.Endpoints))}
	for _, ep := range snapshot.Endpoints {
		doc.Endpoints = append(doc.Endpoints, endpointDocumentOf(ep))
	}
	return doc
}
