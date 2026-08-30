// Command gatekeeper is the user-side attesting proxy for the Confidential
// Router: it verifies an endpoint's published evidence before letting traffic
// through.
//
// This is the bootstrap skeleton — it only reports its build identity. The
// verification pipeline, trust store and proxy data plane land in SUP-68,
// SUP-69 and SUP-71; keep all reusable logic under pkg/ so a desktop shell can
// embed it later.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/version"
)

func main() {
	showVersion := flag.Bool("version", false, "print the build identity and exit")
	flag.Parse()

	if *showVersion {
		fmt.Fprintln(os.Stdout, version.Get())
		return
	}

	fmt.Fprintln(os.Stdout, version.Get())
	fmt.Fprintln(os.Stdout, "no commands are implemented yet — see apps/gatekeeper/README.md")
}
