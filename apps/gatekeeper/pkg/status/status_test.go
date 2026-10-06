package status_test

import (
	"strings"
	"testing"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

func TestHealthDistinguishesServingFromTrusted(t *testing.T) {
	// The distinction the whole dashboard rests on: a fail-open endpoint is
	// carrying traffic and is not covered by a verdict.
	cases := []struct {
		health          status.Health
		serving, truste bool
	}{
		{status.Confidential, true, true},
		{status.NonConfidential, true, false},
		{status.Attesting, false, false},
		{status.Broken, false, false},
		{status.Stopped, false, false},
		{status.Unknown, false, false},
	}
	for _, c := range cases {
		if got := c.health.Serving(); got != c.serving {
			t.Errorf("%s.Serving() = %v, want %v", c.health, got, c.serving)
		}
		if got := c.health.Trusted(); got != c.truste {
			t.Errorf("%s.Trusted() = %v, want %v", c.health, got, c.truste)
		}
	}
	if status.Health("").Label() != "unknown" {
		t.Error("an empty health should read as unknown, not as nothing")
	}
}

func TestReportDeniedExplainsWhy(t *testing.T) {
	cases := []struct {
		name   string
		report *status.Report
		want   string
	}{
		{"admitted", &status.Report{Admitted: true}, ""},
		{"nothing yet", nil, "no verification"},
		{
			"a failed stage",
			&status.Report{Stage: "untrusted-root", Reason: "not a trusted root"},
			"untrusted-root: not a trusted root",
		},
		{
			"the built-in policy",
			&status.Report{Verified: true, Policies: []status.PolicyResult{{Package: "gatekeeper.default"}}},
			"the built-in pin policy (gatekeeper.default) denied",
		},
		{
			"a user policy",
			&status.Report{Verified: true, Policies: []status.PolicyResult{
				{Package: "gatekeeper.default", Allow: true},
				{Package: "images", Policy: "images-from-our-registry"},
			}},
			"policy images-from-our-registry (images) denied",
		},
		{
			"a policy that blew up",
			&status.Report{Verified: true, Policies: []status.PolicyResult{
				{Package: "images", Policy: "broken", Error: "division by zero"},
			}},
			"failed to evaluate: division by zero",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := c.report.Denied()
			if c.want == "" {
				if got != "" {
					t.Errorf("Denied() = %q, want nothing", got)
				}
				return
			}
			if !strings.Contains(got, c.want) {
				t.Errorf("Denied() = %q, want it to contain %q", got, c.want)
			}
		})
	}
}

// TestRootAnchorNamesWhatAdmittedTheRoot is the one line an audit review reads:
// after SUP-139 "attested" covers two different claims, and the record has to
// keep them apart.
func TestRootAnchorNamesWhatAdmittedTheRoot(t *testing.T) {
	for _, tc := range []struct {
		name   string
		report *status.Report
		want   string
	}{
		{name: "no verdict yet", report: &status.Report{}, want: ""},
		{
			name:   "a root the operator listed",
			report: &status.Report{Root: "swarm-cloud-prod"},
			want:   "trustedRoots",
		},
		{
			name: "signed by Super Protocol",
			report: &status.Report{
				Root: "attested:842c", RootAttested: true,
				AttestedRoot: &status.AttestedRoot{Attested: true, MeasurementSource: "registry"},
			},
			want: "attested (registry)",
		},
		{
			name: "pinned by this operator",
			report: &status.Report{
				Root: "attested:bb69", RootAttested: true,
				AttestedRoot: &status.AttestedRoot{Attested: true, MeasurementSource: "operator-pinned"},
			},
			want: "attested (operator-pinned)",
		},
		{
			// A verdict recorded by an older build carries no source; saying
			// "attested" is honest, inventing an anchor would not be.
			name:   "an attested root from a build that recorded no source",
			report: &status.Report{Root: "attested:842c", RootAttested: true},
			want:   "attested",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.report.RootAnchor(); got != tc.want {
				t.Errorf("RootAnchor() = %q, want %q", got, tc.want)
			}
		})
	}
}
