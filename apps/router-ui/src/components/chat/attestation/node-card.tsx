'use client';

import { Handle, Position } from '@xyflow/react';
import { Boxes, Container, Globe, Share2 } from 'lucide-react';
import type * as React from 'react';
import type { GraphNode, NodeKind } from './graph-model';
import { abbreviate } from './hex';
import { ImageVerdictIcon, isUndeclared } from './image-verdict';

const ICONS: Record<NodeKind, React.ComponentType<{ className?: string }>> = {
  host: Globe,
  service: Share2,
  workload: Boxes,
  container: Container,
};

/** Accessible-name prefix per layer, so a node read aloud says what it is. */
const ROLES: Record<NodeKind, string> = {
  host: 'Ingress host',
  service: 'Service',
  workload: 'Workload',
  container: 'Container',
};

export interface NodeCardData extends Record<string, unknown> {
  node: GraphNode;
  onOpen: (node: GraphNode) => void;
}

/**
 * One node of the deployment graph.
 *
 * It is a `<button>`, not a styled `<div>` with a click handler, and that is the
 * accessibility of this screen in one decision: the graph has to be walkable
 * without a pointer, and a button gets tab order, Enter and Space, a focus ring
 * and a role from the platform rather than from a handful of ARIA attributes that
 * have to be kept correct. Tab order follows the DOM, which follows the node
 * order `graph-model.ts` emits: the ingress hosts, then the services, then each
 * workload with the containers it runs immediately after it. Depth rather than
 * column, because a reader who has just heard a workload's name wants to hear
 * what it runs next, not the other two workloads.
 *
 * The accessible name carries everything the visual card carries, including the
 * verdict: a reader who cannot see that a box is red has to hear that the image
 * is undeclared.
 */
export function NodeCard({ data }: { data: NodeCardData }) {
  const { node, onOpen } = data;
  const Icon = ICONS[node.kind];
  const loud = isUndeclared(node.verdict);
  const digest = node.image?.digest ?? null;

  return (
    <>
      {/* Hidden from assistive tech: the edges are described in the node's own name. */}
      <Handle type="target" position={Position.Left} isConnectable={false} aria-hidden="true" />
      <button
        type="button"
        onClick={() => onOpen(node)}
        aria-label={accessibleName(node)}
        className={[
          // `nopan` is react-flow's own opt-out: without it a press on the card
          // is also the start of a canvas pan, so a click has to beat d3-zoom to
          // the event. Pressing a button is not a gesture on the canvas.
          'nopan',
          'flex w-[14rem] flex-col gap-0.5 rounded-lg border bg-card px-3 py-2 text-left outline-none transition-colors',
          'hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
          loud ? 'border-destructive bg-destructive/10 hover:bg-destructive/15' : '',
        ].join(' ')}
      >
        <span className="flex items-center gap-1.5">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate font-medium text-xs">{node.name}</span>
          {node.verdict ? <ImageVerdictIcon verdict={node.verdict} className="ml-auto size-3.5 shrink-0" /> : null}
        </span>
        <span className="text-[0.65rem] text-muted-foreground uppercase tracking-wide">
          {node.detail ?? ROLES[node.kind]}
        </span>
        {digest ? (
          <span className="font-mono text-[0.65rem] text-muted-foreground">{abbreviate(digest, 11)}</span>
        ) : null}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} aria-hidden="true" />
    </>
  );
}

/**
 * What a screen reader says for a node: its layer, its name, and — for a
 * container — the full digest and the verdict, spelled out rather than coloured.
 */
export function accessibleName(node: GraphNode): string {
  const parts = [`${ROLES[node.kind]} ${node.name}`];
  if (node.namespace) parts.push(`in namespace ${node.namespace}`);
  if (node.image) parts.push(`image ${node.image.raw}`);
  if (node.verdict) parts.push(VERDICT_SPEECH[node.verdict.status]);
  parts.push('opens the raw signed fields');
  return parts.join('. ');
}

/** Short spoken form of each verdict; the long sentence is in the drawer. */
const VERDICT_SPEECH: Record<NonNullable<GraphNode['verdict']>['status'], string> = {
  declared: 'digest declared by the operator',
  'digest-mismatch': 'undeclared build: the operator declares this image at a different digest',
  'not-declared': 'undeclared: the operator’s declaration does not mention this image',
  'not-pinned': 'not digest-pinned, so nothing could be matched',
  'no-allow-list': 'nothing declared for this endpoint, so nothing was compared',
};
