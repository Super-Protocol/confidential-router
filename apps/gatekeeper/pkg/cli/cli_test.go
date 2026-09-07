package cli_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
)

func TestBareInvocationPrintsHelpRatherThanStartingADaemon(t *testing.T) {
	h := configured(t)
	got := h.mustRun()
	// An accidental Enter must not open a listening socket; `run` has a name.
	if !strings.Contains(got.stdout, "Available Commands:") {
		t.Errorf("stdout = %q, want the help text", got.stdout)
	}
	for _, command := range []string{"init", "run", "verify", "trust", "endpoint", "policy", "status", "config"} {
		if !strings.Contains(got.stdout, command) {
			t.Errorf("help does not mention %q", command)
		}
	}
}

func TestVersionIsAvailableAsTextAndJSON(t *testing.T) {
	h := newHarness(t)

	// version answers before any config exists — it is what a bug report asks
	// for first.
	text := h.mustRun("version")
	if !strings.HasPrefix(text.stdout, "gatekeeper ") {
		t.Errorf("stdout = %q, want a build identity line", text.stdout)
	}

	var info struct {
		Version   string `json:"version"`
		GoVersion string `json:"goVersion"`
		Platform  string `json:"platform"`
	}
	if err := json.Unmarshal([]byte(h.mustRun("version", "--json").stdout), &info); err != nil {
		t.Fatalf("--json is not valid JSON: %v", err)
	}
	if info.Version == "" || info.GoVersion == "" || info.Platform == "" {
		t.Errorf("version JSON is missing fields: %+v", info)
	}
}

func TestUnknownCommandsAndFlagsAreUsageErrors(t *testing.T) {
	h := configured(t)
	for _, args := range [][]string{
		{"nonsense"},
		{"endpoint", "list", "--nonsense"},
		{"trust", "roots", "add"},
	} {
		got := h.run(args...)
		if got.code != cli.ExitUsage {
			t.Errorf("%v: exit = %d, want %d", args, got.code, cli.ExitUsage)
		}
		if !strings.Contains(got.stderr, "--help") {
			t.Errorf("%v: stderr = %q, want a pointer to the right help page", args, got.stderr)
		}
	}
}

func TestEveryReadCommandSpeaksJSON(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}
	h.env.Verifier = &fakeVerifier{report: admittedReport()}
	bundle := h.write("bundle.json", bundleJSON(t, "llama-33-70b.tee.swarm.cloud", pinA, rootPEM(t)))

	// --json is the contract for scripting the gatekeeper; a read command that
	// silently lacks it is a hole in that contract.
	commands := [][]string{
		{"version", "--json"},
		{"config", "path", "--json"},
		{"trust", "roots", "list", "--json"},
		{"endpoint", "list", "--json"},
		{"endpoint", "trust", "list", "llama-33-70b", "--json"},
		{"endpoint", "discover", "llama-33-70b", "--json"},
		{"policy", "list", "--json"},
		{"policy", "test", bundle, "--json"},
		{"status", "--json"},
		{"verify", "llama-33-70b", "--json"},
	}
	for _, args := range commands {
		got := h.run(args...)
		if got.code != cli.ExitOK && got.code != cli.ExitDenied {
			t.Errorf("%v: exit = %d (stderr: %s)", args, got.code, got.stderr)
			continue
		}
		var parsed any
		// Parsing the whole of stdout is the assertion that matters: any advice
		// or warning printed alongside the document would break it, which is
		// why those go to stderr.
		if err := json.Unmarshal([]byte(got.stdout), &parsed); err != nil {
			t.Errorf("%v: stdout is not JSON: %v\n%s", args, err, got.stdout)
		}
	}
}

func TestConfigValidateJSONSeparatesInvalidFromIncomplete(t *testing.T) {
	h := newHarness(t)
	h.mustRun("init")

	var result struct {
		Valid    bool `json:"valid"`
		Ready    bool `json:"ready"`
		Problems []struct {
			Path       string `json:"path"`
			Incomplete bool   `json:"incomplete"`
		} `json:"problems"`
	}
	got := h.run("config", "validate", "--json")
	if err := json.Unmarshal([]byte(got.stdout), &result); err != nil {
		t.Fatalf("not JSON: %v\n%s", err, got.stdout)
	}
	if !result.Valid || result.Ready {
		t.Errorf("valid=%v ready=%v, want a valid but unfinished config", result.Valid, result.Ready)
	}
	// Only the endpoint list: with the attested-root anchor on by default, a
	// config with no manually pinned roots is finished.
	if len(result.Problems) != 1 {
		t.Fatalf("problems = %+v, want one", result.Problems)
	}
	for _, problem := range result.Problems {
		if !problem.Incomplete {
			t.Errorf("%s is reported as an error, not as unfinished setup", problem.Path)
		}
	}
}

func TestUsageHintsPointAtTheRightHelpPage(t *testing.T) {
	h := configured(t)
	cases := map[string]string{
		"gatekeeper --help":               "bogus",
		"gatekeeper endpoint list --help": "endpoint list --nonsense",
	}
	for want, line := range cases {
		got := h.run(strings.Fields(line)...)
		if got.code != cli.ExitUsage {
			t.Errorf("%q: exit = %d, want %d", line, got.code, cli.ExitUsage)
		}
		if !strings.Contains(got.stderr, "Run '"+want+"' for usage.") {
			t.Errorf("%q: stderr = %q, want a hint naming %q", line, got.stderr, want)
		}
	}
}
