package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// defaultFileMode is what a freshly created config gets. The file holds trust
// anchors, so it is owner-only even though it contains no secrets.
const defaultFileMode os.FileMode = 0o600

// Document is an editable view of the config file.
//
// `gatekeeper trust add` must not turn a hand-written, commented config into
// machine-emitted YAML, so edits go through the yaml.v3 node API: only the
// nodes that change are touched and everything else — comments, key order,
// block styles — survives the round trip. Saving is atomic (write a sibling
// temp file, fsync, rename), so a crash mid-write cannot leave a half-written
// trust configuration behind.
type Document struct {
	path string
	mode os.FileMode
	doc  *yaml.Node
}

// OpenDocument reads the config file for editing.
func OpenDocument(path string) (*Document, error) {
	f, err := os.Open(path) //nolint:gosec // operator-supplied path by design
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("%w at %s", ErrNotFound, path)
		}
		return nil, err
	}
	defer f.Close() //nolint:errcheck // read-only handle

	mode := defaultFileMode
	if info, statErr := f.Stat(); statErr == nil {
		mode = info.Mode().Perm()
	}

	// Read one byte past the limit so an oversized file is refused without
	// being pulled into memory whole.
	data, err := io.ReadAll(io.LimitReader(f, maxConfigSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxConfigSize {
		return nil, fmt.Errorf("%s: config file is larger than %d bytes", path, maxConfigSize)
	}

	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("%s: expected a YAML mapping at the top level", path)
	}
	return &Document{path: path, mode: mode, doc: &doc}, nil
}

// Path is the file the document was read from.
func (d *Document) Path() string { return d.path }

// Config decodes the current state of the document. Environment and
// command-line layers are deliberately absent: this is the file as it is (and,
// after Save, as it will be on disk).
func (d *Document) Config() (*Config, error) {
	var buf bytes.Buffer
	if err := encode(&buf, d.doc); err != nil {
		return nil, err
	}
	return Parse(&buf, d.path)
}

// Bytes renders the document exactly as Save would write it.
func (d *Document) Bytes() ([]byte, error) {
	var buf bytes.Buffer
	if err := encode(&buf, d.doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Save writes the document back atomically.
func (d *Document) Save() error {
	data, err := d.Bytes()
	if err != nil {
		return err
	}
	return writeFileAtomic(d.path, data, d.mode)
}

// AddTrustedRoot appends a root to the global list. It reports an error if the
// name is taken — replacing a trust anchor has to be an explicit remove + add.
func (d *Document) AddTrustedRoot(name, pem string) error {
	roots := d.section("trustedRoots")
	if _, idx := findByName(roots, name); idx >= 0 {
		return fmt.Errorf("trusted root %q already exists", name)
	}
	entry := mapping(
		scalar("name"), scalar(name),
		scalar("pem"), literalScalar(ensureTrailingNewline(pem)),
	)
	roots.Content = append(roots.Content, entry)
	return nil
}

// RemoveTrustedRoot drops a root by name and reports whether it was there.
func (d *Document) RemoveTrustedRoot(name string) (bool, error) {
	roots, ok := d.lookup("trustedRoots")
	if !ok {
		return false, nil
	}
	_, idx := findByName(roots, name)
	if idx < 0 {
		return false, nil
	}
	roots.Content = append(roots.Content[:idx], roots.Content[idx+1:]...)
	return true, nil
}

// AddTrustedEvidence pins another evidenceDigest on one endpoint. It reports
// false when the exact value is already pinned.
func (d *Document) AddTrustedEvidence(endpoint, digest string) (bool, error) {
	ep, err := d.endpointNode(endpoint)
	if err != nil {
		return false, err
	}
	list := sectionOf(ep, "trustedEvidence")
	for _, item := range list.Content {
		if item.Value == digest {
			return false, nil
		}
	}
	list.Content = append(list.Content, scalar(digest))
	return true, nil
}

// RemoveTrustedEvidence unpins every listed raw value from one endpoint and
// returns how many entries went away. The caller passes the literal strings as
// they appear in the file (the trust store keeps them next to the normalised
// form) so that a pin written in hex can be removed by its canonical name.
func (d *Document) RemoveTrustedEvidence(endpoint string, raws []string) (int, error) {
	ep, err := d.endpointNode(endpoint)
	if err != nil {
		return 0, err
	}
	list, ok := mapGet(ep, "trustedEvidence")
	if !ok || list.Kind != yaml.SequenceNode {
		return 0, nil
	}
	drop := make(map[string]struct{}, len(raws))
	for _, r := range raws {
		drop[r] = struct{}{}
	}
	kept := list.Content[:0]
	removed := 0
	for _, item := range list.Content {
		if _, found := drop[item.Value]; found {
			removed++
			continue
		}
		kept = append(kept, item)
	}
	list.Content = kept
	return removed, nil
}

func (d *Document) root() *yaml.Node { return d.doc.Content[0] }

// lookup returns an existing top-level sequence.
func (d *Document) lookup(key string) (*yaml.Node, bool) {
	node, ok := mapGet(d.root(), key)
	if !ok || node.Kind != yaml.SequenceNode {
		return nil, false
	}
	return node, true
}

// section returns a top-level sequence, creating it when absent.
func (d *Document) section(key string) *yaml.Node {
	return sectionOf(d.root(), key)
}

func (d *Document) endpointNode(name string) (*yaml.Node, error) {
	endpoints, ok := d.lookup("endpoints")
	if !ok {
		return nil, fmt.Errorf("no endpoints are configured in %s", d.path)
	}
	node, idx := findByName(endpoints, name)
	if idx < 0 {
		return nil, fmt.Errorf("no endpoint named %q in %s", name, d.path)
	}
	return node, nil
}

// sectionOf returns the sequence stored under key in a mapping, creating an
// empty one if the key is missing or holds null.
func sectionOf(m *yaml.Node, key string) *yaml.Node {
	if node, ok := mapGet(m, key); ok {
		if node.Kind == yaml.SequenceNode {
			// An empty `key: []` becomes a block list as soon as something is
			// appended: the starter config `gatekeeper init` writes uses the
			// flow form, and a root certificate rendered inside `[...]` would
			// be unreadable.
			if len(node.Content) == 0 {
				node.Style = 0
			}
			return node
		}
		if node.Kind == yaml.ScalarNode && node.Tag == "!!null" {
			node.Kind = yaml.SequenceNode
			node.Tag = "!!seq"
			node.Value = ""
			node.Style = 0
			return node
		}
	}
	seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	m.Content = append(m.Content, scalar(key), seq)
	return seq
}

func mapGet(m *yaml.Node, key string) (*yaml.Node, bool) {
	if m == nil || m.Kind != yaml.MappingNode {
		return nil, false
	}
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1], true
		}
	}
	return nil, false
}

// findByName locates the mapping in a sequence whose `name` equals want.
func findByName(seq *yaml.Node, want string) (*yaml.Node, int) {
	if seq == nil {
		return nil, -1
	}
	for i, item := range seq.Content {
		if name, ok := mapGet(item, "name"); ok && name.Value == want {
			return item, i
		}
	}
	return nil, -1
}

func scalar(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
}

func literalScalar(value string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Style: yaml.LiteralStyle, Value: value}
}

func mapping(kv ...*yaml.Node) *yaml.Node {
	return &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: kv}
}

func ensureTrailingNewline(s string) string {
	s = strings.TrimRight(s, " \t\r\n")
	return s + "\n"
}

func encode(w io.Writer, doc *yaml.Node) error {
	enc := yaml.NewEncoder(w)
	enc.SetIndent(2)
	if err := enc.Encode(doc); err != nil {
		return err
	}
	return enc.Close()
}

// writeFileAtomic writes data to path via a sibling temp file so that readers
// never observe a partial config, and fsyncs both the file and its directory so
// the rename survives a power loss.
func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) //nolint:errcheck // best effort; a successful rename makes this a no-op

	if err := writeAndSync(tmp, data, mode); err != nil {
		tmp.Close() //nolint:errcheck,gosec // the write already failed
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncDir(dir)
}

func writeAndSync(f *os.File, data []byte, mode os.FileMode) error {
	if err := f.Chmod(mode); err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		return err
	}
	return f.Sync()
}

func syncDir(dir string) error {
	d, err := os.Open(dir) //nolint:gosec // directory of the config file
	if err != nil {
		return err
	}
	defer d.Close() //nolint:errcheck // read-only handle
	if err := d.Sync(); err != nil && !errors.Is(err, os.ErrInvalid) {
		return err
	}
	return nil
}

// EndpointSpec is a new endpoint to append. It carries only the fields
// `gatekeeper endpoint add` accepts; everything else inherits from `defaults`.
type EndpointSpec struct {
	Name     string
	Listen   string
	Upstream string
	// FailMode is written only when set, so an endpoint that wants the global
	// default does not freeze today's default into the file.
	FailMode string
	// TrustedEvidence is written as given. It may be empty: the endpoint is
	// then pinned afterwards with `endpoint trust add`, and until it is,
	// `config validate` reports the config as not ready.
	TrustedEvidence []string
}

// AddEndpoint appends an endpoint. It reports an error if the name is taken —
// replacing an endpoint has to be an explicit remove + add, since its pins
// would otherwise be silently carried over or silently dropped.
func (d *Document) AddEndpoint(spec EndpointSpec) error {
	endpoints := d.section("endpoints")
	if _, idx := findByName(endpoints, spec.Name); idx >= 0 {
		return fmt.Errorf("endpoint %q already exists", spec.Name)
	}

	kv := []*yaml.Node{
		scalar("name"), scalar(spec.Name),
		scalar("listen"), scalar(spec.Listen),
		scalar("upstream"), scalar(spec.Upstream),
	}
	if spec.FailMode != "" {
		kv = append(kv, scalar("failMode"), scalar(spec.FailMode))
	}
	pins := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
	for _, digest := range spec.TrustedEvidence {
		pins.Content = append(pins.Content, scalar(digest))
	}
	kv = append(kv, scalar("trustedEvidence"), pins)

	endpoints.Content = append(endpoints.Content, mapping(kv...))
	return nil
}

// RemoveEndpoint drops an endpoint by name and reports whether it was there.
func (d *Document) RemoveEndpoint(name string) (bool, error) {
	endpoints, ok := d.lookup("endpoints")
	if !ok {
		return false, nil
	}
	_, idx := findByName(endpoints, name)
	if idx < 0 {
		return false, nil
	}
	endpoints.Content = append(endpoints.Content[:idx], endpoints.Content[idx+1:]...)
	return true, nil
}
