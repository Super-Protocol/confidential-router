package attestedroot

import (
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// DefaultRegistryBaseURL is where Super Protocol publishes the signatures of
// the VM measurements it vouches for. Each file is named after the measurement
// it covers, so a hit *is* the statement "this image is one of ours".
const DefaultRegistryBaseURL = "https://raw.githubusercontent.com/Super-Protocol/sp-vm/main/signatures"

// trustedRegistryKeySPKI is the RSA-3072 public key, DER SubjectPublicKeyInfo
// in base64, that signs every entry of the registry.
//
// It is pinned in the binary, not fetched: the registry is served over plain
// HTTPS from a Git host, so transport trust would make whoever controls that
// host able to mint trusted measurements. With the key pinned, the host can
// only withhold an answer — which fails closed — and the same value is what
// @super-protocol/attestation-common pins (`TRUSTED_PUBLIC_KEY_SPKI_B64`), so
// both verifiers accept exactly the same set of images.
const trustedRegistryKeySPKI = "MIIBoDANBgkqhkiG9w0BAQEFAAOCAY0AMIIBiAKCAYEAy99uld749OD5W48roZ4MbuKk1Bo7tGIfEOot1+xlWQKDDBaRQDg+LOGhPpRmGbF/s4t9rUGvxBnjyl+PtpLyJkx+eBT6ubTEb/4SbdgiqPjtXXV0eUVYoBZHSmT9YFklcJ1YWDwYxOm0skh/wm5IBpSnGMuLp2mc8Fyq+vxWzEPeFzbLH6QWdG/9Ts5mJHJ3UaWG1fW4lSMf3eVc9BRwpa7tpXpURLj2TsX8wgCbQVQ1+QYLoCdS6HZc57vsIGR6TxHeqmaJWpDaXBV8dzw9aekTGadk9/IetjI1baX9BJ8s7Ipx9fYnf9qwmWezBO1cmOowm9Md6TMPEkVxvzady+rMyLWbGrJoaJ6HW5EPYoFQW2cBFOd1QzS4ajL3t/SXQpB3TnBSyeIz+8OowH+aAd7/9vCI5Ro8j0RsnDU/T3mNkb5pA4OwY6qxornR39RmHTz3GaRZemK++pfPR33AVMlJdspym+qQVI4TtaqzcI+yOHdGTD2vMTuiRQ7+1i89AgED"

// registryKey parses the pinned key once. A build whose constant is corrupt
// must not start: every attested-root verdict depends on it.
var registryKey = mustParseRegistryKey()

func mustParseRegistryKey() *rsa.PublicKey {
	der, err := base64.StdEncoding.DecodeString(trustedRegistryKeySPKI)
	if err != nil {
		panic("attestedroot: the pinned registry key is not base64: " + err.Error())
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		panic("attestedroot: the pinned registry key is not a SubjectPublicKeyInfo: " + err.Error())
	}
	key, ok := parsed.(*rsa.PublicKey)
	if !ok {
		panic(fmt.Sprintf("attestedroot: the pinned registry key is %T, expected an RSA key", parsed))
	}
	return key
}

// ErrNotInRegistry is what a lookup returns when the registry answered, and
// the answer was that it has no signature for this measurement. It is a
// distinct error from a registry that could not be reached: one means "not one
// of ours", the other means "unknown", and only the first is a verdict.
var ErrNotInRegistry = errors.New("measurement is not in the trusted registry")

// Registry answers whether Super Protocol vouches for a measurement.
type Registry interface {
	// Verify returns nil when the registry holds a valid signature over
	// mrEnclave for this evidence type, [ErrNotInRegistry] when it holds none,
	// and any other error when it could not be consulted.
	Verify(ctx context.Context, mrEnclave []byte, evidence EvidenceType) error
}

// HTTPRegistry is the real registry: signature files fetched over HTTPS and
// checked against the pinned key.
type HTTPRegistry struct {
	// BaseURL defaults to [DefaultRegistryBaseURL].
	BaseURL string
	// Client defaults to http.DefaultClient.
	Client *http.Client
}

// Verify implements [Registry].
//
// It probes the same paths, in the same order, as the platform's own client:
// the release channel, then the pre-release channel, then the legacy flat
// layout. A 404 falls through to the next path; anything else is a failure to
// consult the registry rather than an absent measurement.
func (r *HTTPRegistry) Verify(ctx context.Context, mrEnclave []byte, evidence EvidenceType) error {
	if len(mrEnclave) == 0 {
		return errors.New("registry: no measurement to look up")
	}
	measurement := hex.EncodeToString(mrEnclave)

	base := strings.TrimSuffix(r.BaseURL, "/")
	if base == "" {
		base = DefaultRegistryBaseURL
	}
	var paths []string
	if folder := evidence.registryFolder(); folder != "" {
		paths = append(paths,
			fmt.Sprintf("%s/%s/latest/mrenclave-%s.json", base, folder, measurement),
			fmt.Sprintf("%s/%s/pre-release/mrenclave-%s.json", base, folder, measurement),
		)
	}
	paths = append(paths, fmt.Sprintf("%s/mrenclave-%s.sign", base, measurement))

	for _, url := range paths {
		body, found, err := r.get(ctx, url)
		if err != nil {
			return err
		}
		if !found {
			continue
		}
		signature, err := signatureFrom(url, body)
		if err != nil {
			return err
		}
		if signature == nil {
			continue
		}
		return verifyMeasurementSignature(mrEnclave, signature)
	}
	return fmt.Errorf("%w (%s)", ErrNotInRegistry, measurement)
}

func (r *HTTPRegistry) get(ctx context.Context, url string) ([]byte, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, false, fmt.Errorf("registry: %w", err)
	}
	client := r.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("registry: %s: %w", url, err)
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		return nil, false, nil
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		return nil, false, fmt.Errorf("registry: %s: unexpected status %d", url, resp.StatusCode)
	}
	// A signature is a few hundred bytes; a body far past that is a wrong URL
	// or a captive portal, and reading it whole would be the bug.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return nil, false, fmt.Errorf("registry: %s: %w", url, err)
	}
	return body, true, nil
}

// signatureFrom reads a signature out of whichever layout the path implies.
// A JSON entry without a signature returns (nil, nil): the platform's client
// treats it as a miss and moves on to the next path.
func signatureFrom(url string, body []byte) ([]byte, error) {
	if strings.HasSuffix(url, ".sign") {
		return body, nil
	}
	var entry struct {
		Signature string `json:"signature"`
	}
	if err := json.Unmarshal(body, &entry); err != nil {
		return nil, fmt.Errorf("registry: %s: malformed signature document: %w", url, err)
	}
	if entry.Signature == "" {
		return nil, nil
	}
	signature, err := base64.StdEncoding.DecodeString(entry.Signature)
	if err != nil {
		return nil, fmt.Errorf("registry: %s: signature is not base64: %w", url, err)
	}
	return signature, nil
}

// verifyMeasurementSignature checks an RSASSA-PKCS1-v1_5 signature over the
// raw measurement bytes under the pinned key.
func verifyMeasurementSignature(mrEnclave, signature []byte) error {
	sum := sha256.Sum256(mrEnclave)
	if err := rsa.VerifyPKCS1v15(registryKey, crypto.SHA256, sum[:], signature); err != nil {
		return fmt.Errorf("registry: the signature over measurement %x is not valid under the pinned Super Protocol key: %w",
			mrEnclave, err)
	}
	return nil
}
