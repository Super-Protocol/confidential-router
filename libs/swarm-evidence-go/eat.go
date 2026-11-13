package swarmevidence

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

// TokenFormat is the serialisation an Attestation Results token arrives in.
//
// The RATS EAT specification defines both; which one a Verifier emits is a
// property of that Verifier, so it is configuration here rather than a branch
// in the appraiser.
type TokenFormat string

const (
	// TokenJWT is the JSON Web Token serialisation, which every Verifier the
	// profile has met emits and which this build implements.
	TokenJWT TokenFormat = "jwt"
	// TokenCWT is the CBOR serialisation. It is named so a configuration can
	// declare it and be refused in one legible place rather than
	// mis-parsed; this build does not implement it.
	TokenCWT TokenFormat = "cwt"
)

// defaultEATAlgorithms is the signature algorithm allow-list a configuration
// that names none gets. It is an allow-list rather than "whatever the header
// says" for the usual reason: `alg: none`, and the HMAC family under a public
// key, are both accepted by a verifier that trusts the header.
//
// Intel Trust Authority signs with PS384; Veraison deployments commonly use
// ES256. Both are here, and neither is privileged.
var defaultEATAlgorithms = []string{
	"RS256", "RS384", "RS512",
	"PS256", "PS384", "PS512",
	"ES256", "ES384", "ES512",
}

// TokenVerification is how a token is authenticated, as configuration. No
// member of it names a Verifier: a different Verifier is a different issuer,
// a different key source and possibly a different algorithm, which is three
// values rather than a code path.
type TokenVerification struct {
	// Format is the serialisation; empty means [TokenJWT].
	Format TokenFormat
	// Issuer is the `iss` the token must carry. It is required: a token whose
	// issuer is not checked is a token signed by anyone whose key the key
	// source happens to serve.
	Issuer string
	// Audience, when set, is the `aud` the token must carry. A Verifier that
	// does not populate `aud` is configured without it.
	Audience string
	// Keys resolves the token's `kid` to the public keys it may be verified
	// under — a JWKS URL ([JWKSKeys]) or keys pinned in configuration
	// ([PinnedKeys]).
	Keys VerificationKeys
	// Algorithms is the `alg` allow-list; empty means [defaultEATAlgorithms].
	Algorithms []string
	// MaxTokenAge rejects a token whose `iat` is older than this. Zero
	// disables the check, which `exp` then carries alone.
	MaxTokenAge time.Duration
	// ClockSkew is the tolerance applied to `exp`, `nbf` and `iat`; zero
	// means [DefaultEATClockSkew].
	ClockSkew time.Duration
}

// DefaultEATClockSkew is the tolerance a token's time claims are checked with
// when the configuration names none.
const DefaultEATClockSkew = 60 * time.Second

// VerificationKeys resolves a token's key identifier to the public keys it may
// be verified under.
//
// It returns a set rather than one key because `kid` is optional in both JWS
// and JWKS: a key source that cannot tell which key signed a token answers
// with all of them, and a signature only verifies under the key that produced
// it.
type VerificationKeys interface {
	KeysFor(ctx context.Context, keyID string) ([]crypto.PublicKey, error)
}

// PinnedKeys is the key source for a relying party that pins its Verifier's
// signing keys instead of fetching them: an air-gapped Vault, a recorded-token
// test, a bank that will not let its credential path make an outbound request
// at verification time.
type PinnedKeys struct {
	// Keys are PEM documents: a PUBLIC KEY (SPKI) or a CERTIFICATE whose
	// public key is used. A key may carry the `kid` it answers to; a key with
	// no KeyID answers to every token.
	Keys []PinnedKey
}

// PinnedKey is one pinned verification key.
type PinnedKey struct {
	KeyID string
	PEM   string
}

// KeysFor implements [VerificationKeys].
func (p *PinnedKeys) KeysFor(_ context.Context, keyID string) ([]crypto.PublicKey, error) {
	var out []crypto.PublicKey
	for i, pinned := range p.Keys {
		if pinned.KeyID != "" && keyID != "" && pinned.KeyID != keyID {
			continue
		}
		key, err := parsePublicKeyPEM(pinned.PEM)
		if err != nil {
			return nil, fmt.Errorf("pinned verification key %d: %w", i, err)
		}
		out = append(out, key)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("no pinned verification key answers to kid %q", keyID)
	}
	return out, nil
}

func parsePublicKeyPEM(document string) (crypto.PublicKey, error) {
	block, _ := pem.Decode([]byte(document))
	if block == nil {
		return nil, errors.New("not a PEM document")
	}
	switch block.Type {
	case "PUBLIC KEY":
		return x509.ParsePKIXPublicKey(block.Bytes)
	case "CERTIFICATE":
		cert, err := x509.ParseCertificate(block.Bytes)
		if err != nil {
			return nil, err
		}
		return cert.PublicKey, nil
	default:
		return nil, fmt.Errorf("PEM block %q is neither a PUBLIC KEY nor a CERTIFICATE", block.Type)
	}
}

// JWKSKeys fetches a Verifier's signing keys from its JWKS endpoint.
//
// The set is cached, because the credential path runs per request and a key
// set changes on the order of months. A `kid` that is not in the cached set
// forces one refetch — key rotation is the one case where the cache is wrong
// and waiting for it to expire would deny every request in the meantime.
type JWKSKeys struct {
	// URL is the JWKS endpoint.
	URL string
	// Client overrides the HTTP client; nil uses one with a 10s timeout.
	Client *http.Client
	// CacheTTL overrides [DefaultJWKSCacheTTL]; negative disables caching.
	CacheTTL time.Duration
	// Now overrides the clock.
	Now func() time.Time

	mu      sync.Mutex
	keys    map[string][]crypto.PublicKey
	all     []crypto.PublicKey
	fetched time.Time
}

// DefaultJWKSCacheTTL is how long a fetched key set is reused.
const DefaultJWKSCacheTTL = time.Hour

// maxJWKSBytes bounds the key-set document. A key set is a few kilobytes; an
// unbounded read of an endpoint under someone else's control is not something
// a credential path should contain.
const maxJWKSBytes = 1 << 20

// KeysFor implements [VerificationKeys].
func (j *JWKSKeys) KeysFor(ctx context.Context, keyID string) ([]crypto.PublicKey, error) {
	if keys, ok := j.cached(keyID); ok {
		return keys, nil
	}
	if err := j.refresh(ctx); err != nil {
		return nil, err
	}
	if keys, ok := j.cached(keyID); ok {
		return keys, nil
	}
	return nil, fmt.Errorf("the key set at %s carries no key for kid %q", j.URL, keyID)
}

func (j *JWKSKeys) cached(keyID string) ([]crypto.PublicKey, bool) {
	if j.CacheTTL < 0 {
		return nil, false
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.fetched.IsZero() || j.clock().After(j.fetched.Add(j.ttl())) {
		return nil, false
	}
	if keyID == "" {
		return j.all, len(j.all) > 0
	}
	keys, ok := j.keys[keyID]
	return keys, ok
}

func (j *JWKSKeys) ttl() time.Duration {
	if j.CacheTTL == 0 {
		return DefaultJWKSCacheTTL
	}
	return j.CacheTTL
}

func (j *JWKSKeys) clock() time.Time {
	if j.Now == nil {
		return time.Now()
	}
	return j.Now()
}

func (j *JWKSKeys) refresh(ctx context.Context) error {
	if j.URL == "" {
		return errors.New("no JWKS URL is configured")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, j.URL, nil)
	if err != nil {
		return err
	}
	client := j.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("fetching the key set at %s: %w", j.URL, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("the key set at %s answered %s", j.URL, response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxJWKSBytes))
	if err != nil {
		return fmt.Errorf("reading the key set at %s: %w", j.URL, err)
	}

	byKeyID, all, err := parseJWKS(body)
	if err != nil {
		return fmt.Errorf("the key set at %s: %w", j.URL, err)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	j.keys, j.all, j.fetched = byKeyID, all, j.clock()
	return nil
}

// jwk is the subset of RFC 7517 a signature check needs.
type jwk struct {
	Kty string   `json:"kty"`
	Kid string   `json:"kid"`
	Crv string   `json:"crv"`
	N   string   `json:"n"`
	E   string   `json:"e"`
	X   string   `json:"x"`
	Y   string   `json:"y"`
	X5c []string `json:"x5c"`
}

// parseJWKS reads a key set into keys by `kid` and the flat set beside it.
//
// A key whose type this build cannot read is skipped rather than fatal: a key
// set holding one Ed25519 key beside the RSA key that signs today's tokens is
// a working key set, and refusing it would deny every request over a key
// nothing uses.
func parseJWKS(document []byte) (map[string][]crypto.PublicKey, []crypto.PublicKey, error) {
	var set struct {
		Keys []jwk `json:"keys"`
	}
	if err := json.Unmarshal(document, &set); err != nil {
		return nil, nil, fmt.Errorf("not a JSON key set: %w", err)
	}
	byKeyID := map[string][]crypto.PublicKey{}
	var all []crypto.PublicKey
	for _, key := range set.Keys {
		parsed, err := key.publicKey()
		if err != nil {
			continue
		}
		all = append(all, parsed)
		if key.Kid != "" {
			byKeyID[key.Kid] = append(byKeyID[key.Kid], parsed)
		}
	}
	if len(all) == 0 {
		return nil, nil, errors.New("carries no key this build can read")
	}
	return byKeyID, all, nil
}

func (k jwk) publicKey() (crypto.PublicKey, error) {
	switch k.Kty {
	case "RSA":
		n, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(k.N, "="))
		if err != nil {
			return nil, err
		}
		e, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(k.E, "="))
		if err != nil {
			return nil, err
		}
		if len(n) == 0 || len(e) == 0 || len(e) > 8 {
			return nil, errors.New("malformed RSA key")
		}
		return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}, nil
	case "EC":
		curve, ok := jwkCurves[k.Crv]
		if !ok {
			return nil, fmt.Errorf("unsupported curve %q", k.Crv)
		}
		x, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(k.X, "="))
		if err != nil {
			return nil, err
		}
		y, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(k.Y, "="))
		if err != nil {
			return nil, err
		}
		// Rebuilt through the uncompressed-point encoding rather than by
		// setting the coordinates: that is the constructor that checks the
		// point is on the curve, and a key that is not would make every
		// verification under it meaningless rather than failed.
		size := (curve.Params().BitSize + 7) / 8
		if len(x) != size || len(y) != size {
			return nil, fmt.Errorf("the EC coordinates are %d and %d octets, expected %d each",
				len(x), len(y), size)
		}
		point := make([]byte, 0, 1+2*size)
		point = append(point, 4)
		point = append(point, x...)
		point = append(point, y...)
		return ecdsa.ParseUncompressedPublicKey(curve, point)
	default:
		// A key set may publish the signing certificate instead of the
		// parameters; some Verifiers do both.
		if len(k.X5c) > 0 {
			der, err := base64.StdEncoding.DecodeString(k.X5c[0])
			if err != nil {
				return nil, err
			}
			cert, err := x509.ParseCertificate(der)
			if err != nil {
				return nil, err
			}
			return cert.PublicKey, nil
		}
		return nil, fmt.Errorf("unsupported key type %q", k.Kty)
	}
}

// eatToken is a verified token: the claims it carries and the header fields
// that decided how it was checked.
type eatToken struct {
	Algorithm string
	KeyID     string
	Claims    map[string]any
}

// verifyEAT authenticates an Attestation Results token and returns its claims.
//
// Everything it checks is configuration — the issuer, the audience, the keys,
// the algorithm allow-list, the freshness window. Nothing in it knows which
// Verifier produced the token, which is the property that makes a Verifier
// swappable without a code change.
func verifyEAT(ctx context.Context, token string, cfg TokenVerification, now time.Time) (*eatToken, error) {
	switch format := cfg.Format; format {
	case "", TokenJWT:
	case TokenCWT:
		return nil, errors.New("the CWT serialisation is not implemented by this build; " +
			"configure a Verifier that emits the JWT serialisation of its EAT")
	default:
		return nil, fmt.Errorf("unknown token format %q, expected %q or %q", format, TokenJWT, TokenCWT)
	}
	if cfg.Issuer == "" {
		return nil, errors.New("no expected issuer is configured: a token whose `iss` is unchecked is " +
			"a token from whoever the key source happens to serve")
	}
	if cfg.Keys == nil {
		return nil, errors.New("no verification keys are configured")
	}

	segments := strings.Split(strings.TrimSpace(token), ".")
	if len(segments) != 3 {
		return nil, errors.New("the token is not a compact JWS of exactly 3 segments")
	}
	headerOctets, err := base64.RawURLEncoding.DecodeString(segments[0])
	if err != nil {
		return nil, fmt.Errorf("the token's protected header is not base64url: %w", err)
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := json.Unmarshal(headerOctets, &header); err != nil {
		return nil, fmt.Errorf("the token's protected header is not JSON: %w", err)
	}
	allowed := cfg.Algorithms
	if len(allowed) == 0 {
		allowed = defaultEATAlgorithms
	}
	if !slices.Contains(allowed, header.Alg) {
		return nil, fmt.Errorf("the token is signed with %q, which is not in the configured allow-list %v",
			header.Alg, allowed)
	}

	signature, err := base64.RawURLEncoding.DecodeString(segments[2])
	if err != nil {
		return nil, fmt.Errorf("the token's signature is not base64url: %w", err)
	}
	keys, err := cfg.Keys.KeysFor(ctx, header.Kid)
	if err != nil {
		return nil, err
	}
	signed := []byte(segments[0] + "." + segments[1])
	if err := verifySignature(header.Alg, keys, signed, signature); err != nil {
		return nil, err
	}

	payload, err := base64.RawURLEncoding.DecodeString(segments[1])
	if err != nil {
		return nil, fmt.Errorf("the token's payload is not base64url: %w", err)
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, fmt.Errorf("the token's payload is not a JSON object: %w", err)
	}
	if err := checkRegisteredClaims(claims, cfg, now); err != nil {
		return nil, err
	}
	return &eatToken{Algorithm: header.Alg, KeyID: header.Kid, Claims: claims}, nil
}

// checkRegisteredClaims holds the token to the issuer, audience and time
// window the configuration states.
func checkRegisteredClaims(claims map[string]any, cfg TokenVerification, now time.Time) error {
	if issuer, _ := claims["iss"].(string); issuer != cfg.Issuer {
		return fmt.Errorf("the token's issuer is %q, and the configured Verifier is %q", issuer, cfg.Issuer)
	}
	if cfg.Audience != "" && !audienceContains(claims["aud"], cfg.Audience) {
		return fmt.Errorf("the token's audience does not include %q", cfg.Audience)
	}

	skew := cfg.ClockSkew
	if skew == 0 {
		skew = DefaultEATClockSkew
	}
	expiry, hasExpiry := numericDate(claims["exp"])
	if hasExpiry && now.After(expiry.Add(skew)) {
		return fmt.Errorf("the token expired at %s", expiry.UTC().Format(time.RFC3339))
	}
	if notBefore, ok := numericDate(claims["nbf"]); ok && now.Add(skew).Before(notBefore) {
		return fmt.Errorf("the token is not valid before %s", notBefore.UTC().Format(time.RFC3339))
	}
	issuedAt, hasIssuedAt := numericDate(claims["iat"])
	if hasIssuedAt && now.Add(skew).Before(issuedAt) {
		return fmt.Errorf("the token is dated %s, which is in the future", issuedAt.UTC().Format(time.RFC3339))
	}
	if cfg.MaxTokenAge > 0 {
		if !hasIssuedAt {
			return errors.New("the token carries no `iat`, so the configured maximum age cannot be applied")
		}
		if age := now.Sub(issuedAt); age > cfg.MaxTokenAge+skew {
			return fmt.Errorf("the token is %s old, beyond the configured %s", age.Truncate(time.Second),
				cfg.MaxTokenAge)
		}
	}
	// A token with neither an expiry nor a configured window never goes
	// stale, and a Verifier's verdict does: a TCB status is true of a moment.
	// Rather than accept one forever, the configuration is asked to say how
	// long it is good for.
	if !hasExpiry && cfg.MaxTokenAge == 0 {
		return errors.New("the token carries no `exp`, and TokenVerification.MaxTokenAge is unset: " +
			"a result with no expiry and no configured window would be accepted forever")
	}
	return nil
}

func audienceContains(value any, want string) bool {
	switch audience := value.(type) {
	case string:
		return audience == want
	case []any:
		for _, entry := range audience {
			if text, ok := entry.(string); ok && text == want {
				return true
			}
		}
	}
	return false
}

// numericDate reads a JWT NumericDate. JSON numbers arrive as float64, and a
// few Verifiers spell them as strings.
func numericDate(value any) (time.Time, bool) {
	switch date := value.(type) {
	case float64:
		return time.Unix(int64(date), 0), true
	case json.Number:
		seconds, err := date.Int64()
		if err != nil {
			return time.Time{}, false
		}
		return time.Unix(seconds, 0), true
	default:
		return time.Time{}, false
	}
}

// jwkCurves are the EC curves a key set may name, by their JOSE spelling.
var jwkCurves = map[string]elliptic.Curve{
	"P-256": elliptic.P256(),
	"P-384": elliptic.P384(),
	"P-521": elliptic.P521(),
}

// verifySignature checks the signature under every candidate key, and reports
// a failure only when none of them produced it.
func verifySignature(alg string, keys []crypto.PublicKey, signed, signature []byte) error {
	// The allow-list is configuration, so a configuration may put anything in
	// it; the family and the digest are read off a name of the JOSE shape.
	if len(alg) != 5 {
		return fmt.Errorf("unsupported algorithm %q", alg)
	}
	hash, digest := digestFor(alg, signed)
	var lastErr error
	for _, key := range keys {
		err := verifyUnderKey(alg, key, hash, digest, signature)
		if err == nil {
			return nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = errors.New("no verification key was offered")
	}
	return fmt.Errorf("the token's signature does not verify under any configured key: %w", lastErr)
}

func digestFor(alg string, signed []byte) (crypto.Hash, []byte) {
	switch alg[2:] {
	case "384":
		sum := sha512.Sum384(signed)
		return crypto.SHA384, sum[:]
	case "512":
		sum := sha512.Sum512(signed)
		return crypto.SHA512, sum[:]
	default:
		sum := sha256.Sum256(signed)
		return crypto.SHA256, sum[:]
	}
}

func verifyUnderKey(alg string, key crypto.PublicKey, hash crypto.Hash, digest, signature []byte) error {
	switch alg[:2] {
	case "RS":
		rsaKey, ok := key.(*rsa.PublicKey)
		if !ok {
			return fmt.Errorf("%s needs an RSA key, and the key source offered %T", alg, key)
		}
		return rsa.VerifyPKCS1v15(rsaKey, hash, digest, signature)
	case "PS":
		rsaKey, ok := key.(*rsa.PublicKey)
		if !ok {
			return fmt.Errorf("%s needs an RSA key, and the key source offered %T", alg, key)
		}
		return rsa.VerifyPSS(rsaKey, hash, digest, signature,
			&rsa.PSSOptions{SaltLength: rsa.PSSSaltLengthEqualsHash, Hash: hash})
	case "ES":
		ecKey, ok := key.(*ecdsa.PublicKey)
		if !ok {
			return fmt.Errorf("%s needs an EC key, and the key source offered %T", alg, key)
		}
		// JWS spells an ECDSA signature as the fixed-width r‖s of the curve,
		// never as the ASN.1 sequence x509 uses.
		if len(signature)%2 != 0 {
			return errors.New("the ECDSA signature is not an even number of octets")
		}
		half := len(signature) / 2
		r := new(big.Int).SetBytes(signature[:half])
		s := new(big.Int).SetBytes(signature[half:])
		if !ecdsa.Verify(ecKey, digest, r, s) {
			return errors.New("the ECDSA signature does not verify")
		}
		return nil
	default:
		return fmt.Errorf("unsupported algorithm %q", alg)
	}
}
