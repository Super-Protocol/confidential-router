package attestedroot

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// maxFirmwareBytes bounds a firmware download. OVMF images are a few megabytes;
// anything past this is a wrong object or a misbehaving gateway, and the point
// of a bound is to fail rather than to buffer.
const maxFirmwareBytes = 64 << 20

// FirmwareStore fetches an OVMF image by bucket and key.
type FirmwareStore interface {
	Get(ctx context.Context, bucket, key string) ([]byte, error)
}

// S3FirmwareStore reads objects from an S3-compatible gateway with SigV4.
//
// It implements the one request shape the gatekeeper makes — an unsigned-payload
// GetObject in path style — rather than pulling in an SDK: the AWS SDK's module
// graph is larger than this binary, and every byte it fetches is checksummed by
// the caller anyway.
type S3FirmwareStore struct {
	Endpoint    string
	Region      string
	AccessKeyID string
	SecretKey   string
	// Client defaults to a client with a timeout: a stalled firmware download
	// would otherwise hold a verification open indefinitely.
	Client *http.Client
}

// DefaultFirmwareStore is the platform's published read-only firmware source.
func DefaultFirmwareStore() *S3FirmwareStore {
	return &S3FirmwareStore{
		Endpoint:    DefaultFirmwareEndpoint,
		Region:      defaultFirmwareRegion,
		AccessKeyID: defaultFirmwareAccessKeyID,
		SecretKey:   defaultFirmwareSecretKey,
		Client:      &http.Client{Timeout: 2 * time.Minute},
	}
}

// Get implements [FirmwareStore].
func (s *S3FirmwareStore) Get(ctx context.Context, bucket, key string) ([]byte, error) {
	endpoint, err := url.Parse(s.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("firmware store endpoint %q: %w", s.Endpoint, err)
	}
	// Path style, because a bucket name is not guaranteed to be a valid DNS
	// label and the gateway serves both.
	endpoint.Path = "/" + bucket + "/" + strings.TrimPrefix(key, "/")

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	if err := s.sign(req, time.Now().UTC()); err != nil {
		return nil, err
	}

	client := s.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s/%s: unexpected status %d", bucket, key, resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFirmwareBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxFirmwareBytes {
		return nil, fmt.Errorf("%s/%s is larger than the %d-byte limit", bucket, key, maxFirmwareBytes)
	}
	return body, nil
}

// sign adds an AWS SigV4 authorization header for an unsigned-payload GET.
func (s *S3FirmwareStore) sign(req *http.Request, now time.Time) error {
	const unsignedPayload = "UNSIGNED-PAYLOAD"
	const service = "s3"

	amzDate := now.Format("20060102T150405Z")
	dateStamp := now.Format("20060102")

	req.Header.Set("Host", req.URL.Host)
	req.Header.Set("X-Amz-Date", amzDate)
	req.Header.Set("X-Amz-Content-Sha256", unsignedPayload)

	canonicalHeaders := "host:" + req.URL.Host + "\n" +
		"x-amz-content-sha256:" + unsignedPayload + "\n" +
		"x-amz-date:" + amzDate + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"

	canonicalRequest := strings.Join([]string{
		req.Method,
		escapePath(req.URL.Path),
		req.URL.RawQuery,
		canonicalHeaders,
		signedHeaders,
		unsignedPayload,
	}, "\n")

	region := s.Region
	if region == "" {
		region = defaultFirmwareRegion
	}
	scope := strings.Join([]string{dateStamp, region, service, "aws4_request"}, "/")
	requestHash := sha256.Sum256([]byte(canonicalRequest))
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hex.EncodeToString(requestHash[:]),
	}, "\n")

	key := hmacSHA256([]byte("AWS4"+s.SecretKey), dateStamp)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, service)
	key = hmacSHA256(key, "aws4_request")
	signature := hex.EncodeToString(hmacSHA256(key, stringToSign))

	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		s.AccessKeyID, scope, signedHeaders, signature))
	return nil
}

func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// escapePath percent-encodes a URI path the way SigV4 wants it: every segment
// escaped except the unreserved set, with the separators left alone.
func escapePath(path string) string {
	var b strings.Builder
	for i := 0; i < len(path); i++ {
		c := path[i]
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~', c == '/':
			b.WriteByte(c)
		default:
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
