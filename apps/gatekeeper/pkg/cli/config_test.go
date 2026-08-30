package cli_test

import (
	"os"
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
)

func TestInitWritesAStarterConfigThatIsValidButNotReady(t *testing.T) {
	h := newHarness(t)

	got := h.mustRun("init")
	golden(t, "init", got.stdout)

	// The whole point of the starter file: nothing in it is wrong, and it still
	// cannot run. `config validate` has to say both.
	validated := h.run("config", "validate")
	if validated.code != cli.ExitConfig {
		t.Errorf("config validate exit = %d, want %d", validated.code, cli.ExitConfig)
	}
	golden(t, "validate-starter", validated.stdout)

	if !strings.Contains(h.config(), "trustedRoots: []") {
		t.Error("the starter config does not declare an empty trustedRoots list")
	}
	info, err := os.Stat(h.configPath)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("config mode = %v, want 0600 — it holds trust anchors", perm)
	}
}

func TestInitLeavesAnExistingConfigAlone(t *testing.T) {
	h := newHarness(t)
	h.mustRun("init")
	h.mustRun("trust", "roots", "add", "prod", "--pem-file", h.write("root.pem", rootPEM(t)))
	before := h.config()

	// `init` is exactly the command someone runs twice; the second run must not
	// take their trust anchors with it.
	again := h.mustRun("init")
	if !strings.Contains(again.stdout, "already exists") {
		t.Errorf("stdout = %q, want an explanation that nothing was written", again.stdout)
	}
	if h.config() != before {
		t.Error("a second `init` rewrote the configuration")
	}

	forced := h.mustRun("init", "--force")
	if !strings.Contains(forced.stdout, "Wrote") {
		t.Errorf("stdout = %q, want confirmation of an overwrite", forced.stdout)
	}
	if strings.Contains(h.config(), "name: prod") {
		t.Error("--force did not overwrite the configuration")
	}
}

func TestConfigPathReportsWhichLayerDecided(t *testing.T) {
	h := newHarness(t)
	h.mustRun("init")

	got := h.mustRun("config", "path", "--json")
	golden(t, "config-path-flag", got.stdout)

	// Without --config the environment decides, and `config path` has to say so
	// — three layers can point at three different files.
	h.env.Environ = []string{"CR_GATEKEEPER_CONFIG=" + h.configPath}
	var stdout strings.Builder
	env := h.env
	env.Stdout = &stdout
	if code := cli.Run(t.Context(), env, []string{"config", "path", "--json"}); code != cli.ExitOK {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(stdout.String(), `"source": "$CR_GATEKEEPER_CONFIG"`) {
		t.Errorf("output = %q, want the environment named as the source", stdout.String())
	}
}

func TestCommandsExplainAMissingConfig(t *testing.T) {
	h := newHarness(t)

	for _, args := range [][]string{
		{"config", "validate"},
		{"trust", "roots", "list"},
		{"endpoint", "list"},
	} {
		got := h.run(args...)
		if got.code != cli.ExitConfig {
			t.Errorf("%v: exit = %d, want %d", args, got.code, cli.ExitConfig)
		}
		if !strings.Contains(got.stderr, "gatekeeper init") {
			t.Errorf("%v: stderr = %q, want it to point at `gatekeeper init`", args, got.stderr)
		}
	}
}

func TestValidateReportsEveryProblemAtOnce(t *testing.T) {
	h := newHarness(t)
	h.write("config.yaml", `version: 1
trustedRoots:
  - name: prod
    pemFile: ./root.pem
endpoints:
  - name: Bad Name
    listen: not-a-listen-address
    upstream: http://insecure.example
    trustedEvidence:
      - not-a-digest
log:
  level: shouty
`)
	h.write("root.pem", rootPEM(t))

	got := h.run("config", "validate")
	if got.code != cli.ExitConfig {
		t.Fatalf("exit = %d, want %d", got.code, cli.ExitConfig)
	}
	golden(t, "validate-invalid", got.stdout)
}
