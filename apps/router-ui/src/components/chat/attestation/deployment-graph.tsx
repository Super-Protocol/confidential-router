'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import {
  Background,
  Controls,
  type Edge,
  type Node,
  type NodeTypes,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TriangleAlert } from 'lucide-react';
import * as React from 'react';
import type { DeploymentGraph, GraphNode } from './graph-model';
import { LAYER_LABELS } from './graph-model';
import { isUndeclared } from './image-verdict';
import { NodeCard, type NodeCardData } from './node-card';

const nodeTypes: NodeTypes = { resource: NodeCard };

/** How each relation is drawn, and what it is called in the legend. */
const EDGE_STYLE = {
  'routes-to': { stroke: 'var(--color-brand)' },
  selects: { stroke: 'var(--color-muted-foreground)' },
  runs: { stroke: 'var(--color-muted-foreground)', strokeDasharray: '4 3' },
} as const;

export interface DeploymentGraphViewProps {
  graph: DeploymentGraph;
  onOpenNode: (node: GraphNode) => void;
}

/**
 * The deployment graph: four columns, drawn from the signed evidence.
 *
 * All of the thinking is in `graph-model.ts`; this file turns its output into
 * react-flow's shapes and does nothing else to it. That split is on purpose —
 * what the graph *claims* is testable without a canvas, and what is left here is
 * presentation that a screenshot reviews better than an assertion.
 *
 * Nodes are not draggable. The layout is the signed document's own order, laid
 * out deterministically, so two readers comparing screenshots are comparing the
 * same picture; letting it be rearranged would cost that for a gesture nobody
 * needs. Pan and zoom stay, because a real namespace does not fit on a laptop.
 */
export function DeploymentGraphView({ graph, onOpenNode }: DeploymentGraphViewProps) {
  const nodes = React.useMemo<Node<NodeCardData>[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'resource',
        position: node.position,
        data: { node, onOpen: onOpenNode },
        // react-flow's own focus handling is off: the card is a button, so the
        // platform's tab order is the one that matters and a second focusable
        // wrapper would mean two stops per node.
        focusable: false,
        draggable: false,
        /*
         * Selectable, and not for the selection. react-flow puts
         * `pointer-events: none` on any node wrapper that is neither selectable
         * nor draggable nor given a mouse handler, which would leave the button
         * inside it reachable by keyboard and dead to a click. The highlight it
         * brings is a fair affordance — it marks the node whose drawer is open —
         * and it is the only one of the three flags that does not also let the
         * layout be rearranged.
         */
        selectable: true,
      })),
    [graph.nodes, onOpenNode],
  );

  const edges = React.useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        style: EDGE_STYLE[edge.relation],
        // Decorative: every edge is also stated in the nodes it joins and in the
        // raw fields behind them, so an SVG path needs no accessible name.
        ariaLabel: undefined,
        focusable: false,
      })),
    [graph.edges],
  );

  const undeclared = graph.containers.filter((container) => isUndeclared(container.verdict));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm">
          <span className="font-medium">Drawn from the signed evidence.</span>{' '}
          <span className="text-muted-foreground">
            Every node below comes out of the document this page just verified — not from a live API. The graph is the
            attested document.
          </span>
        </p>
      </div>

      {undeclared.length > 0 ? (
        <p
          className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
          role="status"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="min-w-0">
            {undeclared.length === 1
              ? 'One container in the signed evidence runs an image the operator did not declare: '
              : `${undeclared.length} containers in the signed evidence run images the operator did not declare: `}
            {undeclared.map((container) => container.name).join(', ')}.
          </span>
        </p>
      ) : null}

      <ul className="flex flex-wrap gap-2" aria-label="Graph layers, left to right">
        {(['host', 'service', 'workload', 'container'] as const).map((kind) => (
          <li key={kind}>
            <Badge variant="secondary">{LAYER_LABELS[kind]}</Badge>
          </li>
        ))}
      </ul>

      {/*
        react-flow's own chrome — the zoom controls, the dot grid, the edges, the
        attribution — ships a light-mode palette hard-wired into its stylesheet.
        Mapping its variables onto the console's tokens is what makes the canvas
        legible in dark mode as well as light, which is the pair the accessibility
        suite audits. Its `colorMode` prop is not used: it follows the operating
        system, and this console's theme is `next-themes` on the `html` element.
      */}
      {/*
        A `<figure>` rather than a labelled `<div role="group">`: the canvas is a
        self-contained illustration referred to from the prose around it, which
        is what the element means, and it carries the role without an ARIA
        attribute to keep correct.
      */}
      <figure
        className="m-0 h-[28rem] rounded-lg border bg-muted/20"
        aria-label="Deployment graph drawn from the signed evidence"
        style={
          {
            '--xy-background-pattern-color': 'var(--color-border)',
            '--xy-edge-stroke': 'var(--color-muted-foreground)',
            '--xy-edge-stroke-selected': 'var(--color-brand)',
            '--xy-controls-button-background-color': 'var(--color-card)',
            '--xy-controls-button-background-color-hover': 'var(--color-accent)',
            '--xy-controls-button-color': 'var(--color-foreground)',
            '--xy-controls-button-color-hover': 'var(--color-accent-foreground)',
            '--xy-controls-button-border-color': 'var(--color-border)',
            '--xy-attribution-background-color': 'transparent',
          } as React.CSSProperties
        }
      >
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            minZoom={0.2}
            maxZoom={1.5}
            proOptions={{ hideAttribution: false }}
          >
            <Background />
            <Controls showInteractive={false} />
          </ReactFlow>
        </ReactFlowProvider>
      </figure>

      <p className="max-w-prose text-muted-foreground text-xs">
        Tab walks the graph: the ingress hosts first, then the services, then each workload followed by the containers
        it runs. Enter opens a node’s raw signed fields.
        {graph.undrawn.length > 0 ? (
          <>
            {' '}
            The signed document also carries{' '}
            {graph.undrawn.map((kind) => `${kind.count} ${kind.kind}${kind.count === 1 ? '' : 's'}`).join(', ')}, which
            this graph does not draw — they are in the raw evidence all the same, and the digest covers them.
          </>
        ) : null}
      </p>
    </div>
  );
}
