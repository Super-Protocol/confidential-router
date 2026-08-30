package tui

import (
	"github.com/charmbracelet/lipgloss"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/status"
)

// Colours are adaptive: the gatekeeper runs on developer laptops with light
// terminals as often as on dark ones, and a dashboard whose "confidential" green
// is invisible on a white background is worse than one with no colour at all.
// Every pair is checked for contrast against both backgrounds.
var (
	colourText     = lipgloss.AdaptiveColor{Light: "#1f2328", Dark: "#e6edf3"}
	colourMuted    = lipgloss.AdaptiveColor{Light: "#59636e", Dark: "#9198a1"}
	colourAccent   = lipgloss.AdaptiveColor{Light: "#0550ae", Dark: "#79c0ff"}
	colourGood     = lipgloss.AdaptiveColor{Light: "#1a7f37", Dark: "#3fb950"}
	colourWarn     = lipgloss.AdaptiveColor{Light: "#9a6700", Dark: "#d29922"}
	colourBad      = lipgloss.AdaptiveColor{Light: "#cf222e", Dark: "#f85149"}
	colourBorder   = lipgloss.AdaptiveColor{Light: "#d1d9e0", Dark: "#3d444d"}
	colourSelected = lipgloss.AdaptiveColor{Light: "#dbeafe", Dark: "#1f3b5c"}
)

type styles struct {
	title      lipgloss.Style
	subtitle   lipgloss.Style
	pane       lipgloss.Style
	paneTitle  lipgloss.Style
	label      lipgloss.Style
	value      lipgloss.Style
	good       lipgloss.Style
	warn       lipgloss.Style
	bad        lipgloss.Style
	muted      lipgloss.Style
	flash      lipgloss.Style
	flashError lipgloss.Style
	help       lipgloss.Style
}

func newStyles() styles {
	return styles{
		title:      lipgloss.NewStyle().Bold(true).Foreground(colourAccent),
		subtitle:   lipgloss.NewStyle().Foreground(colourMuted),
		pane:       lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(colourBorder).Padding(0, 1),
		paneTitle:  lipgloss.NewStyle().Bold(true).Foreground(colourText),
		label:      lipgloss.NewStyle().Foreground(colourMuted),
		value:      lipgloss.NewStyle().Foreground(colourText),
		good:       lipgloss.NewStyle().Foreground(colourGood),
		warn:       lipgloss.NewStyle().Foreground(colourWarn),
		bad:        lipgloss.NewStyle().Foreground(colourBad),
		muted:      lipgloss.NewStyle().Foreground(colourMuted),
		flash:      lipgloss.NewStyle().Foreground(colourGood),
		flashError: lipgloss.NewStyle().Foreground(colourBad),
		help:       lipgloss.NewStyle().Foreground(colourMuted),
	}
}

// health picks the style for an endpoint state. The distinction that matters is
// Trusted, not Serving: a fail-open endpoint is carrying traffic and must still
// not look like a healthy one.
func (s styles) health(h status.Health) lipgloss.Style {
	switch h {
	case status.Confidential:
		return s.good
	case status.NonConfidential, status.Attesting:
		return s.warn
	case status.Broken:
		return s.bad
	default:
		return s.muted
	}
}

// levelStyle colours a log line by severity.
func (s styles) levelStyle(level string) lipgloss.Style {
	switch level {
	case "error":
		return s.bad
	case "warn":
		return s.warn
	default:
		return s.muted
	}
}
