package cli

import (
	"io"
	"os"

	"github.com/mattn/go-isatty"
)

// isTerminal reports whether w is an interactive terminal. It decides whether
// confirmation prompts are offered and whether colour is worth emitting; it is
// deliberately the only place in the package that asks.
func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	return isatty.IsTerminal(f.Fd()) || isatty.IsCygwinTerminal(f.Fd())
}
