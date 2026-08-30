// Package version exposes the build identity of the gatekeeper binary.
//
// The values are overridden at link time by GoReleaser:
//
//	-ldflags "-X <pkg>.version=$VERSION -X <pkg>.commit=$COMMIT -X <pkg>.date=$DATE"
package version

import (
	"fmt"
	"runtime"
)

// Overridden via -ldflags at release time; the defaults describe a local build.
var (
	version = "dev"
	commit  = "none"
	date    = "unknown"
)

// Info is the resolved build identity.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	Date      string `json:"date"`
	GoVersion string `json:"goVersion"`
	Platform  string `json:"platform"`
}

// Get returns the build identity of the running binary.
func Get() Info {
	return Info{
		Version:   version,
		Commit:    commit,
		Date:      date,
		GoVersion: runtime.Version(),
		Platform:  fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH),
	}
}

// String renders the identity for `gatekeeper --version` output.
func (i Info) String() string {
	return fmt.Sprintf("gatekeeper %s (commit %s, built %s, %s, %s)", i.Version, i.Commit, i.Date, i.GoVersion, i.Platform)
}
