package tui

import "github.com/charmbracelet/bubbles/key"

// keyMap is the dashboard's whole keyboard interface. Every action the design
// calls for has one key and one only; there is no hidden verb.
type keyMap struct {
	Up       key.Binding
	Down     key.Binding
	Toggle   key.Binding
	Reattest key.Binding
	Pin      key.Binding
	AddRoot  key.Binding
	Logs     key.Binding
	Help     key.Binding
	Quit     key.Binding
}

func defaultKeys() keyMap {
	return keyMap{
		Up:       key.NewBinding(key.WithKeys("up", "k"), key.WithHelp("↑/k", "up")),
		Down:     key.NewBinding(key.WithKeys("down", "j"), key.WithHelp("↓/j", "down")),
		Toggle:   key.NewBinding(key.WithKeys("s"), key.WithHelp("s", "start/stop")),
		Reattest: key.NewBinding(key.WithKeys("r"), key.WithHelp("r", "re-attest")),
		Pin:      key.NewBinding(key.WithKeys("t"), key.WithHelp("t", "trust this deployment")),
		AddRoot:  key.NewBinding(key.WithKeys("a"), key.WithHelp("a", "add the untrusted root")),
		Logs:     key.NewBinding(key.WithKeys("l"), key.WithHelp("l", "logs/detail")),
		Help:     key.NewBinding(key.WithKeys("?"), key.WithHelp("?", "help")),
		Quit:     key.NewBinding(key.WithKeys("q", "ctrl+c", "esc"), key.WithHelp("q", "quit")),
	}
}

// ShortHelp implements help.KeyMap: the footer line.
func (k keyMap) ShortHelp() []key.Binding {
	return []key.Binding{k.Up, k.Down, k.Toggle, k.Reattest, k.Pin, k.Help, k.Quit}
}

// FullHelp implements help.KeyMap: the expanded panel.
func (k keyMap) FullHelp() [][]key.Binding {
	return [][]key.Binding{
		{k.Up, k.Down, k.Logs},
		{k.Toggle, k.Reattest},
		{k.Pin, k.AddRoot},
		{k.Help, k.Quit},
	}
}
