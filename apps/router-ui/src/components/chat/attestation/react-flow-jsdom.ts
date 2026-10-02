/**
 * The measurements jsdom does not take, so react-flow will render in a test.
 *
 * react-flow refuses to draw into a container whose measured size is zero, and
 * jsdom reports zero for everything: no layout engine, `ResizeObserver` absent,
 * `offsetWidth`/`offsetHeight` hard-wired to 0. Without these, the canvas mounts
 * and the nodes never appear — so every assertion about a node would pass
 * vacuously or fail for a reason that has nothing to do with the code.
 *
 * This is the shim xyflow documents for exactly this case, kept in one module so
 * the two specs that need it cannot drift. Imported for its side effects only;
 * it must be imported before `@testing-library/react` renders a graph.
 */

const VIEWPORT = { width: 1200, height: 800 };

class SizedResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.callback([{ target, contentRect: VIEWPORT as DOMRectReadOnly } as ResizeObserverEntry], this);
  }

  unobserve(): void {}

  disconnect(): void {}
}

// Unconditional: `test-setup.ts` installs a do-nothing ResizeObserver for Radix,
// which never calls back and so never gives react-flow a size.
globalThis.ResizeObserver = SizedResizeObserver as unknown as typeof ResizeObserver;

if (!('DOMMatrixReadOnly' in globalThis)) {
  class StubMatrix {
    m22 = 1;
  }
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = StubMatrix;
}

Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetWidth: {
    configurable: true,
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.width) || VIEWPORT.width;
    },
  },
  offsetHeight: {
    configurable: true,
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.height) || VIEWPORT.height;
    },
  },
});

// jsdom implements no SVG geometry at all, so `getBBox` is absent rather than
// zero-valued; react-flow's edge rendering calls it.
const svg = globalThis.SVGElement.prototype as unknown as { getBBox?: () => DOMRect };
if (!svg.getBBox) {
  svg.getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
