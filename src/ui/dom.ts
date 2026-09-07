/**
 * A ~70-line DOM helper, in place of a framework.
 *
 * The panel is three lists and a detail pane; a virtual DOM would be more code
 * than the thing it renders. Two properties matter more than convenience here:
 *
 *  - Text is always set through `textContent`. Component names, comments and
 *    error messages come from imported files, and none of them is ever parsed
 *    as HTML.
 *  - Listeners are attached to the element being created, so a handler cannot
 *    outlive the node it belongs to.
 */

export type Child = Node | string | null | undefined | false;

export interface ElementOptions {
  readonly className?: string;
  readonly text?: string;
  readonly title?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly on?: Readonly<Record<string, (event: Event) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (options.className !== undefined) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title !== undefined) node.title = options.title;

  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    node.setAttribute(name, value);
  }
  for (const [event, handler] of Object.entries(options.on ?? {})) {
    node.addEventListener(event, handler);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function fragment(children: readonly Child[]): DocumentFragment {
  const node = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function replaceChildren(host: Element, child: Node): void {
  host.replaceChildren(child);
}

/**
 * Captures which control has focus and where the caret is, so a full re-render
 * does not throw the user out of the search box mid-word. Elements are matched
 * by `id`, which is why every focusable control in the panel has a stable one.
 */
export interface FocusSnapshot {
  readonly id: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

export function captureFocus(root: Document): FocusSnapshot | null {
  const active = root.activeElement;
  if (!(active instanceof HTMLElement) || active.id === '') return null;

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return {
      id: active.id,
      selectionStart: active.selectionStart,
      selectionEnd: active.selectionEnd,
    };
  }
  return { id: active.id, selectionStart: null, selectionEnd: null };
}

export function restoreFocus(root: Document, snapshot: FocusSnapshot | null): void {
  if (snapshot === null) return;
  const target = root.getElementById(snapshot.id);
  if (!(target instanceof HTMLElement)) return;

  target.focus();
  if (
    (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
    snapshot.selectionStart !== null
  ) {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
  }
}
