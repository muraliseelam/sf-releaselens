/**
 * @vitest-environment jsdom
 *
 * The DOM helper is 70 lines standing in for a framework, so the properties it
 * guarantees are worth pinning: text is never parsed as HTML, listeners belong
 * to the node that was created, and focus survives a full re-render.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { captureFocus, el, fragment, replaceChildren, restoreFocus } from '../../src/ui/dom.js';

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('el', () => {
  it('creates the requested element', () => {
    expect(el('button').tagName).toBe('BUTTON');
  });

  it('applies className, text and title', () => {
    const node = el('span', { className: 'chip chip--on', text: 'ApexClass', title: '12 matches' });

    expect(node.className).toBe('chip chip--on');
    expect(node.textContent).toBe('ApexClass');
    expect(node.title).toBe('12 matches');
  });

  it('sets arbitrary attributes, including ARIA and data', () => {
    const node = el('button', { attrs: { type: 'button', 'aria-pressed': 'true', id: 'tab-x' } });

    expect(node.getAttribute('type')).toBe('button');
    expect(node.getAttribute('aria-pressed')).toBe('true');
    expect(node.id).toBe('tab-x');
  });

  it('never parses text as HTML, whatever a component is called', () => {
    // A metadata full name or an approval comment is untrusted input that
    // reaches this function directly.
    const hostile = '<img src=x onerror="alert(1)">';
    const node = el('span', { text: hostile });

    expect(node.textContent).toBe(hostile);
    expect(node.querySelector('img')).toBeNull();
    expect(node.children).toHaveLength(0);
  });

  it('does not parse string children as HTML either', () => {
    const node = el('div', {}, ['<b>bold</b>']);

    expect(node.querySelector('b')).toBeNull();
    expect(node.textContent).toBe('<b>bold</b>');
  });

  it('attaches listeners to the node it created', () => {
    const onClick = vi.fn();
    const node = el('button', { on: { click: onClick } });

    node.click();

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('appends element and string children in order', () => {
    const node = el('p', {}, ['before ', el('strong', { text: 'middle' }), ' after']);

    expect(node.textContent).toBe('before middle after');
    expect(node.querySelector('strong')?.textContent).toBe('middle');
  });

  it('skips null, undefined and false children, so views can inline conditionals', () => {
    const node = el('div', {}, [null, undefined, false, el('span', { text: 'kept' })]);

    expect(node.childNodes).toHaveLength(1);
    expect(node.textContent).toBe('kept');
  });

  it('creates a bare element when given no options at all', () => {
    const node = el('div');

    expect(node.attributes).toHaveLength(0);
    expect(node.textContent).toBe('');
  });
});

describe('fragment', () => {
  it('collects children and applies the same skip rules', () => {
    const node = fragment([el('li', { text: 'a' }), null, 'text', false, undefined]);

    expect(node.childNodes).toHaveLength(2);
    expect(node.textContent).toBe('atext');
  });
});

describe('replaceChildren', () => {
  it('replaces everything already in the host', () => {
    const host = el('div', {}, [el('span', { text: 'old' })]);

    replaceChildren(host, el('span', { text: 'new' }));

    expect(host.childNodes).toHaveLength(1);
    expect(host.textContent).toBe('new');
  });
});

describe('captureFocus and restoreFocus', () => {
  it('restores focus and the caret position across a rebuild', () => {
    const input = el('input', { attrs: { id: 'inspector-search', type: 'search' } });
    input.value = 'invoice builder';
    document.body.append(input);
    input.focus();
    input.setSelectionRange(7, 7);

    const snapshot = captureFocus(document);
    expect(snapshot).toEqual({ id: 'inspector-search', selectionStart: 7, selectionEnd: 7 });

    // A full re-render: the old node is gone and a new one takes its place.
    const rebuilt = el('input', { attrs: { id: 'inspector-search', type: 'search' } });
    rebuilt.value = 'invoice builder';
    document.body.replaceChildren(rebuilt);
    restoreFocus(document, snapshot);

    expect(document.activeElement).toBe(rebuilt);
    expect(rebuilt.selectionStart).toBe(7);
    expect(rebuilt.selectionEnd).toBe(7);
  });

  it('preserves a selected range, not just a caret', () => {
    const area = el('textarea', { attrs: { id: 'comment-apr-1' } });
    area.value = 'no rollback plan';
    document.body.append(area);
    area.focus();
    area.setSelectionRange(3, 11);

    expect(captureFocus(document)).toEqual({
      id: 'comment-apr-1',
      selectionStart: 3,
      selectionEnd: 11,
    });
  });

  it('captures a focused non-text control without caret information', () => {
    const button = el('button', { attrs: { id: 'tab-approvals' } });
    document.body.append(button);
    button.focus();

    expect(captureFocus(document)).toEqual({
      id: 'tab-approvals',
      selectionStart: null,
      selectionEnd: null,
    });
  });

  it('captures nothing when the focused element has no id to find it by again', () => {
    const anonymous = el('input');
    document.body.append(anonymous);
    anonymous.focus();

    expect(captureFocus(document)).toBeNull();
  });

  it('captures nothing when focus is on the body', () => {
    expect(captureFocus(document)).toBeNull();
  });

  it('restoring a null snapshot is a no-op rather than an error', () => {
    expect(() => restoreFocus(document, null)).not.toThrow();
  });

  it('restoring an id the rebuild dropped is a no-op rather than an error', () => {
    // The search box disappears when the panel switches to the error state.
    expect(() =>
      restoreFocus(document, { id: 'gone', selectionStart: 1, selectionEnd: 1 }),
    ).not.toThrow();
    expect(document.activeElement).toBe(document.body);
  });

  it('restores focus to a control that cannot take a caret', () => {
    const button = el('button', { attrs: { id: 'tab-approvals' } });
    document.body.append(button);

    restoreFocus(document, { id: 'tab-approvals', selectionStart: null, selectionEnd: null });

    expect(document.activeElement).toBe(button);
  });
});
