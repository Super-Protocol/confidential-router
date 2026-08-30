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
