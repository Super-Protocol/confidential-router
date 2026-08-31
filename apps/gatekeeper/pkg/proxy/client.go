package proxy

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// clientTimeout bounds one admin request. The API only ever renders state
// already in memory, so anything slower is a gatekeeper that is not answering.
const clientTimeout = 5 * time.Second

// Client reads a *running* gatekeeper's state over its admin socket. It is what
// makes `gatekeeper status` in one terminal report on `gatekeeper run` in
// another.
//
// It implements [status.Supervisor] so that the same commands work against a
// local supervisor and a remote-in-another-process one, but only the reading
// half is real: the admin API deliberately exposes no route that could start,
// stop or re-attest an endpoint, so those three return [status.ErrUnavailable].
//
// One command, one client: [Client.Snapshot] cannot return an error through the
// interface, so it caches the last one, which makes a Client single-user.
type Client struct {
	base string
	http *http.Client
	// err holds the last transport failure, so a caller that cannot see an
	// error return can still find out why the snapshot was empty.
	err error
}

// NewClient builds a client for an `admin.listen` value: `unix:<path>` or a
// loopback `host:port`.
func NewClient(listen string) (*Client, error) {
	if listen == "" {
		return nil, fmt.Errorf("no admin listener is configured")
	}
	transport := &http.Transport{}
	base := "http://" + listen
	if socket, ok := strings.CutPrefix(listen, "unix:"); ok {
		base = "http://gatekeeper"
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}
	}
	return &Client{base: base, http: &http.Client{Transport: transport, Timeout: clientTimeout}}, nil
}

// Ping checks that a gatekeeper is listening and answering. It is what a
// command calls before reporting, so that "nothing is running" is an
// explanation rather than an empty table.
func (c *Client) Ping(ctx context.Context) (Health, error) {
	var health Health
	err := c.get(ctx, "/healthz", &health)
	return health, err
}

// Snapshot implements [status.Supervisor]. A failure leaves the snapshot empty
// and is retrievable through [Client.Err].
func (c *Client) Snapshot(ctx context.Context) status.Snapshot {
	var snapshot status.Snapshot
	c.err = c.get(ctx, "/status", &snapshot)
	return snapshot
}

// Verdicts is the /verdicts document: one entry per endpoint.
func (c *Client) Verdicts(ctx context.Context) ([]Verdict, error) {
	var verdicts []Verdict
	err := c.get(ctx, "/verdicts", &verdicts)
	return verdicts, err
}

// Err returns the last transport failure, or nil.
func (c *Client) Err() error { return c.err }

// Events implements [status.Supervisor] with an immediately closed channel: the
// admin API is a polling surface, not a stream. A dashboard wanting live
// updates runs in the same process as the supervisor.
func (c *Client) Events(context.Context) <-chan status.Event {
	out := make(chan status.Event)
	close(out)
	return out
}

// Start implements [status.Supervisor].
func (c *Client) Start(context.Context, string) error { return status.ErrUnavailable }

// Stop implements [status.Supervisor].
func (c *Client) Stop(context.Context, string) error { return status.ErrUnavailable }

// Reattest implements [status.Supervisor].
func (c *Client) Reattest(context.Context, string) (*status.Report, error) {
	return nil, status.ErrUnavailable
}

func (c *Client) get(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: unexpected status %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(into)
}
