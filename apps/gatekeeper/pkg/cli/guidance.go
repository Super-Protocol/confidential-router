package cli

import (
	"fmt"
	"io"
)

// Every user-facing message this CLI prints answers three questions: what
// happened, where it happened, and what to run next (SUP-300).
//
// "Where" is always the path the command actually resolved — never a literal
// one written into a string, because the configuration directory is
// `os.UserConfigDir()` and differs on every platform. The console and the docs
// hold to the other half of the same split: an instruction printed *before* the
// command runs never invents a path, and this output prints the real one after
// the fact.
//
// "What next" is the next step of the console's numbered sequence
// (`apps/router-ui/src/components/gatekeeper/setup-commands.ts`), so a reader who
// started in the browser and a reader who started in a terminal are walked
// along the same path: init → endpoint add → endpoint trust add → run. The two
// example values below are that sequence's, and they are the reason this file
// exists rather than each command spelling its own.
const (
	// exampleEndpoint is the endpoint name every surface uses in an example.
	exampleEndpoint = "router"
	// exampleListen is the loopback address the console, the landing page and
	// the docs all suggest. A gatekeeper on 0.0.0.0 is an open relay.
	exampleListen = "127.0.0.1:8787"
)

// nextStep writes the "what next" block: one line saying why, then the commands
// to run, indented so they can be read — and copied — as commands.
//
// It is a block rather than a sentence because a command buried in prose is a
// command the reader retypes with a typo.
func nextStep(w io.Writer, why string, commands ...string) {
	fmt.Fprintf(w, "\nNext: %s\n", why)
	for _, command := range commands {
		fmt.Fprintf(w, "  %s\n", command)
	}
}

// addEndpointExample is the console's step 3, for the commands that have no
// upstream of their own to name.
func addEndpointExample() string {
	return fmt.Sprintf("gatekeeper endpoint add %s --upstream https://<host> --listen %s",
		exampleEndpoint, exampleListen)
}
