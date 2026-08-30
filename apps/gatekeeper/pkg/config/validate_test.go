package config_test

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

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
