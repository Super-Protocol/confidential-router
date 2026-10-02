'use client';

import { CodeBlock } from '@confidential-router/ui/components/code-block';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@confidential-router/ui/components/sheet';
import type { GraphNode } from './graph-model';
import { IMAGE_VERDICTS } from './image-verdict';

export interface RawFieldsProps {
  node: GraphNode | null;
  onClose: () => void;
}

/**
 * A node's raw fields, exactly as the signed document carries them.
 *
 * Printed as indented JSON rather than as a formatted field tree. The extension's
 * popup renders a coloured tree, which reads better — but a tree is a
 * presentation that decides which keys to show and in what order, and the whole
 * claim of this drawer is "this is what was signed". `JSON.stringify` over the
 * object the graph was built from cannot drop a key, cannot reorder one, and is
 * copyable in a form a reader can diff against their own `kubectl get -o json`.
 */
export function RawFields({ node, onClose }: RawFieldsProps) {
  return (
    <Sheet open={node !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        {node ? (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="break-words">{node.name}</SheetTitle>
              <SheetDescription>
                {node.detail ? `${node.detail} · ` : null}
                {node.namespace ? `namespace ${node.namespace} · ` : null}
                out of the signed evidence
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
              {node.image ? (
                <dl className="space-y-1 text-sm">
                  <dt className="text-muted-foreground">Image</dt>
                  <dd className="break-all font-mono text-xs">{node.image.raw}</dd>
                  {node.verdict ? (
                    <>
                      <dt className="pt-2 text-muted-foreground">{IMAGE_VERDICTS[node.verdict.status].label}</dt>
                      <dd className="max-w-prose text-muted-foreground text-xs">
                        {IMAGE_VERDICTS[node.verdict.status].sentence}
                      </dd>
                    </>
                  ) : null}
                </dl>
              ) : null}
              <CodeBlock
                code={JSON.stringify(node.raw, null, 2)}
                title="Raw fields, verbatim from the signed snapshot"
                copyLabel={`Copy the raw fields of ${node.name}`}
                className="max-w-full overflow-x-auto"
              />
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
