package swarmevidence

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/Super-Protocol/confidential-router/libs/swarm-evidence-go/attestation/attestedroot"
)

// HTTPTokenSource submits a quote to a Verifier's attestation endpoint over
// HTTP and reads the token out of the JSON response.
//
// Every part of the exchange is configuration — the URL, the headers, the
// members of the request body, where the token sits in the response — because
// a Verifier's own API is not standardised even where its result format is.
// Intel Trust Authority takes `{"quote": "<base64>"}` at `/appraise/v2/attest`
// and answers `{"token": "..."}`; another Verifier takes different member
// names at a different path, and that is a different configuration rather than
// a different implementation.
type HTTPTokenSource struct {
	// URL is the Verifier's attestation endpoint.
	URL string
	// Method defaults to POST.
	Method string
	// Headers are sent with the request: the Verifier's API key header, an
	// Accept, whatever it requires.
	Headers map[string]string
	// Body is the request document, as JSON member names to values. A value
	// is sent literally unless it is one of the placeholders below, which are
	// substituted from the quote being appraised:
	//
	//	${quote_base64}        the serialised TeeEvidence, standard base64
	//	${quote_base64url}     the same, unpadded base64url
	//	${tdx_quote_base64}    the raw TD quote inside it, standard base64
	//	${tdx_quote_base64url} the same, unpadded base64url
	//
	// A Verifier that wants the raw TD quote rather than the platform's
	// TeeEvidence wrapper is configured with one of the last two.
	Body map[string]string
	// TokenPath is where the token sits in the JSON response; empty means
	// the `token` member.
	TokenPath ClaimPath
	// Client overrides the HTTP client; nil uses one with a 30s timeout.
	Client *http.Client
}

// maxVerifierResponseBytes bounds the Verifier's answer. A token is a few
// kilobytes, and an unbounded read of a remote endpoint has no place on a
// credential path.
const maxVerifierResponseBytes = 1 << 20

// SubmitsEvidence implements [TokenSource].
//
// True only when the configured request body actually carries the quote. A
// Body of literals alone asks the Verifier about nothing in particular, and
// answering "yes, I submitted this quote" for it would skip the report-data
// check that a token not tied to a quote depends on — a misconfiguration
// would silently become the weaker path rather than an error.
func (s *HTTPTokenSource) SubmitsEvidence() bool { return carriesQuote(s.Body) }

// Token implements [TokenSource].
func (s *HTTPTokenSource) Token(ctx context.Context, evidence []byte) (string, error) {
	if s.URL == "" {
		return "", errors.New("no Verifier URL is configured")
	}
	body, err := s.requestBody(evidence)
	if err != nil {
		return "", err
	}
	method := s.Method
	if method == "" {
		method = http.MethodPost
	}
	request, err := http.NewRequestWithContext(ctx, method, s.URL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	for name, value := range s.Headers {
		request.Header.Set(name, value)
	}

	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("asking %s to appraise the quote: %w", s.URL, err)
	}
	defer func() { _ = response.Body.Close() }()
	document, err := io.ReadAll(io.LimitReader(response.Body, maxVerifierResponseBytes))
	if err != nil {
		return "", fmt.Errorf("reading %s's answer: %w", s.URL, err)
	}
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %s: %s", s.URL, response.Status,
			strings.TrimSpace(string(document)))
	}

	var answer map[string]any
	if err := json.Unmarshal(document, &answer); err != nil {
		return "", fmt.Errorf("%s's answer is not a JSON object: %w", s.URL, err)
	}
	path := s.TokenPath
	if len(path) == 0 {
		path = ClaimPath{"token"}
	}
	value, ok := path.lookup(answer)
	if !ok {
		return "", fmt.Errorf("%s's answer carries no token at %s", s.URL, path)
	}
	token, ok := value.(string)
	if !ok || token == "" {
		return "", fmt.Errorf("%s's token at %s is not a non-empty string", s.URL, path)
	}
	return token, nil
}

// requestBody substitutes the quote into the configured request document.
func (s *HTTPTokenSource) requestBody(evidence []byte) ([]byte, error) {
	members := s.Body
	if len(members) == 0 {
		members = map[string]string{"quote": "${quote_base64}"}
	}
	var rawQuote []byte
	if needsRawQuote(members) {
		structure, err := attestedroot.ReadQuote(evidence)
		if err != nil {
			return nil, err
		}
		if rawQuote = structure.RawQuote; len(rawQuote) == 0 {
			return nil, errors.New("the configured request body asks for the raw TD quote, and this " +
				"evidence carries none")
		}
	}
	substitutions := map[string]string{
		"${quote_base64}":        base64.StdEncoding.EncodeToString(evidence),
		"${quote_base64url}":     base64.RawURLEncoding.EncodeToString(evidence),
		"${tdx_quote_base64}":    base64.StdEncoding.EncodeToString(rawQuote),
		"${tdx_quote_base64url}": base64.RawURLEncoding.EncodeToString(rawQuote),
	}
	document := make(map[string]string, len(members))
	for name, value := range members {
		if replacement, ok := substitutions[value]; ok {
			document[name] = replacement
			continue
		}
		document[name] = value
	}
	return json.Marshal(document)
}

func needsRawQuote(members map[string]string) bool {
	for _, value := range members {
		if value == "${tdx_quote_base64}" || value == "${tdx_quote_base64url}" {
			return true
		}
	}
	return false
}

// quotePlaceholders are the substitutions that put the quote in the request.
var quotePlaceholders = []string{
	"${quote_base64}", "${quote_base64url}", "${tdx_quote_base64}", "${tdx_quote_base64url}",
}

// carriesQuote reports whether a configured request body sends the quote at
// all. A nil body is the default one, which does.
func carriesQuote(members map[string]string) bool {
	if len(members) == 0 {
		return true
	}
	for _, value := range members {
		if slices.Contains(quotePlaceholders, value) {
			return true
		}
	}
	return false
}

// RecordedTokens replays tokens a Verifier issued earlier, keyed by the
// SHA-256 of the evidence they appraise.
//
// It is what CI runs on, and what an air-gapped relying party uses when the
// attester carries the Verifier's token alongside its quote rather than the
// relying party fetching one. Both are replays: nothing in the exchange proves
// the token was issued for the quote beside it, which is why
// [RecordedTokens.SubmitsEvidence] is false and the appraiser then requires
// the token's own report data to be mapped and checked.
type RecordedTokens struct {
	// Tokens are tokens by the lowercase hex SHA-256 of the serialised
	// TeeEvidence they appraise.
	Tokens map[string]string
}

// SubmitsEvidence implements [TokenSource].
func (r *RecordedTokens) SubmitsEvidence() bool { return false }

// Token implements [TokenSource].
func (r *RecordedTokens) Token(_ context.Context, evidence []byte) (string, error) {
	digest := sha256.Sum256(evidence)
	key := hex.EncodeToString(digest[:])
	token, ok := r.Tokens[key]
	if !ok {
		return "", fmt.Errorf("no recorded token appraises the evidence with digest %s", key)
	}
	return token, nil
}
