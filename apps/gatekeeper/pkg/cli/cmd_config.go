package cli

import (
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
)

func newConfigCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Inspect the configuration file",
		Args:  cobra.NoArgs,
		RunE:  func(cmd *cobra.Command, _ []string) error { return cmd.Help() },
	}
	cmd.AddCommand(newConfigPathCommand(g), newConfigValidateCommand(g))
	return cmd
}

func newConfigPathCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "path",
		Short: "Print the configuration file this invocation would use",
		Long: "path resolves --config, $CR_GATEKEEPER_CONFIG, $GATEKEEPER_CONFIG and the default\n" +
			"location in that order, and reports which of them decided.",
		Args: cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		path, source := g.pathSource()
		_, statErr := os.Stat(path)
		exists := statErr == nil
		p := g.printer(cmd, *asJSON)

		return p.emit(map[string]any{"path": path, "source": source, "exists": exists}, func(w io.Writer) {
			fmt.Fprintln(w, path)
			if !exists {
				p.note("this file does not exist yet — run `gatekeeper init` to create it")
			}
		})
	}
	return cmd
}

// validateResult is the JSON shape of `config validate`.
type validateResult struct {
	Path string `json:"path"`
	// Valid means nothing in the file is wrong.
	Valid bool `json:"valid"`
	// Ready means it is also complete enough to run. A file can be valid and
	// not ready — that is exactly the state `gatekeeper init` leaves behind.
	Ready    bool              `json:"ready"`
	Problems []validateProblem `json:"problems"`
}

type validateProblem struct {
	Path    string `json:"path"`
	Message string `json:"message"`
	// Incomplete distinguishes "you have not finished setting this up" from
	// "this value is wrong".
	Incomplete bool `json:"incomplete"`
}

func newConfigValidateCommand(g *globals) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "validate",
		Short: "Check the configuration and report every problem at once",
		Long: "validate applies the same rules startup does — the file, then $CR_GATEKEEPER_*,\n" +
			"then the command-line overrides — and lists every problem it finds, each addressed\n" +
			"by its path in the document.\n\n" +
			"Exit status is 0 when the configuration is ready to run and 4 when it is not.",
		Args: cobra.NoArgs,
	}
	asJSON := jsonFlag(cmd)

	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		path := g.path()
		p := g.printer(cmd, *asJSON)

		_, err := config.Load(config.Options{Environ: g.env.environ(), Overrides: g.overrides})
		result := validateResult{Path: path, Valid: true, Ready: true, Problems: []validateProblem{}}

		var invalid *config.ValidationError
		switch {
		case err == nil:
		case errors.Is(err, config.ErrNotFound):
			return failf(ExitConfig, "no configuration at %s — run `gatekeeper init` to create one", path)
		case errors.As(err, &invalid):
			result.Ready = false
			for _, fe := range invalid.Errors {
				if !fe.Incomplete {
					result.Valid = false
				}
				result.Problems = append(result.Problems,
					validateProblem{Path: fe.Path, Message: fe.Message, Incomplete: fe.Incomplete})
			}
		default:
			// A parse error, an unreadable pemFile: not addressable by path, so
			// it is reported as it came.
			return wrap(ExitConfig, err)
		}

		emitErr := p.emit(result, func(w io.Writer) {
			if result.Ready {
				fmt.Fprintf(w, "%s is valid and ready to run\n", path)
				nextStep(w, "start the gatekeeper", "gatekeeper run")
				return
			}
			headline := "not ready to run"
			if !result.Valid {
				headline = "invalid"
			}
			fmt.Fprintf(w, "%s is %s (%d problem%s):\n", path, headline, len(result.Problems), plural(len(result.Problems)))
			for _, problem := range result.Problems {
				fmt.Fprintf(w, "  - %s: %s\n", problem.Path, problem.Message)
			}
			if result.Valid {
				fmt.Fprintln(w, "\nNothing in the file is wrong — it is not finished.")
			}
			// An unfinished setup is told how to finish it, command by command;
			// anything else gets the honest instruction, because a real error is
			// already addressed by its path in the document.
			if commands := g.finishingCommands(result.Problems); len(commands) > 0 {
				nextStep(w, "finish the setup", commands...)
				return
			}
			nextStep(w, "fix each path listed above, then check again", "gatekeeper config validate")
		})
		if emitErr != nil {
			return emitErr
		}
		if !result.Ready {
			return silentf(ExitConfig)
		}
		return nil
	}
	return cmd
}

// finishingCommands turns "not finished yet" into the commands that finish it,
// in the order the setup sequence runs them.
//
// It returns nothing unless every problem is an unfinished-setup one *and* each
// of them maps to a command. A list that silently skipped the problem it could
// not name would send the reader away with a next step that does not clear the
// error they are looking at (SUP-300).
func (g *globals) finishingCommands(problems []validateProblem) []string {
	if len(problems) == 0 {
		return nil
	}
	// The endpoint names behind `endpoints[i]`: the validation messages address
	// a position in the document, and a command needs a name. Loaded through
	// the store because it, unlike config.Load, accepts an unfinished file.
	var names []string
	if store, err := g.open(); err == nil {
		for _, ep := range store.Endpoints() {
			names = append(names, ep.Name)
		}
	}

	commands := make([]string, 0, len(problems))
	for _, problem := range problems {
		command := finishingCommand(problem, names)
		if !problem.Incomplete || command == "" {
			return nil
		}
		if !slices.Contains(commands, command) {
			commands = append(commands, command)
		}
	}
	return commands
}

// finishingCommand is the one command that clears a single unfinished-setup
// problem, or "" when there is none to name.
func finishingCommand(problem validateProblem, names []string) string {
	switch problem.Path {
	case "endpoints":
		return addEndpointExample()
	case "trustedRoots":
		return "gatekeeper trust roots add <name> --pem-file <root.pem>"
	case "attestedRoots.trustedMeasurements":
		return "gatekeeper trust measurements add --from-upstream " + endpointPlaceholder(names)
	}
	if index, ok := endpointIndex(problem.Path); ok {
		return fmt.Sprintf("gatekeeper endpoint trust add %s --from-upstream", endpointName(names, index))
	}
	return ""
}

// endpointIndex reads the `i` out of `endpoints[i].trustedEvidence`.
func endpointIndex(path string) (int, bool) {
	rest, ok := strings.CutPrefix(path, "endpoints[")
	if !ok {
		return 0, false
	}
	digits, ok := strings.CutSuffix(rest, "].trustedEvidence")
	if !ok {
		return 0, false
	}
	index, err := strconv.Atoi(digits)
	if err != nil {
		return 0, false
	}
	return index, true
}

func endpointName(names []string, index int) string {
	if index >= 0 && index < len(names) {
		return names[index]
	}
	return "<endpoint>"
}

// endpointPlaceholder names the only endpoint when there is only one, because a
// command the reader can run beats a command they have to fill in.
func endpointPlaceholder(names []string) string {
	if len(names) == 1 {
		return names[0]
	}
	return "<endpoint>"
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
