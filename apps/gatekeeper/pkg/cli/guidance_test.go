package cli_test

import (
	"context"
	"strings"
	"testing"
	"time"
)

// invented is every spelling of a configuration path that is written into a
// string rather than resolved.
//
// `config.DefaultPath()` is `os.UserConfigDir()`, so the directory differs on
// every platform: `~/.config` on Linux, `~/Library/Application Support` on
// macOS, `%AppData%` on Windows. A message that names one of them is simply
// false on the other two — which is how the console came to promise a macOS
// tester a file that was never written there (SUP-300 item 2).
var invented = []string{
	"~/.config",
	"$HOME/.config",
	"Library/Application Support",
	"AppData",
	"/Users/",
	`C:\`,
}

// TestTheSetupSequenceChainsStepToStep walks the console's numbered steps in a
// terminal and holds every one of them to the same contract: say what happened,
// name the file it happened in, and print the next step's command.
//
// The two surfaces are chained by this test and by `setup-commands.spec.ts` at
// the other end. A reader who starts in the browser and finishes in a terminal
// has to be walked along one path, not handed back to a quick-start they have
// to re-read to find their place (SUP-300 item 1).
func TestTheSetupSequenceChainsStepToStep(t *testing.T) {
	h := newHarness(t)

	init := h.mustRun("init")
	assertChains(t, "init", init.stdout, h.configPath,
		"gatekeeper endpoint add router --upstream https://<host> --listen 127.0.0.1:8787")

	add := h.mustRun("endpoint", "add", "router",
		"--upstream", "https://api.router.example.com", "--listen", "127.0.0.1:8787")
	assertChains(t, "endpoint add", add.stdout, h.configPath,
		"gatekeeper endpoint trust add router --from-upstream")
	golden(t, "endpoint-add", add.stdout)

	// Asking "what is left?" mid-sequence has to answer with the command that
	// finishes it, not with a circular "validate again". `config validate` names
	// the endpoint from the document position the problem is addressed to.
	unfinished := h.run("config", "validate")
	assertChains(t, "config validate (unpinned)", unfinished.stdout, h.configPath,
		"gatekeeper endpoint trust add router --from-upstream")
	golden(t, "validate-unpinned-endpoint", unfinished.stdout)

	pin := h.mustRun("endpoint", "trust", "add", "router", pinA)
	assertChains(t, "endpoint trust add", pin.stdout, h.configPath, "gatekeeper run")
	golden(t, "endpoint-trust-add", pin.stdout)

	ready := h.mustRun("config", "validate")
	assertChains(t, "config validate", ready.stdout, h.configPath, "gatekeeper run")
}

// assertChains is the three questions every user-facing message answers.
func assertChains(t *testing.T, command, output, path, next string) {
	t.Helper()
	if strings.TrimSpace(output) == "" {
		t.Fatalf("%s printed nothing", command)
	}
	if !strings.Contains(output, "$TMP/config.yaml") {
		t.Errorf("%s does not name the file it wrote (resolved: %s):\n%s", command, path, output)
	}
	if !strings.Contains(output, next) {
		t.Errorf("%s does not name its next step %q:\n%s", command, next, output)
	}
	assertInventsNoPath(t, command, output)
}

func assertInventsNoPath(t *testing.T, command, output string) {
	t.Helper()
	for _, literal := range invented {
		if strings.Contains(output, literal) {
			t.Errorf("%s hardcodes the configuration path %q instead of printing the resolved one:\n%s",
				command, literal, output)
		}
	}
}

// TestNoCommandInventsAConfigurationPath is the regression guard for the whole
// surface rather than for the three commands that happened to be wrong. The
// harness resolves the config into a temp directory, so any `~/.config` in the
// output can only have come from a string literal.
func TestNoCommandInventsAConfigurationPath(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}
	h.env.Verifier = &fakeVerifier{report: admittedReport()}

	for _, args := range [][]string{
		{"init"},
		{"init", "--force"},
		{"--help"},
		{"config", "path"},
		{"config", "validate"},
		{"endpoint", "list"},
		{"endpoint", "add", "second", "--upstream", "https://second.example", "--listen", "127.0.0.1:8788"},
		{"endpoint", "trust", "list", "llama-33-70b"},
		{"endpoint", "trust", "add", "llama-33-70b", pinB},
		{"endpoint", "rm", "second"},
		{"trust", "roots", "list"},
		{"trust", "measurements", "list"},
		{"policy", "list"},
		{"status"},
		{"verify", "llama-33-70b"},
		{"version"},
		// The error paths too: a message that is wrong about where the file is
		// sends the reader to edit a file that does not exist.
		{"endpoint", "trust", "list", "nope"},
		{"endpoint", "rm", "nope"},
	} {
		got := h.run(args...)
		name := "gatekeeper " + strings.Join(args, " ")
		assertInventsNoPath(t, name, got.stdout)
		assertInventsNoPath(t, name, got.stderr)
	}
}

// TestInitDoesNotLectureAboutTrustRootsOnItsSuccessPath pins the fix for the
// screenshot the test group sent: the whole of `gatekeeper init`'s output was a
// note about `trust roots add`, a command 99% of readers never run, and nothing
// in it confirmed that a file had been written or said what to do next.
//
// The explanation itself is not lost — it is in the starter file the command
// just wrote, as a comment on the `trustedRoots: []` it is about, and in
// `trust roots list`, which is where someone asking the question has gone.
func TestInitDoesNotLectureAboutTrustRootsOnItsSuccessPath(t *testing.T) {
	h := newHarness(t)

	created := h.mustRun("init")
	if strings.Contains(created.stdout, "trust roots") {
		t.Errorf("init still explains trust roots on the success path:\n%s", created.stdout)
	}
	if !strings.Contains(h.config(), "gatekeeper trust roots add") {
		t.Error("the starter file no longer carries the explanation init stopped printing")
	}

	again := h.mustRun("init")
	assertChains(t, "init (second run)", again.stdout, h.configPath, "gatekeeper config validate")
	if !strings.Contains(again.stdout, "already exists") {
		t.Errorf("stdout = %q, want it to say nothing was written", again.stdout)
	}
	golden(t, "init-already-exists", again.stdout)

	// And it is said where it is asked for, with the default anchor named: an
	// empty list is the finished state, not a broken one (SUP-253).
	roots := h.mustRun("trust", "roots", "list")
	golden(t, "trust-roots-list-empty", roots.stdout)
	for _, want := range []string{"needs none", "attestedRoots", "gatekeeper trust roots add"} {
		if !strings.Contains(roots.stdout, want) {
			t.Errorf("`trust roots list` on an empty list does not mention %q:\n%s", want, roots.stdout)
		}
	}
}

// TestHeadlessRunSaysWhatIsListeningAndWhereToPointAClient covers the last step
// of the sequence. `gatekeeper run --headless` printed nothing at all until its
// first event, so the one step whose success the reader most needs confirmed
// was the one step that confirmed nothing.
func TestHeadlessRunSaysWhatIsListeningAndWhereToPointAClient(t *testing.T) {
	h := configured(t)
	h.env.Supervisor = &fakeSupervisor{snapshot: liveSnapshot()}

	ctx, cancel := context.WithTimeout(t.Context(), 300*time.Millisecond)
	defer cancel()

	got := h.runCtx(ctx, "run", "--headless")
	for _, want := range []string{
		"gatekeeper running, from $TMP/config.yaml",
		"llama-33-70b",
		"http://127.0.0.1:8443/v1",
		"https://llama-33-70b.tee.swarm.cloud",
		"Press Ctrl-C to stop.",
	} {
		if !strings.Contains(got.stderr, want) {
			t.Errorf("the startup banner does not mention %q:\n%s", want, got.stderr)
		}
	}
	assertInventsNoPath(t, "run --headless", got.stderr)
	golden(t, "run-headless-banner", got.stderr)
}
