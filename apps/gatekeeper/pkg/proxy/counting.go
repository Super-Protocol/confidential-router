package proxy

import (
	"bufio"
	"io"
	"net"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
)

// flow accounts for the bytes of one endpoint as they cross, not once the
// request is over.
//
// Doing it per write matters for exactly the traffic the gatekeeper exists to
// carry: a streamed completion is one request that lasts minutes, and a
// dashboard that showed nothing until it ended would be blank whenever the
// endpoint was busiest.
type flow struct {
	stats *counters
	in    prometheus.Counter
	out   prometheus.Counter
}

func (f *flow) addIn(n int64) {
	if n <= 0 {
		return
	}
	f.stats.addIn(n)
	f.in.Add(float64(n))
}

func (f *flow) addOut(n int64) {
	if n <= 0 {
		return
	}
	f.stats.addOut(n)
	f.out.Add(float64(n))
}

// countingReader counts the request body on its way upstream. It never buffers
// and never inspects: a request body is a prompt, and nothing here may hold one.
type countingReader struct {
	r    io.ReadCloser
	flow *flow
}

func (c *countingReader) Read(p []byte) (int, error) {
	if c.r == nil {
		return 0, io.EOF
	}
	n, err := c.r.Read(p)
	c.flow.addIn(int64(n))
	return n, err
}

func (c *countingReader) Close() error {
	if c.r == nil {
		return nil
	}
	return c.r.Close()
}

// countingWriter counts the response on its way back to the client while
// staying transparent to everything the data path depends on: per-write
// flushing (SSE) and hijacking (WebSocket upgrades).
type countingWriter struct {
	http.ResponseWriter
	flow *flow
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.ResponseWriter.Write(p)
	c.flow.addOut(int64(n))
	return n, err
}

// Unwrap lets http.ResponseController reach the real writer for everything this
// type does not implement itself.
func (c *countingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

// Flush forwards to the underlying writer, which is what makes a streamed
// response arrive chunk by chunk rather than at the end.
func (c *countingWriter) Flush() {
	//nolint:errcheck // a writer that cannot flush is not an error the client can act on
	_ = http.NewResponseController(c.ResponseWriter).Flush()
}

// Hijack hands over the raw connection for a protocol switch, wrapped so that
// what a WebSocket carries is counted like any other traffic.
func (c *countingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(c.ResponseWriter).Hijack()
	if err != nil {
		return nil, nil, err
	}
	return &countingConn{Conn: conn, flow: c.flow}, rw, nil
}

// countingConn counts both directions of a hijacked connection.
type countingConn struct {
	net.Conn
	flow *flow
}

func (c *countingConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	c.flow.addOut(int64(n))
	return n, err
}

func (c *countingConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	c.flow.addIn(int64(n))
	return n, err
}
