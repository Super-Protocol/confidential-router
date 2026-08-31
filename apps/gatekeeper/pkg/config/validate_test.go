package config_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// mustParse decodes a config document, failing the test if it does not parse.
func mustParse(t *testing.T, yaml string) *config.Config {
	t.Helper()
	cfg, err := config.Parse(strings.NewReader(yaml), "config.yaml")
	if err != nil {
		t.Fatalf("parsing: %v", err)
	}
	return cfg
}

func TestValidateReportsEveryProblemWithItsPath(t *testing.T) {
	tests := []struct {
		name string
		yaml string
		want []string // substrings that must appear in the error
	}{
		{
			name: "wrong schema version",
			yaml: "version: 2\n" + rootsAndOneEndpoint,
			want: []string{"version: must be 1, got 2"},
		},
		{
			name: "no trusted roots",
			yaml: "version: 1\ntrustedRoots: []\n" + oneEndpoint,
			want: []string{"trustedRoots: at least one trusted root is required"},
		},
		{
			name: "no endpoints",
			yaml: "version: 1\n" + roots + "endpoints: []\n",
			want: []string{"endpoints: at least one endpoint is required"},
		},
		{
			name: "endpoint without pins",
			yaml: "version: 1\n" + roots + `endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence: []
`,
			want: []string{"endpoints[0].trustedEvidence: at least one pinned evidenceDigest is required"},
		},
		{
			name: "malformed pin, listen and upstream",
			yaml: "version: 1\n" + roots + `endpoints:
  - name: llama
    listen: llama.tee.swarm.cloud
    upstream: http://llama.tee.swarm.cloud/v1
    trustedEvidence:
      - not-a-digest
`,
			want: []string{
				"endpoints[0].listen: must be host:port",
				"endpoints[0].upstream: must be an https:// base URL",
				"endpoints[0].trustedEvidence[0]: is not an evidenceDigest",
			},
		},
		{
			name: "duplicate endpoint names and listen addresses",
			yaml: "version: 1\n" + roots + `endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://a.tee.swarm.cloud
    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://b.tee.swarm.cloud
    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]
`,
			want: []string{
				`endpoints[1].name: duplicate name "llama"`,
				`endpoints[1].listen: duplicate listen address`,
			},
		},
		{
			name: "duplicate pin on one endpoint",
			yaml: "version: 1\n" + roots + `endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://a.tee.swarm.cloud
    trustedEvidence:
      - sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE
      - sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE
`,
			want: []string{"endpoints[0].trustedEvidence[1]: duplicate pin"},
		},
		{
			name: "root with neither pem nor pemFile",
			yaml: "version: 1\ntrustedRoots:\n  - name: prod\n" + oneEndpoint,
			want: []string{"trustedRoots[0]: one of pem or pemFile is required"},
		},
		{
			name: "root with both pem and pemFile",
			yaml: `version: 1
trustedRoots:
  - name: prod
    pem: |
      -----BEGIN CERTIFICATE-----
      AA==
      -----END CERTIFICATE-----
    pemFile: ./root.pem
` + oneEndpoint,
			want: []string{"trustedRoots[0]: set either pem or pemFile, not both"},
		},
		{
			name: "policy that is not a rego file",
			yaml: "version: 1\n" + roots + "policies:\n  - name: images\n    file: ./images.yaml\n" + oneEndpoint,
			want: []string{"policies[0].file: must point at a .rego module"},
		},
		{
			name: "bad enums",
			yaml: "version: 1\n" + roots + "log:\n  level: verbose\n  format: xml\ndefaults:\n  failMode: ajar\n" + oneEndpoint,
			want: []string{
				"log.level: must be one of debug, info, warn, error",
				"log.format: must be one of text, json",
				"defaults.failMode: must be one of closed, open",
			},
		},
		{
			name: "uppercase endpoint name",
			yaml: "version: 1\n" + roots + `endpoints:
  - name: Llama
    listen: 127.0.0.1:8443
    upstream: https://a.tee.swarm.cloud
    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]
`,
			want: []string{"endpoints[0].name: must be lower-case letters"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg, err := config.Parse(strings.NewReader(tc.yaml), "config.yaml")
			if err != nil {
				t.Fatalf("Parse: %v", err)
			}
			err = cfg.Validate()
			if err == nil {
				t.Fatal("Validate returned nil, want a validation error")
			}
			var validation *config.ValidationError
			if !asValidationError(err, &validation) {
				t.Fatalf("err is %T, want *config.ValidationError", err)
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error does not mention %q\ngot:\n%s", want, err)
				}
			}
		})
	}
}

func TestValidateAcceptsAllThreeDigestSpellings(t *testing.T) {
	yaml := "version: 1\n" + roots + `endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://a.tee.swarm.cloud/
    trustedEvidence:
      - sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE
      - sha256:6b1f0d8c3a2e9f4b7c1d5e6a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c
      - AB1F0D8C3A2E9F4B7C1D5E6A8B9C0D1E2F3A4B5C6D7E8F9A0B1C2D3E4F5A6B7C
`
	cfg, err := config.Parse(strings.NewReader(yaml), "config.yaml")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
}

func TestValidateRejectsBadDuration(t *testing.T) {
	_, err := config.Parse(strings.NewReader("version: 1\ndefaults:\n  reattestInterval: 5 minutes\n"), "config.yaml")
	if err == nil || !strings.Contains(err.Error(), "not a duration") {
		t.Fatalf("err = %v, want a duration format error", err)
	}
}

func asValidationError(err error, target **config.ValidationError) bool {
	v, ok := err.(*config.ValidationError) //nolint:errorlint // Validate returns the concrete type
	if ok {
		*target = v
	}
	return ok
}

const roots = `trustedRoots:
  - name: prod
    pem: |
      -----BEGIN CERTIFICATE-----
      AA==
      -----END CERTIFICATE-----
`

const oneEndpoint = `endpoints:
  - name: llama
    listen: 127.0.0.1:8443
    upstream: https://llama.tee.swarm.cloud
    trustedEvidence: [sha256/axNB3kHhDGtF3v2P8lY6pWbBqzX0cR9kT1uJm4sN7dE]
`

const rootsAndOneEndpoint = roots + oneEndpoint

func TestValidateChecksTheEnvAndFlagLayers(t *testing.T) {
	path := writeConfig(t, baseConfig)

	_, err := config.Load(config.Options{Path: path, Environ: []string{"CR_GATEKEEPER_FAIL_MODE=opne"}})
	if err == nil || !strings.Contains(err.Error(), "$CR_GATEKEEPER_FAIL_MODE: must be one of closed, open") {
		t.Fatalf("err = %v, want the environment variable to be named as the offender", err)
	}

	_, err = config.Load(config.Options{
		Path:    path,
		Environ: []string{"CR_GATEKEEPER_ENDPOINT_LLAMA_MAX_BUNDLE_AGE=0s"},
	})
	if err == nil || !strings.Contains(err.Error(), "$CR_GATEKEEPER_ENDPOINT_LLAMA_MAX_BUNDLE_AGE: must be greater than zero") {
		t.Fatalf("err = %v, want the per-endpoint variable to be rejected", err)
	}

	_, err = config.Load(config.Options{
		Path:      path,
		Environ:   []string{},
		Overrides: config.Overrides{FailMode: "ajar", InitialTimeout: "0s"},
	})
	if err == nil {
		t.Fatal("Load accepted invalid command-line overrides")
	}
	for _, want := range []string{"-fail-mode: must be one of", "-initial-timeout: must be greater than zero"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %v, want it to mention %q", err, want)
		}
	}
}

func TestValidateEditableAcceptsAnUnfinishedConfig(t *testing.T) {
	// What `gatekeeper init` writes: nothing wrong, nothing finished.
	cfg := mustParse(t, `version: 1
trustedRoots: []
endpoints: []
`)
	if err := cfg.ValidateEditable(); err != nil {
		t.Errorf("ValidateEditable: %v, want nil — the editing commands have to be able to open this", err)
	}

	err := cfg.Validate()
	if err == nil {
		t.Fatal("Validate accepted a config that cannot run")
	}
	var invalid *config.ValidationError
	if !errors.As(err, &invalid) {
		t.Fatalf("Validate returned %T, want *config.ValidationError", err)
	}
	if len(invalid.Errors) != 2 {
		t.Fatalf("problems = %v, want two", invalid.Errors)
	}
	for _, fe := range invalid.Errors {
		if !fe.Incomplete {
			t.Errorf("%s is reported as an error, not as unfinished setup", fe.Path)
		}
	}
}

func TestValidateEditableStillRejectsWrongValues(t *testing.T) {
	// Incompleteness is forgiven; a malformed value is not, or the editing
	// commands would happily write a config that can never load.
	cfg := mustParse(t, `version: 1
trustedRoots: []
endpoints:
  - name: llama
    listen: nonsense
    upstream: https://llama.example
    trustedEvidence: []
`)
	err := cfg.ValidateEditable()
	if err == nil {
		t.Fatal("ValidateEditable accepted a malformed listen address")
	}
	var invalid *config.ValidationError
	if !errors.As(err, &invalid) {
		t.Fatalf("got %T, want *config.ValidationError", err)
	}
	if len(invalid.Errors) != 1 || invalid.Errors[0].Path != "endpoints[0].listen" {
		t.Errorf("problems = %v, want only the listen address", invalid.Errors)
	}
}

func TestValidateKeepsTheAdminAPILocal(t *testing.T) {
	// The admin API answers with verdicts, digests and hostnames. Binding it to
	// a routable address would publish the user's trust decisions to the
	// network, so it is refused rather than warned about.
	for _, listen := range []string{
		"unix:/run/user/1000/gatekeeper.sock", "127.0.0.1:9465", "localhost:9465", "[::1]:9465",
	} {
		cfg := mustParse(t, "version: 1\n"+rootsAndOneEndpoint+"admin:\n  listen: \""+listen+"\"\n")
		if err := cfg.Validate(); err != nil {
			t.Errorf("admin.listen %q: %v", listen, err)
		}
	}
	for _, listen := range []string{"0.0.0.0:9465", "10.0.0.4:9465", "gatekeeper.internal:9465", "unix:"} {
		cfg := mustParse(t, "version: 1\n"+rootsAndOneEndpoint+"admin:\n  listen: \""+listen+"\"\n")
		err := cfg.Validate()
		if err == nil {
			t.Errorf("admin.listen %q was accepted", listen)
			continue
		}
		if !strings.Contains(err.Error(), "admin.listen") {
			t.Errorf("admin.listen %q: error does not name the field: %v", listen, err)
		}
	}
}

func TestValidateRequiresAnAuditFile(t *testing.T) {
	cfg := mustParse(t, "version: 1\n"+rootsAndOneEndpoint+"audit:\n  file: \"\"\n")
	err := cfg.Validate()
	if err == nil || !strings.Contains(err.Error(), "audit.file") {
		t.Fatalf("err = %v, want audit.file to be required", err)
	}

	ok := mustParse(t, "version: 1\n"+rootsAndOneEndpoint+"audit:\n  file: ./audit.jsonl\n")
	if err := ok.Validate(); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if ok.Audit == nil || ok.Audit.File != "./audit.jsonl" {
		t.Errorf("Audit = %+v, want the configured path", ok.Audit)
	}
}

func TestAdminUnixReportsTheSocketPath(t *testing.T) {
	cfg := mustParse(t, "version: 1\n"+rootsAndOneEndpoint+"admin:\n  listen: unix:/tmp/gk.sock\n")
	path, isUnix := cfg.Admin.Unix()
	if !isUnix || path != "/tmp/gk.sock" {
		t.Errorf("Unix() = %q, %v, want the socket path", path, isUnix)
	}
	tcp := mustParse(t, "version: 1\n"+rootsAndOneEndpoint+"admin:\n  listen: 127.0.0.1:9465\n")
	if _, isUnix := tcp.Admin.Unix(); isUnix {
		t.Error("a host:port listener was reported as a unix socket")
	}
}
