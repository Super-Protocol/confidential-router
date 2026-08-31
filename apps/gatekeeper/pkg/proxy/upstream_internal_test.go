package proxy

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/attestation"
)

// The pin-recheck branch of dialTLS is reachable only while a handshake is in
// flight and setPin runs — the window a certificate rotation lands in. The
// package's other tests drive whole requests and never land in it, so it is
// exercised here, directly against the pool.

// testTLSServer is a loopback TLS listener that presents one certificate.
func testTLSServer(t *testing.T) (addr string, fingerprint string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "router.example.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert := tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}

	listener, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{
		Certificates: []tls.Certificate{cert},
		MinVersion:   tls.VersionTLS12,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })

	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			// A tls.Listener hands back a connection that has not handshaken;
			// something on this side has to drive it, or the client waits out
			// its dial budget.
			go func() {
				defer conn.Close() //nolint:errcheck // test fixture
				if tlsConn, ok := conn.(*tls.Conn); ok {
					_ = tlsConn.Handshake()
				}
				// Held open until the client hangs up: this test is about the
				// handshake, not about what crosses afterwards.
				_, _ = conn.Read(make([]byte, 1))
			}()
		}
	}()
	return listener.Addr().String(), attestation.SHA256Fingerprint(der)
}

func TestDialRefusesAConnectionWhosePinChangedDuringTheHandshake(t *testing.T) {
	addr, fingerprint := testTLSServer(t)

	// The dial is gated so the test can change the pin after dialTLS has read
	// it and before the handshake completes — the window the branch exists for.
	started, resume := make(chan struct{}), make(chan struct{})
	p := newPool("router.example.test", 443, func(ctx context.Context, network, _ string) (net.Conn, error) {
		close(started)
		<-resume
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	})

	type result struct {
		conn net.Conn
		err  error
	}
	done := make(chan result, 1)
	go func() {
		conn, err := p.dialTLS(context.Background(), "tcp", p.addr)
		done <- result{conn, err}
	}()

	<-started
	rotated := attestation.SHA256Fingerprint([]byte("some other certificate"))
	p.setPin(rotated)
	close(resume)

	got := <-done
	if got.conn != nil {
		t.Error("a connection opened under the previous pin was handed to the transport")
	}
	var mismatch *leafMismatchError
	if !errors.As(got.err, &mismatch) {
		t.Fatalf("err = %v, want a leaf mismatch", got.err)
	}
	// Want is the pin now in force, Got the certificate the peer actually
	// presented — not, as it once was, the pin that had just been replaced.
	if mismatch.Want != rotated {
		t.Errorf("Want = %q, want the pin now in force (%q)", mismatch.Want, rotated)
	}
	if mismatch.Got != fingerprint {
		t.Errorf("Got = %q, want the certificate the upstream presented (%q)", mismatch.Got, fingerprint)
	}
}

func TestDialIsSafeWhileThePinIsChanging(t *testing.T) {
	addr, fingerprint := testTLSServer(t)
	p := newPool("router.example.test", 443, func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, addr)
	})

	// Dials and re-pins overlap for real, which is what gives the race detector
	// something to look at.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 10 {
				conn, err := p.dialTLS(ctx, "tcp", p.addr)
				if conn != nil {
					_ = conn.Close()
					continue
				}
				var mismatch *leafMismatchError
				if err != nil && !errors.As(err, &mismatch) && ctx.Err() == nil {
					t.Errorf("dial failed for a reason other than the pin: %v", err)
					return
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := range 40 {
			pin := fingerprint
			if i%2 == 0 {
				pin = attestation.SHA256Fingerprint([]byte("rotation " + string(rune(i))))
			}
			p.setPin(pin)
			time.Sleep(time.Millisecond)
		}
	}()
	wg.Wait()
}
