// Package policy is the gatekeeper's authorisation layer: embedded OPA over the
// verified evidence.
//
// It compiles three kinds of module into one unit (ADR-003 §4-5):
//
//   - `gatekeeper.trust` — generated from the trust store on every load, the
//     read-only data every policy consults;
//   - `gatekeeper.default` — the built-in pin policy, always loaded;
//   - the user's `policies[]` modules.
//
// A request is admitted only if *every* loaded package's `allow` is true, so a
// user policy can narrow trust but never widen it. Compile errors are fatal at
// load; an evaluation error or an undefined result at request time is a deny.
package policy

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/open-policy-agent/opa/v1/ast"
	"github.com/open-policy-agent/opa/v1/rego"

	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/config"
	"github.com/Super-Protocol/confidential-router/apps/gatekeeper/pkg/trust"
)

//go:embed default.rego
var defaultPolicySource string

// DefaultPackage is the built-in pin policy.
const DefaultPackage = "gatekeeper.default"

const defaultPolicyFilename = "gatekeeper.default.rego"

// DefaultEvalTimeout bounds a single evaluation. Policies are pure and tiny;
// anything slower is a runaway comprehension over a large snapshot, and the
// data plane must not stall behind it.
const DefaultEvalTimeout = 2 * time.Second

// Module is one user Rego module to load.
type Module struct {
	// Name is policies[].name, used in messages.
	Name string
	// Filename is what compile errors point at.
	Filename string
	// Source is the Rego text.
	Source string
}

// Options configures [New].
type Options struct {
	// Store supplies the generated trust module. Required.
	Store *trust.Store
	// Modules are the user policies, already read.
	Modules []Module
	// EvalTimeout bounds one Evaluate call; zero means DefaultEvalTimeout.
	EvalTimeout time.Duration
}

// LoadModules reads the `policies[]` files listed in a config, resolving
// relative paths against the config file.
func LoadModules(cfg *config.Config) ([]Module, error) {
	modules := make([]Module, 0, len(cfg.Policies))
	for _, p := range cfg.Policies {
		path := cfg.Resolve(p.File)
		source, err := os.ReadFile(path) //nolint:gosec // operator-supplied path by design
		if err != nil {
			return nil, fmt.Errorf("policy %q: %w", p.Name, err)
		}
		modules = append(modules, Module{Name: p.Name, Filename: path, Source: string(source)})
	}
	return modules, nil
}

// packageQuery is one compiled `<ref>.allow` query.
type packageQuery struct {
	// pkg is the dotted package name as a human writes it, e.g.
	// "gatekeeper.default".
	pkg string
	// ref is the same package as a Rego reference. The two differ whenever a
	// path segment is a keyword: `gatekeeper.default` has to be written
	// `data.gatekeeper["default"]` for the query to parse at all.
	ref    string
	policy string // policies[].name; empty for the built-in policy
	query  rego.PreparedEvalQuery
}

// Engine holds the compiled policies and their prepared queries. It is
// immutable and safe for concurrent use; a config change builds a new one.
type Engine struct {
	queries     []packageQuery
	trustModule string
	timeout     time.Duration
	hash        trust.Digest
}

// New compiles the trust module, the built-in policy and every user policy, and
// prepares one query per package. Any compile problem — a syntax error, an
// unknown builtin, a package without `allow` — fails here rather than on the
// first request.
func New(ctx context.Context, opts Options) (*Engine, error) {
	if opts.Store == nil {
		return nil, errors.New("policy: a trust store is required")
	}
	timeout := opts.EvalTimeout
	if timeout <= 0 {
		timeout = DefaultEvalTimeout
	}

	trustSource := GenerateTrustModule(opts.Store.Snapshot())
	modules := make(map[string]*ast.Module, len(opts.Modules)+2)

	trustModule, err := parseModule(trustModuleFilename, trustSource)
	if err != nil {
		return nil, err
	}
	defaultModule, err := parseModule(defaultPolicyFilename, defaultPolicySource)
	if err != nil {
		return nil, err
	}
	modules[trustModuleFilename] = trustModule
	modules[defaultPolicyFilename] = defaultModule

	// Packages carrying an `allow` rule, in load order: the built-in first so
	// that a denial names it before any user policy.
	ordered := []packageQuery{{pkg: packageName(defaultModule), ref: packageRef(defaultModule)}}

	seen := map[string]string{
		packageName(defaultModule): "the built-in policy",
		packageName(trustModule):   "the generated trust module",
	}

	for _, m := range opts.Modules {
		parsed, err := parseModule(m.Filename, m.Source)
		if err != nil {
			return nil, fmt.Errorf("policy %q: %w", m.Name, err)
		}
		pkg := packageName(parsed)
		if owner, taken := seen[pkg]; taken {
			return nil, fmt.Errorf("policy %q: package %s is already declared by %s", m.Name, pkg, owner)
		}
		if !hasAllowRule(parsed) {
			return nil, fmt.Errorf("policy %q: package %s defines no `allow` rule", m.Name, pkg)
		}
		seen[pkg] = fmt.Sprintf("policy %q", m.Name)
		modules[m.Filename] = parsed
		ordered = append(ordered, packageQuery{pkg: pkg, ref: packageRef(parsed), policy: m.Name})
	}

	compiler := newCompiler()
	compiler.Compile(modules)
	if compiler.Failed() {
		return nil, fmt.Errorf("policy: %w", compiler.Errors)
	}

	for i := range ordered {
		prepared, err := rego.New(
			rego.Compiler(compiler),
			rego.Query(ordered[i].ref+".allow"),
			rego.Function2(treeMatchDecl, treeMatchImpl),
			// Without this a failing builtin yields "undefined" — which would
			// read as a plain deny and hide the real problem from the operator.
			rego.StrictBuiltinErrors(true),
		).PrepareForEval(ctx)
		if err != nil {
			return nil, fmt.Errorf("policy: preparing %s: %w", ordered[i].pkg, err)
		}
		ordered[i].query = prepared
	}

	return &Engine{
		queries:     ordered,
		trustModule: trustSource,
		timeout:     timeout,
		hash:        hashSources(trustSource, defaultPolicySource, opts.Modules),
	}, nil
}

func newCompiler() *ast.Compiler {
	// Capabilities are how the compiler learns about custom built-ins;
	// rego.Function2 supplies the implementation at evaluation time.
	capabilities := ast.CapabilitiesForThisVersion()
	capabilities.Builtins = append(capabilities.Builtins, treeMatchBuiltin)
	return ast.NewCompiler().
		WithCapabilities(capabilities).
		WithDefaultRegoVersion(ast.RegoV1)
}

func parseModule(filename, source string) (*ast.Module, error) {
	return ast.ParseModuleWithOpts(filename, source, ast.ParserOptions{RegoVersion: ast.RegoV1})
}

// packageName renders the package the way a human writes it in a `package`
// declaration: dotted, unquoted.
func packageName(m *ast.Module) string {
	parts := make([]string, 0, len(m.Package.Path))
	for _, term := range m.Package.Path[1:] { // [0] is the `data` root document
		segment, ok := term.Value.(ast.String)
		if !ok {
			return strings.TrimPrefix(m.Package.Path.String(), "data.")
		}
		parts = append(parts, string(segment))
	}
	return strings.Join(parts, ".")
}

// packageRef renders the package as a Rego reference, quoting keyword segments.
func packageRef(m *ast.Module) string { return m.Package.Path.String() }

// hasAllowRule reports whether the module defines `allow` as a complete rule
// producing a value.
//
// A partial set (`allow contains x`) or a function (`allow(x)`) also parses,
// but querying `data.<pkg>.allow` against either yields a set or an error
// instead of a boolean. Catching that here turns what would be an error on
// every single request into one clear failure at load.
func hasAllowRule(m *ast.Module) bool {
	for _, rule := range m.Rules {
		if !isAllowName(rule.Head.Ref()) {
			continue
		}
		if rule.Head.Args == nil && rule.Head.Key == nil && rule.Head.Value != nil {
			return true
		}
	}
	return false
}

func isAllowName(ref ast.Ref) bool {
	if len(ref) != 1 {
		return false
	}
	switch value := ref[0].Value.(type) {
	case ast.Var:
		return string(value) == "allow"
	case ast.String:
		return string(value) == "allow"
	}
	return false
}

// hashSources fingerprints everything the engine compiled. It goes into the
// verdict cache key so that editing a policy or a pin takes effect on the next
// check instead of waiting out the TTL (ADR-003 §7).
func hashSources(trustSource, defaultSource string, modules []Module) trust.Digest {
	// Load order is part of the identity: it decides which package a denial
	// names first, so two engines that differ only in it are not the same
	// engine.
	var b strings.Builder
	b.WriteString(trustSource)
	b.WriteString("\x00")
	b.WriteString(defaultSource)
	for _, m := range modules {
		b.WriteString("\x00")
		b.WriteString(m.Name)
		b.WriteString("\x00")
		b.WriteString(m.Source)
	}
	return trust.Sum([]byte(b.String()))
}

// PackageDecision is one package's contribution to the verdict.
type PackageDecision struct {
	// Package is the Rego package, e.g. "gatekeeper.default".
	Package string
	// Policy is policies[].name, empty for the built-in policy.
	Policy string
	Allow  bool
	// Error is set when evaluation failed; an error is always a deny.
	Error string
}

// Decision is the result of evaluating every loaded package.
type Decision struct {
	Allow bool
	// Reason is a one-line explanation suitable for a log line or the 503 body.
	Reason string
	// Packages holds every package's result, in load order — `policy test`
	// prints them all rather than stopping at the first deny.
	Packages []PackageDecision
}

// Evaluate runs every package against the input and ANDs the results.
//
// Every package is evaluated even after the first deny: an operator debugging a
// rejected endpoint wants the whole picture, and the cost is a few microseconds
// of pure evaluation.
func (e *Engine) Evaluate(ctx context.Context, input map[string]any) Decision {
	ctx, cancel := context.WithTimeout(ctx, e.timeout)
	defer cancel()

	decision := Decision{Allow: true, Packages: make([]PackageDecision, 0, len(e.queries))}
	for _, q := range e.queries {
		result := PackageDecision{Package: q.pkg, Policy: q.policy}
		allow, err := evalAllow(ctx, q.query, input)
		switch {
		case err != nil:
			result.Error = err.Error()
		default:
			result.Allow = allow
		}
		if !result.Allow {
			decision.Allow = false
		}
		decision.Packages = append(decision.Packages, result)
	}
	decision.Reason = explain(decision)
	return decision
}

// TrustModule returns the generated `gatekeeper.trust` source, so that
// `gatekeeper policy test` can show exactly what the policies were reading.
func (e *Engine) TrustModule() string { return e.trustModule }

// Hash fingerprints the compiled policy set for verdict cache keys.
func (e *Engine) Hash() trust.Digest { return e.hash }

// Packages lists the evaluated packages in load order.
func (e *Engine) Packages() []string {
	out := make([]string, 0, len(e.queries))
	for _, q := range e.queries {
		out = append(out, q.pkg)
	}
	return out
}

// evalAllow runs one prepared query. An undefined result is a deny, not an
// error: `default allow := false` makes that unreachable for a well-formed
// policy, but a package that somehow yields nothing must never be admitted.
func evalAllow(ctx context.Context, query rego.PreparedEvalQuery, input map[string]any) (bool, error) {
	// A trivially cheap policy can finish without OPA ever looking at the
	// context, so an already-cancelled request would otherwise be admitted.
	if err := ctx.Err(); err != nil {
		return false, err
	}
	rs, err := query.Eval(ctx, rego.EvalInput(input))
	if err != nil {
		return false, err
	}
	if len(rs) == 0 || len(rs[0].Expressions) == 0 {
		return false, nil
	}
	allow, ok := rs[0].Expressions[0].Value.(bool)
	if !ok {
		return false, fmt.Errorf("`allow` evaluated to %T, expected a boolean", rs[0].Expressions[0].Value)
	}
	return allow, nil
}

func explain(d Decision) string {
	if d.Allow {
		return fmt.Sprintf("allowed by all %d policy package(s)", len(d.Packages))
	}
	for _, p := range d.Packages {
		if p.Allow {
			continue
		}
		who := "the built-in pin policy (" + p.Package + ")"
		if p.Policy != "" {
			who = fmt.Sprintf("policy %q (%s)", p.Policy, p.Package)
		}
		if p.Error != "" {
			return who + " failed to evaluate: " + p.Error
		}
		return who + " denied"
	}
	return "denied"
}
