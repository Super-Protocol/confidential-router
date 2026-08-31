package attestation

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// EvidencePath is where the platform publishes an endpoint's evidence bundle.
const EvidencePath = "/.well-known/swarm-evidence"

// Fetch defaults. They are deliberately tight: the bundle is a small JSON
// document served by a host the gatekeeper has not yet decided to trust.
const (
	DefaultFetchTimeout  = 15 * time.Second
	DefaultMaxBundleSize = 1 << 20 // 1 MiB
	defaultHTTPSPort     = 443
)

// FetchError is any failure reaching or reading the evidence endpoint. Its
// message is what the verifier reports as the reason of a `fetch`-stage denial.
type FetchError struct{ msg string }

func (e *FetchError) Error() string { return e.msg }

func fetchErrf(format string, args ...any) error {
	return &FetchError{msg: fmt.Sprintf(format, args...)}
}

// FetchOptions tunes Fetch. The zero value is valid and uses the defaults above.
type FetchOptions struct {
	// Port defaults to 443.
	Port int
	// Timeout bounds the whole exchange — dial, handshake, response body.
	Timeout time.Duration
	// MaxBytes caps the response body; a larger body is an error, not a
	// truncation, so a hostile host cannot get a prefix of its bundle accepted.
	MaxBytes int64
	// TLSConfig overrides the handshake settings. When nil the handshake does
	// not check the chain against the system pool: the evidence chain and the
	// fingerprint binding are what decide trust here (ADR-003 §1), and Swarm
	// Cloud roots are not publicly trusted, so a system-pool check would reject
	// every healthy endpoint. ServerName and NextProtos are always set.
	TLSConfig *tls.Config
	// DialContext opens the TCP connection the handshake then runs over. Nil
	// uses a plain net.Dialer.
	//
	// It exists because substituting the whole [Fetcher] is the wrong tool for
	// "reach this host over my transport": a Fetcher replaces the handshake
	// too, and with it the observed channel binding, which is the only binding
	// the gatekeeper accepts. Overriding the dial keeps the TLS layer — and the
	// certificate this package records — entirely intact.
	DialContext func(ctx context.Context, network, addr string) (net.Conn, error)
}

// FetchResult is a bundle document together with the certificate the gatekeeper
// saw while retrieving it.
type FetchResult struct {
	URL        string
	StatusCode int
	Body       []byte
	// ObservedLeafDER is the DER of the leaf certificate the peer presented on
	// the connection this body arrived over.
	ObservedLeafDER []byte
	// ObservedTLSFingerprint is SHA256Fingerprint(ObservedLeafDER).
	ObservedTLSFingerprint string
}

// Fetcher retrieves an endpoint's evidence document. Fetch is the real one;
// Params.Fetcher lets a caller substitute another — the conformance vectors
// replay recorded responses through it, and an embedder with its own transport
// can plug that in without reimplementing the pipeline.
type Fetcher func(ctx context.Context, hostname string, opts FetchOptions) (*FetchResult, error)

// Fetch retrieves https://<hostname>/.well-known/swarm-evidence and records the
// TLS leaf certificate of the very connection that carried the response.
//
// A non-2xx response is not an error: the status and body are returned so the
// verifier can report the endpoint's own failure, with its URL, as a
// fetch-stage denial. Only transport, TLS, size-limit and read failures come
// back as errors.
//
// Observing in the same dial is the point: a fingerprint captured by a separate
// handshake could belong to a different connection than the one the bundle came
// from (or than the one traffic will later be proxied over). The transport
// therefore keeps no idle connections, negotiates HTTP/1.1 only, refuses
// redirects, and fails if the exchange somehow spans more than one distinct
// peer certificate.
func Fetch(ctx context.Context, hostname string, opts FetchOptions) (*FetchResult, error) {
	if hostname == "" {
		return nil, fetchErrf("hostname must be a non-empty string")
	}
	if strings.ContainsAny(hostname, "/:") {
		return nil, fetchErrf("hostname %q must be a bare host, without scheme or port", hostname)
	}
	port := opts.Port
	if port == 0 {
		port = defaultHTTPSPort
	}
	if port < 1 || port > 65535 {
		return nil, fetchErrf("invalid port %d", port)
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultFetchTimeout
	}
	maxBytes := opts.MaxBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBundleSize
	}

	host := hostname
	if port != defaultHTTPSPort {
		host = net.JoinHostPort(hostname, strconv.Itoa(port))
	}
	url := "https://" + host + EvidencePath

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	observer := &leafObserver{}
	transport := &http.Transport{
		DisableKeepAlives: true,
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return observer.dial(ctx, network, addr, hostname, opts)
		},
	}
	defer transport.CloseIdleConnections()

	client := &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			// A redirect would move the bundle off the connection whose
			// certificate we observed, breaking the binding it is fetched for.
			return http.ErrUseLastResponse
		},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fetchErrf("request failed: %v", err)
	}
	req.Header.Set("accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fetchErrf("request failed: %v", unwrapURLError(err))
	}
	defer func() { _ = resp.Body.Close() }()

	der, fingerprint, err := observer.result()
	if err != nil {
		return nil, err
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return nil, fetchErrf("request failed: %v", err)
	}
	if int64(len(body)) > maxBytes {
		return nil, fetchErrf("evidence bundle exceeds the %d byte limit", maxBytes)
	}

	return &FetchResult{
		URL:                    url,
		StatusCode:             resp.StatusCode,
		Body:                   body,
		ObservedLeafDER:        der,
		ObservedTLSFingerprint: fingerprint,
	}, nil
}

// leafObserver records the leaf certificate of every TLS connection the
// transport opens for one exchange.
type leafObserver struct {
	mu    sync.Mutex
	der   []byte
	dials int
	err   error
}

func (o *leafObserver) dial(ctx context.Context, network, addr, serverName string, opts FetchOptions) (net.Conn, error) {
	cfg := &tls.Config{
		//nolint:gosec // G402: the handshake is intentionally not validated against the
		// system pool — trust is decided by the evidence chain terminating at a
		// user-configured root plus the fingerprint binding below (ADR-003 §1).
		InsecureSkipVerify: true,
	}
	if opts.TLSConfig != nil {
		cfg = opts.TLSConfig.Clone()
	}
	cfg.ServerName = serverName
	// HTTP/1.1 only: an h2 connection can be reused for later requests, which
	// would decouple "the certificate we observed" from "the connection this
	// response came over".
	cfg.NextProtos = []string{"http/1.1"}

	raw, err := DialTCP(ctx, opts.DialContext, network, addr)
	if err != nil {
		return nil, err
	}
	tlsConn := tls.Client(raw, cfg)
	if err := tlsConn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, err
	}

	state := tlsConn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		_ = tlsConn.Close()
		return nil, errors.New("peer did not present a certificate")
	}
	o.record(state.PeerCertificates[0].Raw)
	return tlsConn, nil
}

// DialTCP opens the connection a TLS handshake will run over, through dial when
// one was supplied and a plain net.Dialer otherwise. It is exported because the
// data plane dials the same upstreams for the traffic it proxies and has to
// honour the same override.
func DialTCP(ctx context.Context, dial func(context.Context, string, string) (net.Conn, error),
	network, addr string,
) (net.Conn, error) {
	if dial != nil {
		return dial(ctx, network, addr)
	}
	return (&net.Dialer{}).DialContext(ctx, network, addr)
}

func (o *leafObserver) record(der []byte) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.dials++
	if o.der == nil {
		o.der = der
		return
	}
	if string(o.der) != string(der) {
		o.err = errors.New("the exchange spanned more than one peer certificate")
	}
}

func (o *leafObserver) result() ([]byte, string, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.err != nil {
		return nil, "", fetchErrf("request failed: %v", o.err)
	}
	if o.dials == 0 || o.der == nil {
		return nil, "", fetchErrf("request failed: no TLS connection was observed")
	}
	return o.der, SHA256Fingerprint(o.der), nil
}

// unwrapURLError strips the *url.Error wrapper so the reason reads as the
// underlying transport failure rather than repeating the method and URL.
func unwrapURLError(err error) error {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Err != nil {
		return urlErr.Err
	}
	return err
}
