package policy

import (
	"github.com/open-policy-agent/opa/v1/ast"
	"github.com/open-policy-agent/opa/v1/rego"
	"github.com/open-policy-agent/opa/v1/types"
)

// TreeMatchName is the Rego name of the subtree-matching helper.
const TreeMatchName = "custom.tree_match"

// treeMatchDecl declares `custom.tree_match(pattern, actual)`, a port of the
// Rust gatekeeper's built-in of the same name
// (swarm-cloud apps/swarm-gatekeeper/src/policy/engine.rs).
//
// Deployment snapshots are deep and mostly irrelevant to a given rule; writing
// "these few fields must look like this" with walk() and object.get is verbose
// and easy to get subtly wrong. tree_match states it directly.
var treeMatchDecl = &rego.Function{
	Name:        TreeMatchName,
	Description: "true if every key in `pattern` is present in `actual` with an equal value; keys only present in `actual` are ignored.",
	Decl:        types.NewFunction(types.Args(types.A, types.A), types.B),
	Memoize:     true,
}

// treeMatchBuiltin is the compile-time declaration matching treeMatchDecl.
var treeMatchBuiltin = &ast.Builtin{
	Name:        treeMatchDecl.Name,
	Description: treeMatchDecl.Description,
	Decl:        treeMatchDecl.Decl,
}

func treeMatchImpl(_ rego.BuiltinContext, pattern, actual *ast.Term) (*ast.Term, error) {
	return ast.BooleanTerm(treeMatch(pattern.Value, actual.Value)), nil
}

// treeMatch implements the recursive rules of the Rust original:
//
//   - every key of pattern must exist in actual;
//   - object values recurse;
//   - any other value (string, number, boolean, array, set, null) must be equal;
//   - keys present only in actual are ignored.
func treeMatch(pattern, actual ast.Value) bool {
	patternObj, patternOK := pattern.(ast.Object)
	actualObj, actualOK := actual.(ast.Object)
	if !patternOK || !actualOK {
		return ast.Compare(pattern, actual) == 0
	}

	matched := true
	patternObj.Foreach(func(key, expected *ast.Term) {
		if !matched {
			return
		}
		found := actualObj.Get(key)
		if found == nil {
			matched = false
			return
		}
		matched = treeMatch(expected.Value, found.Value)
	})
	return matched
}
