package config_test

import (
	"path/filepath"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

// exampleConfig is the file the JSON schema is documented by. Loading it here
// keeps the Go types and schemas/gatekeeper-config.schema.json from drifting
// apart: a field added to one and not the other fails this test.
const exampleConfig = "../../../../schemas/examples/gatekeeper-config.example.yaml"

func TestTheDocumentedExampleConfigLoads(t *testing.T) {
	cfg, err := config.Load(config.Options{Path: filepath.FromSlash(exampleConfig), Environ: []string{}})
	if err != nil {
		t.Fatalf("loading %s: %v", exampleConfig, err)
	}

	if len(cfg.TrustedRoots) != 2 {
		t.Errorf("trustedRoots = %d, want the two roots of the example", len(cfg.TrustedRoots))
	}
	if len(cfg.Endpoints) != 2 {
		t.Fatalf("endpoints = %d, want the two endpoints of the example", len(cfg.Endpoints))
	}

	llama, ok := cfg.Endpoint("llama-33-70b")
	if !ok {
		t.Fatal("the example's llama-33-70b endpoint is missing")
	}
	// The example pins one canonical and one hex digest; both must survive.
	if len(llama.TrustedEvidence) != 2 {
		t.Errorf("trustedEvidence = %v, want two pins", llama.TrustedEvidence)
	}
	if got := cfg.Tuning(llama).FailMode; got != config.FailClosed {
		t.Errorf("failMode = %q, want %q from the example's defaults", got, config.FailClosed)
	}

	qwen, _ := cfg.Endpoint("qwen25-72b")
	if got := cfg.Tuning(qwen).FailMode; got != config.FailOpen {
		t.Errorf("qwen failMode = %q, want the endpoint's explicit %q", got, config.FailOpen)
	}
}
