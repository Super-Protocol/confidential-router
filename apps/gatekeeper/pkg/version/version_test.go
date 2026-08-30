package version

import (
	"runtime"
	"strings"
	"testing"
)

func TestGetFillsRuntimeFields(t *testing.T) {
	got := Get()

	if got.GoVersion != runtime.Version() {
		t.Errorf("GoVersion = %q, want %q", got.GoVersion, runtime.Version())
	}
	want := runtime.GOOS + "/" + runtime.GOARCH
	if got.Platform != want {
		t.Errorf("Platform = %q, want %q", got.Platform, want)
	}
	if got.Version == "" || got.Commit == "" || got.Date == "" {
		t.Errorf("build identity has empty fields: %+v", got)
	}
}

func TestStringMentionsVersionAndPlatform(t *testing.T) {
	info := Info{Version: "1.2.3", Commit: "abc1234", Date: "2026-01-01", GoVersion: "go1.24.0", Platform: "linux/amd64"}

	got := info.String()

	for _, want := range []string{"1.2.3", "abc1234", "2026-01-01", "linux/amd64"} {
		if !strings.Contains(got, want) {
			t.Errorf("String() = %q, missing %q", got, want)
		}
	}
}
