// Command gatekeeper is the user-side attesting proxy for the Confidential
// Router: it verifies an endpoint's published evidence before letting traffic
// through.
//
// Everything lives in pkg/: pkg/cli is the command tree, pkg/tui the dashboard,
// and pkg/{config,trust,policy,status} the core an embedder — a desktop shell,
// another Go program — can use without this binary. This file exists only to
// map the process's exit status onto the CLI's.
package main

import (
	"os"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/cli"
)

func main() {
	os.Exit(cli.Execute())
}
