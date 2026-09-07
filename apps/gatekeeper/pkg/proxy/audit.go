package proxy

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// AuditEntry is one line of the audit log: a verdict, or a request the verdict
// decided the fate of.
//
// What is *not* here is the point of the type. There is no request body, no
// response body, no header, and no query string — the gatekeeper carries
// prompts and `Authorization: Bearer sk-…` and must not spill either into a
// file that outlives the process. The URL is recorded as its path alone.
type AuditEntry struct {
	At    time.Time `json:"at"`
	Event string    `json:"event"`
	// Endpoint is the configured endpoint name.
	Endpoint string `json:"endpoint"`

	// Admitted, Stage and Reason describe the verdict in force.
	Admitted bool   `json:"admitted"`
	Stage    string `json:"stage,omitempty"`
	Reason   string `json:"reason,omitempty"`

	// EvidenceDigest and ObservedTLSFingerprint identify what was judged, in
	// the `sha256:<hex>` form every user-facing surface shows — an audit line
	// is read next to a `gatekeeper verify` report or a console screen, and a
	// digest that has to be re-encoded before the two can be compared is a
	// digest nobody compares.
	EvidenceDigest         string `json:"evidenceDigest,omitempty"`
	ObservedTLSFingerprint string `json:"observedTlsFingerprint,omitempty"`
	Root                   string `json:"root,omitempty"`

	// Method, Path and Status are set on the request events.
	Method   string `json:"method,omitempty"`
	Path     string `json:"path,omitempty"`
	Status   int    `json:"status,omitempty"`
	FailMode string `json:"failMode,omitempty"`
}

// The audit events. Only three things are worth a durable record: what the
// gatekeeper decided, what it refused, and what it let through without a
// verdict.
const (
	// AuditVerdict is written whenever a verification completes with a
	// different answer than the one before it.
	AuditVerdict = "verdict"
	// AuditBlocked is a request refused because the endpoint had no verdict
	// admitting it.
	AuditBlocked = "blocked"
	// AuditUnverified is a request a `failMode: open` endpoint forwarded
	// anyway. It is the entry an incident review is looking for.
	AuditUnverified = "unverified"
)

// auditor appends JSON lines to the configured audit file. A nil *auditor is
// valid and records nothing, which is what an unconfigured `audit:` section
// gets.
type auditor struct {
	mu sync.Mutex
	w  io.WriteCloser
}

// openAudit opens the audit log for appending, creating it and its directory if
// needed. The file is owner-only: it holds a record of what the user attested
// and what they let through.
func openAudit(path string) (*auditor, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("audit log: %w", err)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600) //nolint:gosec // operator-supplied path by design
	if err != nil {
		return nil, fmt.Errorf("audit log: %w", err)
	}
	return &auditor{w: f}, nil
}

// record appends one entry. A write failure is swallowed on purpose: a full
// disk must not take the proxy down, and the alternative — failing the request
// the entry describes — would turn an observability problem into an outage.
func (a *auditor) record(entry AuditEntry) {
	if a == nil {
		return
	}
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	_, _ = a.w.Write(append(line, '\n'))
}

func (a *auditor) Close() error {
	if a == nil {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.w.Close()
}
